import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { constantTimeEqual, createAccessKey, hashAccessKey } from '../auth.js';
import { bearerToken } from '../authorization.js';
import type { AppContext } from '../http/context.js';
import { fail } from '../http/errors.js';
import { expiresIn, parseBody, scope, text } from '../http/validation.js';

const bindBody = z.strictObject({ pat: text(4096) });
const bootstrapBody = z.strictObject({ scope, expires_in: expiresIn.optional() });

const BOOTSTRAP_TTL_MS = 300_000;

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, codeup, cipher, sessions, authorization } = ctx;

  app.post('/api/v1/auth/yunxiao/bind', {
    onRequest: async (request) => {
      if (!ctx.limiters.bind.hit(ctx.clientIp(request))) fail(429, 'RATE_LIMITED');
    },
    handler: async (request) => {
      const { pat } = parseBody(bindBody, request.body);
      const user = await codeup.getUser(pat);
      // Check the configured Codeup organization and required repository-list scope.
      await codeup.listRepositories(pat, 1, 1);
      request.actor = { subject: user.id, authentication: 'yunxiao_pat' };
      const encrypted = cipher.encrypt(pat, user.id);
      return authorization.mutate(async () => {
        await store.transaction(async (tx) => {
          const existing = await tx.getUser(user.id);
          if (!existing) {
            await tx.createUser({ id: user.id, username: user.username, credential: encrypted, credential_version: 1 });
            return;
          }
          let sameCredential = false;
          try {
            // Ciphertexts use random IVs; compare decrypted values only after live Codeup validation.
            sameCredential = constantTimeEqual(cipher.decrypt(existing.credential, user.id), pat);
          } catch {
            // A verified PAT can repair an unreadable credential, but must require fresh sync authorization.
          }
          if (sameCredential) return;
          await tx.updateUserCredential(user.id, user.username, encrypted);
          for (const repo of await tx.listRepositories()) {
            if (repo.sync_owner === user.id && repo.status !== 'disabled' && repo.status !== 'branch_deleted') {
              await tx.updateRepository(repo.id, {
                status: 'credential_required',
                error: 'SYNC_AUTHORIZATION_REQUIRED',
              });
            }
          }
        });
        const now = Date.now();
        for (const [hash, session] of sessions) {
          if (session.expires <= now || session.userId === user.id) sessions.delete(hash);
        }
        const bootstrap = createAccessKey();
        sessions.set(bootstrap.hash, { userId: user.id, expires: now + BOOTSTRAP_TTL_MS });
        return {
          bootstrap_token: bootstrap.token,
          expires_in: BOOTSTRAP_TTL_MS / 1000,
          user: { id: user.id, name: user.name },
        };
      });
    },
  });

  app.post('/api/v1/auth/bootstrap/keys', {
    onRequest: async (request) => {
      const token = bearerToken(request.headers.authorization ?? '');
      const hash = token ? hashAccessKey(token) : '';
      const session = sessions.get(hash);
      if (!session || session.expires <= Date.now()) fail(401, 'UNAUTHENTICATED');
      request.actor = { subject: session.userId, authentication: 'bootstrap' };
    },
    handler: async (request, reply) => {
      const token = bearerToken(request.headers.authorization ?? '');
      const hash = token ? hashAccessKey(token) : '';
      const session = sessions.get(hash);
      if (!session) fail(401, 'UNAUTHENTICATED');
      const input = parseBody(bootstrapBody, request.body);
      if (input.scope === 'write' && !ctx.config.writeUsers.includes(session.userId)) fail(403, 'FORBIDDEN');
      const seconds = input.expires_in === undefined ? 30 * 86_400 : input.expires_in;
      return authorization.mutate(async () => {
        // The session is single-use: whichever concurrent request reaches this point first wins.
        if (sessions.get(hash) !== session || session.expires <= Date.now() || !sessions.delete(hash)) {
          fail(401, 'UNAUTHENTICATED');
        }
        const key = createAccessKey();
        await store.createKey({
          ...key,
          owner: session.userId,
          scope: input.scope,
          repos: null,
          expires_at: seconds === null ? null : Date.now() + seconds * 1000,
          revoked: 0,
        });
        return reply.code(201).send({ token: key.token, prefix: key.prefix, scope: input.scope, expires_in: seconds });
      });
    },
  });
}
