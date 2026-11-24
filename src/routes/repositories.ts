import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createAccessKey } from '../auth.js';
import type { Principal } from '../authorization.js';
import { canManageRepository, MAX_CODEUP_ACCESS_AGE_MS } from '../authorization.js';
import { CodeupError, hasRepositoryRole } from '../codeup.js';
import type { AppContext } from '../http/context.js';
import { fail } from '../http/errors.js';
import {
  assertActiveWrite,
  assertCurrentBrowser,
  assertCurrentPat,
  assertSuperAdmin,
  authenticateBrowserHook,
  authenticateHook,
  authenticateRepositoryHook,
  authenticateSuperAdminHook,
  principalOf,
  requireAdminHook,
  requireBoundPat,
  requireWriteHook,
} from '../http/guards.js';
import { identifier, parseBody, parseParams, parseQuery, positivePage, singleQuery, text } from '../http/validation.js';
import { publicRepository } from '../http/views.js';
import type { AccountRecord, RepositoryRecord, UserRecord } from '../store.js';

const idParams = z.object({ id: identifier });
const pageQuery = z.object({ page: singleQuery(positivePage).default(1) });
const repositoryListQuery = z.object({ for_key: singleQuery(z.literal('1')).optional() });
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
  branch: branchName.optional(),
  authorize_automatic_sync: z.literal(true),
});
const syncCredentialBody = z.strictObject({ authorize_automatic_sync: z.literal(true) });

