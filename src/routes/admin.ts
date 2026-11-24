import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../http/context.js';
import { fail } from '../http/errors.js';
import {
  assertActiveWrite,
  assertSuperAdmin,
  authenticateHook,
  authenticateSuperAdminHook,
  requireAdminHook,
} from '../http/guards.js';
import {
  identifier,
  keyPrefix,
  parseBody,
  parseParams,
  parseQuery,
  positivePage,
  singleQuery,
  userId,
} from '../http/validation.js';
import { adminRepository, publicKey } from '../http/views.js';
import type { AccountRecord, AccountUpdate, StoreAccess } from '../store.js';

const PAGE_SIZE = 100;

const keysQuery = z.object({
  owner: singleQuery(userId).optional(),
  page: singleQuery(positivePage.max(100_000)).default(1),
});
const auditQuery = z.object({
  subject: singleQuery(userId).optional(),
  repo_id: singleQuery(identifier).optional(),
  since: singleQuery(
    z
      .string()
      .regex(/^\d{1,16}$/)
      .transform(Number),
  ).optional(),
  limit: singleQuery(z.coerce.number().int().min(1).max(1000)).default(100),
});
const prefixParams = z.object({ prefix: keyPrefix });
const userParams = z.object({ id: userId });
const accountPatch = z
  .strictObject({
    role: z.enum(['member', 'super_admin']).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .refine((patch) => patch.role !== undefined || patch.status !== undefined);

function accountView({ id, name, role, status, codeup_user_id }: AccountRecord) {
  return { id, name, username: name, role, status, codeup_user_id, has_pat: codeup_user_id !== null };
}

async function applyAccountPatch(tx: StoreAccess, account: AccountRecord, patch: AccountUpdate) {
  const { id, codeup_user_id: codeupId } = account;
  const remainsSuper = patch.role !== 'member' && patch.status !== 'disabled';
  if (!remainsSuper && account.role === 'super_admin' && account.status === 'active') {
    const administrators = (await tx.listAccounts()).filter(
      (entry) => entry.role === 'super_admin' && entry.status === 'active',
    );
    if (administrators.length === 1) fail(409, 'LAST_SUPER_ADMIN');
  }
  await tx.updateAccount(id, patch);
  if (patch.status === 'disabled') {
    await tx.deleteAccountSessions(id);
    if (codeupId) await tx.revokeUserKeys(codeupId);
  }
  return { user: accountView({ ...account, ...patch }) };
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, authorization } = ctx;
  const feishu = authorization.enforceFeishu;
  const admin = {
    onRequest: feishu ? authenticateSuperAdminHook(ctx) : [authenticateHook(ctx), requireAdminHook(ctx)],
  };
  const assertAdmin = (request: Parameters<typeof assertSuperAdmin>[1]) =>
    feishu ? assertSuperAdmin(ctx, request) : assertActiveWrite(ctx, request);

  app.get('/api/v1/admin/users', admin, async (request) => {
    await assertAdmin(request);
    return { users: feishu ? (await store.listAccounts()).map(accountView) : await store.listUsers() };
  });

  /** Every repository including disabled ones, which the user-facing list hides. */
  app.get('/api/v1/admin/repositories', admin, async (request) => {
    await assertAdmin(request);
    const repositories = await store.listRepositories();
    return { repositories: repositories.map((repo) => adminRepository(repo, ctx.defaultSyncIntervalMinutes)) };
  });

  app.get('/api/v1/admin/api-keys', admin, async (request) => {
    await assertAdmin(request);
    const { owner, page } = parseQuery(keysQuery, request.query);
    const keys = await store.listAllKeys(owner, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    const linkedUsers = feishu
      ? new Set(
          (await store.listAccounts())
            .filter((account) => account.status === 'active')
            .map((account) => account.codeup_user_id),
        )
      : new Set<string>();
    return {
      keys: keys.map((key) => ({
        ...publicKey(key),
        owner: key.owner,
        ...(feishu
          ? {
              legacy_approvable:
                !!key.legacy_pending &&
                !key.revoked &&
                !!key.repos?.length &&
                (key.expires_at === null || key.expires_at > Date.now()) &&
                linkedUsers.has(key.owner),
            }
          : {}),
      })),
      next_page: keys.length === PAGE_SIZE ? page + 1 : null,
    };
  });

  if (feishu) {
    app.patch<{ Params: { id: string } }>('/api/v1/admin/users/:id', admin, async (request) => {
      const { id } = parseParams(userParams, request.params);
      const patch = parseBody(accountPatch, request.body);
      return authorization.mutate(() =>
        store.transaction(async (tx) => {
          await assertSuperAdmin(ctx, request, tx);
          const account = await tx.getAccount(id);
          if (!account) fail(404, 'NOT_FOUND');
          return applyAccountPatch(tx, account, patch);
        }),
      );
    });

    app.post<{ Params: { prefix: string } }>('/api/v1/admin/api-keys/:prefix/approve', admin, async (request) => {
      const { prefix } = parseParams(prefixParams, request.params);
      return authorization.mutate(async () => {
        await assertSuperAdmin(ctx, request);
        const matches = await store.getKeysByPrefix(prefix);
        if (!matches.length) fail(404, 'NOT_FOUND');
        if (matches.length > 1) fail(409, 'CONFLICT');
        const [key] = matches;
        if (key.revoked || !key.repos?.length || (key.expires_at !== null && key.expires_at <= Date.now())) {
          fail(409, 'LEGACY_KEY_INELIGIBLE');
        }
        const account = await store.getAccountByCodeupId(key.owner);
        if (account?.status !== 'active' || !(await store.getUser(key.owner))) fail(409, 'LEGACY_KEY_INELIGIBLE');
        if (key.legacy_pending) await store.approveLegacyKey(key.hash);
        request.actor = { ...request.actor, key_prefix: prefix };
        return { approved: true, owner: key.owner, prefix };
      });
    });
  }

  app.delete<{ Params: { prefix: string } }>('/api/v1/admin/api-keys/:prefix', admin, async (request) => {
    const { prefix } = parseParams(prefixParams, request.params);
    return authorization.mutate(async () => {
      await assertAdmin(request);
      const matches = await store.getKeysByPrefix(prefix);
      if (matches.length === 0) fail(404, 'NOT_FOUND');
      if (matches.length > 1) fail(409, 'CONFLICT');
      await store.revokeKey(matches[0].hash);
      request.actor = { ...request.actor, key_prefix: prefix };
      return { revoked: true, owner: matches[0].owner, prefix: matches[0].prefix };
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/admin/users/:id/revoke-keys', admin, async (request) => {
    await assertAdmin(request);
    const { id } = parseParams(userParams, request.params);
    return authorization.mutate(async () => {
      await assertAdmin(request);
      if (feishu) {
        const account = await store.getAccount(id);
        if (!account) fail(404, 'NOT_FOUND');
        if (account.codeup_user_id) await store.revokeUserKeys(account.codeup_user_id);
      } else {
        if (!(await store.getUser(id))) fail(404, 'NOT_FOUND');
        await store.revokeUserKeys(id);
      }
      return { revoked: true, user: id };
    });
  });

  app.get('/api/v1/admin/audit', admin, async (request) => {
    await assertAdmin(request);
    const { subject, repo_id, since, limit } = parseQuery(auditQuery, request.query);
    return { events: await store.listAuditEvents({ subject, repo_id, since, limit }) };
  });
}
