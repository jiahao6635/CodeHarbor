import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAccessKey } from '../auth.js';
import { canManageRepository } from '../authorization.js';
import type { AppContext } from '../http/context.js';
import { fail } from '../http/errors.js';
import {
  assertActiveWrite,
  assertCurrentBrowser,
  assertCurrentPat,
  authenticateBrowserHook,
  authenticateHook,
  principalOf,
  requireBoundPat,
  requireWriteHook,
} from '../http/guards.js';
import { expiresIn, identifier, keyPrefix, parseBody, parseParams, scope } from '../http/validation.js';
import { publicKey } from '../http/views.js';

const prefixParams = z.object({ prefix: keyPrefix });
const createBody = z.strictObject({
  scope,
  repos: z.union([z.null(), z.array(identifier).max(100)]).optional(),
  expires_in: expiresIn.optional(),
});

export function registerKeyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, authorization } = ctx;
  const authenticate = authenticateHook(ctx);

  if (authorization.enforceFeishu) {
    const browser = { onRequest: authenticateBrowserHook(ctx) };
    app.get('/api/v1/api-keys', browser, async (request) => {
      const account = await assertCurrentBrowser(ctx, request);
      const keys = account.codeup_user_id ? await store.listKeys(account.codeup_user_id) : [];
      await assertCurrentBrowser(ctx, request);
      // The owner can manage their key history. Legacy scopes appear only after review.
      return { keys: keys.map((key) => publicKey(key.legacy_pending ? { ...key, repos: [] } : key)) };
    });

    app.post('/api/v1/api-keys', browser, async (request, reply) => {
      const account = await assertCurrentBrowser(ctx, request);
      const user = await requireBoundPat(ctx, account);
      const { repos, scope: keyScope, expires_in } = parseBody(createBody, request.body);
      if (!repos?.length || new Set(repos).size !== repos.length) fail(400, 'REPOSITORY_SCOPE_REQUIRED');
      const candidates = await store.getRepositoriesByIds(repos);
      if (candidates.length !== repos.length) fail(404, 'NOT_FOUND');
      for (const repo of candidates) {
        if (
          repo.status === 'disabled' ||
          repo.status === 'branch_deleted' ||
          (keyScope === 'write' && !canManageRepository(user.id, repo)) ||
          !(await authorization.checkCloudAccess(user, repo, true))
        )
          fail(404, 'NOT_FOUND');
      }
      const seconds = expires_in === undefined ? 30 * 86_400 : expires_in;
      const expiry = seconds === null ? null : Date.now() + seconds * 1000;
      return await authorization.mutate(async () => {
        await assertCurrentPat(ctx, request, user);
        const latestRepos = await store.getRepositoriesByIds(repos);
        if (
          latestRepos.length !== repos.length ||
          latestRepos.some(
            (latest) =>
              latest.status === 'disabled' ||
              latest.status === 'branch_deleted' ||
              (keyScope === 'write' && !canManageRepository(user.id, latest)) ||
              !authorization.hasFreshCloudAccess(user, latest, true),
          )
        )
          fail(404, 'NOT_FOUND');
        const next = createAccessKey();
        await store.createKey({ ...next, owner: user.id, scope: keyScope, repos, expires_at: expiry, revoked: 0 });
        return reply.code(201).send({
          token: next.token,
          prefix: next.prefix,
          scope: keyScope,
          repos,
          expires_at: expiry,
        });
      });
    });

    app.delete<{ Params: { prefix: string } }>('/api/v1/api-keys/:prefix', browser, async (request) => {
      const { prefix } = parseParams(prefixParams, request.params);
      return await authorization.mutate(async () => {
        const account = await assertCurrentBrowser(ctx, request);
        if (!account.codeup_user_id) fail(404, 'NOT_FOUND');
        const matches = (await store.getKeysByPrefix(prefix)).filter((key) => key.owner === account.codeup_user_id);
        if (!matches.length) fail(404, 'NOT_FOUND');
        if (matches.length > 1) fail(409, 'CONFLICT');
        await store.revokeKey(matches[0].hash);
        return { revoked: true };
      });
    });
    return;
  }

  app.get('/api/v1/api-keys', { onRequest: authenticate }, async (request) => {
    const key = principalOf(request);
    const keys = key.repos === null ? await store.listKeys(key.owner) : [key];
    return { keys: keys.map(publicKey) };
  });

  app.post('/api/v1/api-keys', { onRequest: [authenticate, requireWriteHook(ctx)] }, async (request, reply) => {
    const key = principalOf(request);
    const input = parseBody(createBody, request.body);
    await assertActiveWrite(ctx, request);
    const repos = input.repos ?? null;
    if (input.scope === 'read' && repos === null) fail(400, 'REPOSITORY_SCOPE_REQUIRED');
    // A restricted key can only mint keys within its own repository set.
    if (key.repos !== null && (repos === null || repos.some((id) => !key.repos?.includes(id)))) fail(403, 'FORBIDDEN');
    const seconds = input.expires_in === undefined ? 30 * 86_400 : input.expires_in;
    const expiry = seconds === null ? null : Date.now() + seconds * 1000;
    if (key.expires_at !== null && (expiry === null || expiry > key.expires_at)) fail(403, 'FORBIDDEN');
    return authorization.mutate(async () => {
      await assertActiveWrite(ctx, request);
      const next = createAccessKey();
      await store.createKey({ ...next, owner: key.owner, scope: input.scope, repos, expires_at: expiry, revoked: 0 });
      return reply
        .code(201)
        .send({ token: next.token, prefix: next.prefix, scope: input.scope, repos, expires_at: expiry });
    });
  });

  app.delete<{ Params: { prefix: string } }>(
    '/api/v1/api-keys/:prefix',
    { onRequest: authenticate },
    async (request) => {
      const key = principalOf(request);
      const { prefix } = parseParams(prefixParams, request.params);
      return authorization.mutate(async () => {
        await assertActiveWrite(ctx, request);
        const target = (await store.listKeys(key.owner)).find((candidate) => candidate.prefix === prefix);
        if (!target || (key.repos !== null && target.hash !== key.hash)) fail(404, 'NOT_FOUND');
        await store.revokeKey(target.hash);
        return { revoked: true };
      });
    },
  );
}
