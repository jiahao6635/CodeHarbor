import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../http/context.js';
import { fail } from '../http/errors.js';
import { assertActiveWrite, authenticateHook, requireAdminHook } from '../http/guards.js';
import {
  identifier,
  keyPrefix,
  parseParams,
  parseQuery,
  positivePage,
  singleQuery,
  userId,
} from '../http/validation.js';
import { publicKey } from '../http/views.js';

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

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, authorization } = ctx;
  const admin = { onRequest: [authenticateHook(ctx), requireAdminHook(ctx)] };

  app.get('/api/v1/admin/users', admin, async (request) => {
    await assertActiveWrite(ctx, request);
    return { users: await store.listUsers() };
  });

  app.get('/api/v1/admin/api-keys', admin, async (request) => {
    await assertActiveWrite(ctx, request);
    const { owner, page } = parseQuery(keysQuery, request.query);
    const keys = await store.listAllKeys(owner, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    return {
      keys: keys.map((key) => ({ ...publicKey(key), owner: key.owner })),
      next_page: keys.length === PAGE_SIZE ? page + 1 : null,
    };
  });

  app.delete<{ Params: { prefix: string } }>('/api/v1/admin/api-keys/:prefix', admin, async (request) => {
    await assertActiveWrite(ctx, request);
    const { prefix } = parseParams(prefixParams, request.params);
    return authorization.mutate(async () => {
      await assertActiveWrite(ctx, request);
      const matches = await store.getKeysByPrefix(prefix);
      if (matches.length === 0) fail(404, 'NOT_FOUND');
      if (matches.length > 1) fail(409, 'CONFLICT');
      await store.revokeKey(matches[0].hash);
      return { revoked: true, owner: matches[0].owner, prefix: matches[0].prefix };
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/admin/users/:id/revoke-keys', admin, async (request) => {
    await assertActiveWrite(ctx, request);
    const { id } = parseParams(userParams, request.params);
    return authorization.mutate(async () => {
      await assertActiveWrite(ctx, request);
      if (!(await store.getUser(id))) fail(404, 'NOT_FOUND');
      await store.revokeUserKeys(id);
      return { revoked: true, user: id };
    });
  });

  app.get('/api/v1/admin/audit', admin, async (request) => {
    await assertActiveWrite(ctx, request);
    const { subject, repo_id, since, limit } = parseQuery(auditQuery, request.query);
    return { events: await store.listAuditEvents({ subject, repo_id, since, limit }) };
  });
}
