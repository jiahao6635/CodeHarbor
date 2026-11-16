import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAccessKey } from '../auth.js';
import { hasRepositoryRole } from '../codeup.js';
import type { AppContext } from '../http/context.js';
import { fail } from '../http/errors.js';
import {
  assertActiveWrite,
  authenticateHook,
  principalOf,
  requireAdminHook,
  requireWriteHook,
} from '../http/guards.js';
import { identifier, parseBody, parseParams, parseQuery, positivePage, singleQuery, text } from '../http/validation.js';
import { publicRepository } from '../http/views.js';
import type { RepositoryRecord } from '../store.js';

const idParams = z.object({ id: identifier });
const pageQuery = z.object({ page: singleQuery(positivePage).default(1) });
const JOB_HISTORY_LIMIT = 50;

const GIT_REF_FORBIDDEN = /[ ~^:?*[]/;
const branchName = text(255).refine(
  (value) =>
    !value.startsWith('-') &&
    !value.includes('..') &&
    !value.includes('\\') &&
    !value.includes('@{') &&
    !GIT_REF_FORBIDDEN.test(value),
);
const createBody = z.strictObject({
  codeup_repository_id: z
    .union([z.string(), z.number().int()])
    .transform(String)
    .pipe(z.string().regex(/^\d{1,30}$/)),
  branch: branchName.default('main'),
  authorize_automatic_sync: z.literal(true),
});
const syncCredentialBody = z.strictObject({ authorize_automatic_sync: z.literal(true) });

export function registerRepositoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, codeup, cipher, worker, authorization } = ctx;
  const authenticate = authenticateHook(ctx);

  async function ownerOf(request: Parameters<typeof principalOf>[0]) {
    const user = await store.getUser(principalOf(request).owner);
    if (!user) fail(401, 'UNAUTHENTICATED');
    return user;
  }

  app.get('/api/v1/me', { onRequest: authenticate }, async (request) => {
    const key = principalOf(request);
    const user = await ownerOf(request);
    return {
      id: user.id,
      username: user.username,
      key_scope: key.scope,
      key_prefix: key.prefix,
      key_repos: key.repos,
      key_expires_at: key.expires_at,
      can_write: authorization.isWrite(key),
      is_admin: authorization.isAdmin(key),
    };
  });

  app.get('/api/v1/codeup/repositories', { onRequest: authenticate }, async (request) => {
    const key = principalOf(request);
    if (key.repos !== null) fail(403, 'FORBIDDEN');
    const user = await ownerOf(request);
    const { page } = parseQuery(pageQuery, request.query);
    const result = await codeup.listRepositories(cipher.decrypt(user.credential, user.id), page, 100);
    return authorization.mutate(async () => {
      const currentKey = await store.getKey(key.hash);
      const currentUser = await store.getUser(user.id);
      if (
        currentUser?.credential_version !== user.credential_version ||
        !currentKey ||
        currentKey.revoked ||
        (currentKey.expires_at !== null && currentKey.expires_at <= Date.now())
      ) {
        fail(401, 'UNAUTHENTICATED');
      }
      return {
        repositories: result.repositories.map(({ id, name, path, accessLevel }) => ({
          id,
          name,
          path,
          access_level: accessLevel,
        })),
        next_page: result.nextPage,
      };
    });
  });

  app.get('/api/v1/repositories', { onRequest: authenticate }, async (request) => ({
    repositories: (await authorization.listVisible(principalOf(request))).map(publicRepository),
  }));

  app.post('/api/v1/repositories', { onRequest: [authenticate, requireWriteHook(ctx)] }, async (request, reply) => {
    const key = principalOf(request);
    const input = parseBody(createBody, request.body);
    await assertActiveWrite(ctx, request);
    const user = await ownerOf(request);
    const pat = cipher.decrypt(user.credential, user.id);
    const remote = await codeup.getRepository(pat, input.codeup_repository_id);
    const cloneable =
      hasRepositoryRole(remote) &&
      !!remote.httpUrlToRepo &&
      (await ctx.probe({
        dataDir: ctx.config.dataDir,
        repositoryId: input.codeup_repository_id,
        branch: remote.defaultBranch ?? input.branch,
        cloneUrl: remote.httpUrlToRepo,
        allowedGitHosts: ctx.config.allowedGitHosts,
        gitUsername: user.username,
        token: pat,
      }));
    if (!cloneable) fail(404, 'NOT_FOUND');
    return authorization.mutate(async () => {
      await assertActiveWrite(ctx, request);
      const exists = await store.getRepositoryByCodeupId(input.codeup_repository_id);
      if (exists) {
        if (!authorization.keyAllows(key, exists) || exists.status === 'disabled') fail(404, 'NOT_FOUND');
        return reply.code(200).send({ repository: publicRepository(exists) });
      }
      if (key.repos !== null) fail(403, 'FORBIDDEN');
      const id = randomUUID();
      const hookToken = createAccessKey();
      const repo: RepositoryRecord = {
        id,
        codeup_id: input.codeup_repository_id,
        name: remote.name,
        branch: input.branch,
        owner: user.id,
        sync_owner: user.id,
        sync_credential_version: user.credential_version,
        hook_hash: hookToken.hash,
        path: null,
        commit: null,
        previous_image: null,
        previous_commit: null,
        indexed_at: null,
        status: 'pending',
        error: null,
      };
      const jobId = randomUUID();
      await store.transaction(async (tx) => {
        await tx.createRepository(repo);
        await tx.createJob({
          id: jobId,
          repo_id: id,
          status: 'queued',
          reason: 'initial',
          created_at: Date.now(),
          error: null,
        });
      });
      request.actor = { ...request.actor, repo_id: id };
      worker.kick();
      return reply.code(202).send({
        repository: publicRepository(repo),
        job_id: jobId,
        webhook_token: hookToken.token,
        webhook_path: `/api/v1/hooks/codeup/${id}`,
      });
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/repositories/:id', { onRequest: authenticate }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const repo = await authorization.visible(principalOf(request), id);
    request.actor = { ...request.actor, repo_id: repo.id };
    return publicRepository(repo);
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/repositories/:id/sync',
    { onRequest: authenticate },
    async (request, reply) => {
      const { id } = parseParams(idParams, request.params);
      const repo = await authorization.visible(principalOf(request), id);
      request.actor = { ...request.actor, repo_id: repo.id };
      return authorization.mutate(async () => {
        await assertActiveWrite(ctx, request);
        const job = await worker.enqueue(repo.id, 'manual');
        return reply.code(202).send({ job_id: job.id });
      });
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/v1/repositories/:id/sync-credential',
    { onRequest: authenticate },
    async (request, reply) => {
      const key = principalOf(request);
      const { id } = parseParams(idParams, request.params);
      const repo = await authorization.visible(key, id);
      request.actor = { ...request.actor, repo_id: repo.id };
      authorization.requireWrite(key);
      if (repo.owner !== key.owner && repo.sync_owner !== key.owner) fail(404, 'NOT_FOUND');
      parseBody(syncCredentialBody, request.body);
      return authorization.mutate(async () => {
        await assertActiveWrite(ctx, request);
        const latest = await store.getRepository(repo.id);
        if (!latest || (latest.owner !== key.owner && latest.sync_owner !== key.owner)) fail(404, 'NOT_FOUND');
        const user = await ownerOf(request);
        await store.updateRepository(repo.id, {
          sync_owner: user.id,
          sync_credential_version: user.credential_version,
        });
        const job = await worker.enqueue(repo.id, 'credential_changed');
        return reply.code(202).send({ job_id: job.id });
      });
    },
  );

  const lifecycleHooks = { onRequest: [authenticate, requireAdminHook(ctx)] };

  app.post<{ Params: { id: string } }>('/api/v1/repositories/:id/disable', lifecycleHooks, async (request) => {
    const { id } = parseParams(idParams, request.params);
    await assertActiveWrite(ctx, request);
    return authorization.mutate(async () => {
      await assertActiveWrite(ctx, request);
      const repo = await store.getRepository(id);
      if (!repo) fail(404, 'NOT_FOUND');
      request.actor = { ...request.actor, repo_id: repo.id };
      if (repo.status !== 'disabled') {
        await store.updateRepository(repo.id, { status: 'disabled', error: 'DISABLED_BY_ADMIN' });
      }
      const updated = await store.getRepository(repo.id);
      if (!updated) fail(404, 'NOT_FOUND');
      return { repository: publicRepository(updated) };
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/repositories/:id/enable', lifecycleHooks, async (request, reply) => {
    const { id } = parseParams(idParams, request.params);
    await assertActiveWrite(ctx, request);
    return authorization.mutate(async () => {
      await assertActiveWrite(ctx, request);
      const repo = await store.getRepository(id);
      if (!repo) fail(404, 'NOT_FOUND');
      request.actor = { ...request.actor, repo_id: repo.id };
      if (repo.status !== 'disabled') fail(409, 'CONFLICT');
      await store.updateRepository(repo.id, { status: repo.path ? 'updating' : 'pending', error: null });
      const job = await worker.enqueue(repo.id, 'manual');
      const updated = await store.getRepository(repo.id);
      if (!updated) fail(404, 'NOT_FOUND');
      return reply.code(202).send({ repository: publicRepository(updated), job_id: job.id });
    });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/repositories/:id', lifecycleHooks, async (request) => {
    const { id } = parseParams(idParams, request.params);
    await assertActiveWrite(ctx, request);
    return authorization.mutate(async () => {
      await assertActiveWrite(ctx, request);
      const repo = await store.getRepository(id);
      if (!repo) fail(404, 'NOT_FOUND');
      request.actor = { ...request.actor, repo_id: repo.id };
      if (repo.status !== 'disabled') fail(409, 'CONFLICT');
      await store.deleteRepository(repo.id);
      return { deleted: true };
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/repositories/:id/jobs', { onRequest: authenticate }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const repo = await authorization.visible(principalOf(request), id);
    request.actor = { ...request.actor, repo_id: repo.id };
    const jobs = await store.listJobs(repo.id);
    // Newest first; the store returns creation order.
    return { jobs: jobs.slice(-JOB_HISTORY_LIMIT).reverse() };
  });

  app.get<{ Params: { id: string } }>('/api/v1/jobs/:id', { onRequest: authenticate }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const job = await store.getJob(id);
    if (!job) fail(404, 'NOT_FOUND');
    const repo = await authorization.visible(principalOf(request), job.repo_id);
    request.actor = { ...request.actor, repo_id: repo.id };
    return job;
  });
}