export function registerRepositoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, codeup, cipher, worker, authorization } = ctx;
  const feishu = authorization.enforceFeishu;
  const authenticate = authenticateRepositoryHook(ctx);
  const browser = feishu ? authenticateBrowserHook(ctx) : authenticateHook(ctx);

  async function ownerOf(request: Parameters<typeof principalOf>[0]) {
    const user = await store.getUser(principalOf(request).owner);
    if (!user) fail(401, 'UNAUTHENTICATED');
    return user;
  }

  async function browserRepository(
    request: Parameters<typeof principalOf>[0],
    id: string,
    requireCodeup = false,
  ): Promise<RepositoryRecord> {
    const [account, repo] = await Promise.all([assertCurrentBrowser(ctx, request), store.getRepository(id)]);
    if (!repo) fail(404, 'NOT_FOUND');
    if (account.role === 'super_admin' && !requireCodeup) return repo;
    if (repo.status === 'disabled' || !account.codeup_user_id) fail(404, 'NOT_FOUND');
    const user = await requireBoundPat(ctx, account);
    if (!(await authorization.checkCloudAccess(user, repo, false))) fail(404, 'NOT_FOUND');
    return await authorization.mutate(async () => {
      await assertCurrentPat(ctx, request, user);
      const latest = await store.getRepository(id);
      if (!latest || latest.status === 'disabled' || !authorization.hasFreshCloudAccess(user, latest, false))
        fail(404, 'NOT_FOUND');
      return latest;
    });
  }

  const getVisible = (request: Parameters<typeof principalOf>[0], id: string) =>
    request.browserSession ? browserRepository(request, id) : authorization.visible(principalOf(request), id);

  function view(repo: RepositoryRecord, account?: AccountRecord) {
    if (!account) return publicRepository(repo);
    const canManage =
      !!account.codeup_user_id && repo.status !== 'disabled' && canManageRepository(account.codeup_user_id, repo);
    return { ...publicRepository(repo), can_manage: canManage, can_authorize_sync: canManage };
  }

  app.get('/api/v1/me', { onRequest: authenticate }, async (request) => {
    if (request.browserSession) {
      const account = await assertCurrentBrowser(ctx, request);
      return {
        id: account.id,
        username: account.name,
        role: account.role,
        has_pat: account.codeup_user_id !== null,
        key_scope: null,
        key_prefix: null,
        key_repos: null,
        key_expires_at: null,
        can_write: account.codeup_user_id !== null,
        is_admin: account.role === 'super_admin',
      };
    }
    const key = principalOf(request);
    const user = await ownerOf(request);
    const effectiveRepos = feishu ? await authorization.listVisible(key) : undefined;
    return {
      id: user.id,
      username: user.username,
      key_scope: key.scope,
      key_prefix: key.prefix,
      key_repos: effectiveRepos?.map((repo) => repo.id) ?? key.repos,
      key_expires_at: key.expires_at,
      can_write:
        authorization.isWrite(key) &&
        (!effectiveRepos || effectiveRepos.some((repo) => canManageRepository(user.id, repo))),
      is_admin: authorization.isAdmin(key),
    };
  });

  async function checkImportBranch(pat: string, codeupId: string, branch: string) {
    try {
      await codeup.getBranch(pat, codeupId, branch);
    } catch (error) {
      if (!(error instanceof CodeupError)) throw error;
      if (error.kind === 'not_found') fail(404, 'BRANCH_NOT_FOUND');
      if (error.kind === 'invalid_credential') fail(409, 'PAT_INVALID');
      if (error.kind === 'forbidden') fail(403, 'CODEUP_BRANCH_SCOPE_REQUIRED');
      throw error;
    }
  }

  app.get('/api/v1/codeup/repositories', { onRequest: browser }, async (request) => {
    const account = request.browserSession && (await assertCurrentBrowser(ctx, request));
    const key = account ? undefined : principalOf(request);
    if (key && key.repos !== null) fail(403, 'FORBIDDEN');
    const user = account ? await requireBoundPat(ctx, account) : await ownerOf(request);
    const { page } = parseQuery(pageQuery, request.query);
    const result = await listCodeup(user, page);
    return authorization.mutate(async () => {
      if (key) {
        const currentKey = await store.getKey(key.hash);
        const currentUser = await store.getUser(user.id);
        if (
          currentUser?.credential_version !== user.credential_version ||
          !currentKey ||
          !(await authorization.isActiveKey(currentKey))
        )
          fail(401, 'UNAUTHENTICATED');
      } else {
        await assertCurrentPat(ctx, request, user);
      }
      return {
        repositories: result.repositories
          .filter((remote) => !feishu || hasRepositoryRole(remote))
          .map(({ id, name, path, accessLevel }) => ({ id, name, path, access_level: accessLevel })),
        next_page: result.nextPage,
      };
    });
  });

  async function listCodeup(user: UserRecord, page: number) {
    try {
      return await codeup.listRepositories(cipher.decrypt(user.credential, user.id), page, 100);
    } catch (error) {
      if (feishu && error instanceof CodeupError && error.kind === 'invalid_credential') fail(409, 'PAT_INVALID');
      throw error;
    }
  }

  async function allowedCodeupIds(user: UserRecord, candidates: Set<string>): Promise<Set<string>> {
    const allowed = new Set<string>();
    let page: number | null = 1;
    try {
      while (page !== null && candidates.size > 0) {
        if (page > 150) fail(503, 'CODEUP_UNAVAILABLE');
        const result = await listCodeup(user, page);
        for (const remote of result.repositories) {
          if (hasRepositoryRole(remote) && candidates.delete(remote.id)) allowed.add(remote.id);
        }
        page = result.nextPage;
      }
    } catch (error) {
      if (error instanceof CodeupError && error.kind === 'forbidden') return new Set();
      throw error;
    }
    return allowed;
  }

  app.get('/api/v1/repositories', { onRequest: authenticate }, async (request) => {
    if (!request.browserSession) {
      return { repositories: (await authorization.listVisible(principalOf(request))).map(publicRepository) };
    }
    const { for_key: forKey } = parseQuery(repositoryListQuery, request.query);
    const account = await assertCurrentBrowser(ctx, request);
    const repositories = await store.listRepositories();
    if (account.role === 'super_admin' && !forKey) {
      await assertSuperAdmin(ctx, request);
      return { repositories: repositories.map((repo) => view(repo, account)) };
    }
    const candidates = new Set(repositories.filter((repo) => repo.status !== 'disabled').map((repo) => repo.codeup_id));
    if (!account.codeup_user_id || !candidates.size) return { repositories: [] };
    const user = await requireBoundPat(ctx, account);
    const started = performance.now();
    const allowed = await allowedCodeupIds(user, candidates);
    return await authorization.mutate(async () => {
      await assertCurrentPat(ctx, request, user);
      const latest = await store.getRepositoriesByIds(
        repositories.filter((repo) => allowed.has(repo.codeup_id)).map((repo) => repo.id),
      );
      if (performance.now() - started >= MAX_CODEUP_ACCESS_AGE_MS) fail(503, 'CODEUP_UNAVAILABLE');
      return { repositories: latest.filter((repo) => repo.status !== 'disabled').map((repo) => view(repo, account)) };
    });
  });

  async function verifyImport(input: z.infer<typeof createBody>, user: UserRecord) {
    const started = performance.now();
    const pat = cipher.decrypt(user.credential, user.id);
    const remote = await codeup.getRepository(pat, input.codeup_repository_id).catch((error: unknown) => {
      if (feishu && error instanceof CodeupError && error.kind === 'invalid_credential') fail(409, 'PAT_INVALID');
      throw error;
    });
    if (!hasRepositoryRole(remote) || !remote.httpUrlToRepo) fail(404, 'NOT_FOUND');
    const branch = input.branch ?? (feishu ? remote.defaultBranch : 'main');
    if (!branch || !branchName.safeParse(branch).success) fail(404, 'BRANCH_NOT_FOUND');
    if (feishu) await checkImportBranch(pat, input.codeup_repository_id, branch);
    const cloneable = await ctx.probe({
      dataDir: ctx.config.dataDir,
      repositoryId: input.codeup_repository_id,
      branch: feishu ? branch : (remote.defaultBranch ?? branch),
      cloneUrl: remote.httpUrlToRepo,
      allowedGitHosts: ctx.config.allowedGitHosts,
      gitUsername: user.username,
      token: pat,
    });
    if (!cloneable) fail(404, 'NOT_FOUND');
    return { remote, branch, started };
  }

  function existingImport(
    reply: FastifyReply,
    existing: RepositoryRecord,
    branch: string,
    account?: AccountRecord,
    key?: Principal,
  ) {
    if (
      (key && !authorization.keyAllows(key, existing)) ||
      (existing.status === 'disabled' && account?.role !== 'super_admin')
    )
      fail(404, 'NOT_FOUND');
    const repository = view(existing, account);
    if (feishu && existing.branch !== branch) {
      return reply.code(409).send({ error: 'REPOSITORY_BRANCH_CONFLICT', repository });
    }
    return reply.code(200).send({ repository });
  }

  const createHooks = feishu ? browser : [authenticate, requireWriteHook(ctx)];
  app.post('/api/v1/repositories', { onRequest: createHooks }, async (request, reply) => {
    const input = parseBody(createBody, request.body);
    const account = request.browserSession && (await assertCurrentBrowser(ctx, request));
    const key = account ? undefined : await assertActiveWrite(ctx, request);
    const user = account ? await requireBoundPat(ctx, account) : await ownerOf(request);
    const { remote, branch, started } = await verifyImport(input, user);
    return authorization.mutate(async () => {
      const current = account ? await assertCurrentPat(ctx, request, user) : undefined;
      if (!current) await assertActiveWrite(ctx, request);
      const exists = await store.getRepositoryByCodeupId(input.codeup_repository_id);
      if (feishu && performance.now() - started >= MAX_CODEUP_ACCESS_AGE_MS) fail(503, 'AUTHORIZATION_UNAVAILABLE');
      if (exists) return existingImport(reply, exists, branch, current, key);
      if (key?.repos) fail(403, 'FORBIDDEN');
      const id = randomUUID();
      const hookToken = createAccessKey();
      const repo: RepositoryRecord = {
        id,
        codeup_id: input.codeup_repository_id,
        name: remote.name,
        branch,
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
        repository: view(repo, current),
        job_id: jobId,
        webhook_token: hookToken.token,
        webhook_path: `/api/v1/hooks/codeup/${id}`,
      });
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/repositories/:id', { onRequest: authenticate }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const repo = await getVisible(request, id);
    request.actor = { ...request.actor, repo_id: repo.id };
    return view(repo, request.browserSession?.account);
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/repositories/:id/sync',
    { onRequest: authenticate },
    async (request, reply) => {
      const { id } = parseParams(idParams, request.params);
      const account = request.browserSession && (await assertCurrentBrowser(ctx, request));
      const user = account ? await requireBoundPat(ctx, account) : await ownerOf(request);
      const repo = account ? await browserRepository(request, id, true) : await getVisible(request, id);
      request.actor = { ...request.actor, repo_id: repo.id };
      return authorization.mutate(async () => {
        if (account) {
          await assertCurrentPat(ctx, request, user);
        } else {
          const key = await assertActiveWrite(ctx, request);
          if (feishu && !key.repos?.includes(id)) fail(404, 'NOT_FOUND');
        }
        if (feishu) {
          const latest = await store.getRepository(id);
          if (
            !latest ||
            latest.status === 'disabled' ||
            !canManageRepository(user.id, latest) ||
            !authorization.hasFreshCloudAccess(user, latest, false)
          )
            fail(404, 'NOT_FOUND');
        }
        const job = await worker.enqueue(repo.id, 'manual');
        return reply.code(202).send({ job_id: job.id });
      });
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/v1/repositories/:id/sync-credential',
    { onRequest: browser },
    async (request, reply) => {
      const account = request.browserSession && (await assertCurrentBrowser(ctx, request));
      const user = account ? await requireBoundPat(ctx, account) : await ownerOf(request);
      const key = account ? undefined : principalOf(request);
      const { id } = parseParams(idParams, request.params);
      const repo = key ? await authorization.visible(key, id) : await browserRepository(request, id, true);
      request.actor = { ...request.actor, repo_id: repo.id };
      if (key) authorization.requireWrite(key);
      if (!canManageRepository(user.id, repo)) fail(404, 'NOT_FOUND');
      parseBody(syncCredentialBody, request.body);
      if (feishu && !(await authorization.checkCloudAccess(user, repo, true, undefined, true))) fail(404, 'NOT_FOUND');
      return authorization.mutate(async () => {
        if (account) await assertCurrentPat(ctx, request, user);
        else await assertActiveWrite(ctx, request);
        const latest = await store.getRepository(repo.id);
        if (
          !latest ||
          latest.status === 'disabled' ||
          latest.branch !== repo.branch ||
          !canManageRepository(user.id, latest) ||
          (feishu && !authorization.hasFreshCloudAccess(user, latest, true))
        )
          fail(404, 'NOT_FOUND');
        await store.updateRepository(repo.id, {
          sync_owner: user.id,
          sync_credential_version: user.credential_version,
        });
        const job = await worker.enqueue(repo.id, 'credential_changed');
        return reply.code(202).send({ job_id: job.id });
      });
    },
  );

  const lifecycleHooks = {
    onRequest: feishu ? authenticateSuperAdminHook(ctx) : [authenticate, requireAdminHook(ctx)],
  };
  const assertLifecycleAccess = (request: Parameters<typeof principalOf>[0]) =>
    feishu ? assertSuperAdmin(ctx, request) : assertActiveWrite(ctx, request);

  app.post<{ Params: { id: string } }>('/api/v1/repositories/:id/disable', lifecycleHooks, async (request) => {
    const { id } = parseParams(idParams, request.params);
    await assertLifecycleAccess(request);
    return authorization.mutate(async () => {
      await assertLifecycleAccess(request);
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
    await assertLifecycleAccess(request);
    return authorization.mutate(async () => {
      await assertLifecycleAccess(request);
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
    await assertLifecycleAccess(request);
    return authorization.mutate(async () => {
      await assertLifecycleAccess(request);
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
    const repo = await getVisible(request, id);
    request.actor = { ...request.actor, repo_id: repo.id };
    const jobs = await store.listJobs(repo.id);
    // Newest first; the store returns creation order.
    return { jobs: jobs.slice(-JOB_HISTORY_LIMIT).reverse() };
  });

  app.get<{ Params: { id: string } }>('/api/v1/jobs/:id', { onRequest: authenticate }, async (request) => {
    const { id } = parseParams(idParams, request.params);
    const job = await store.getJob(id);
    if (!job) fail(404, 'NOT_FOUND');
    const repo = await getVisible(request, job.repo_id);
    request.actor = { ...request.actor, repo_id: repo.id };
    return job;
  });
}
