import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type CredentialCipher, constantTimeEqual } from '../auth.js';
import { requireBrowserSession } from '../browser-auth.js';
import type { CodeupUser } from '../codeup.js';
import type { AppContext } from '../http/context.js';
import { fail } from '../http/errors.js';
import { parseBody, text } from '../http/validation.js';
import type { StoreAccess } from '../store.js';

const bindBody = z.strictObject({ pat: text(4096) });

async function savePat(tx: StoreAccess, cipher: CredentialCipher, user: CodeupUser, pat: string): Promise<void> {
  const existing = await tx.getUser(user.id, { forUpdate: true });
  if (existing) {
    try {
      if (constantTimeEqual(cipher.decrypt(existing.credential, user.id), pat)) return;
    } catch {
      // A fresh verified PAT can repair an unreadable credential.
    }
  }
  const credential = cipher.encrypt(pat, user.id);
  if (!existing) {
    await tx.createUser({ id: user.id, username: user.username, credential, credential_version: 1 });
    return;
  }
  await tx.updateUserCredential(user.id, user.username, credential);
  await tx.clearUserAccess(user.id);
  for (const repo of await tx.listRepositories()) {
    if (repo.sync_owner === user.id && repo.status !== 'disabled' && repo.status !== 'branch_deleted') {
      await tx.updateRepository(repo.id, {
        status: 'credential_required',
        error: 'SYNC_AUTHORIZATION_REQUIRED',
      });
    }
  }
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, codeup, cipher, sessionService, authorization } = ctx;

  if (!sessionService) return;

  app.get('/api/v1/auth/feishu/start', async (request, reply) => {
    if (!ctx.limiters.oauth.hit(ctx.clientIp(request))) fail(429, 'RATE_LIMITED');
    return sessionService.start(reply);
  });

  app.get('/api/v1/auth/feishu/callback', async (request, reply) => {
    if (!ctx.limiters.oauth.hit(ctx.clientIp(request))) fail(429, 'RATE_LIMITED');
    return sessionService.callback(request, reply);
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    return authorization.mutate(() => sessionService.signOut(request, reply));
  });

  app.post('/api/v1/auth/yunxiao/bind', {
    onRequest: async (request) => {
      if (!ctx.limiters.bind.hit(ctx.clientIp(request))) fail(429, 'RATE_LIMITED');
      await requireBrowserSession(ctx, request);
    },
    handler: async (request) => {
      const session = await requireBrowserSession(ctx, request);
      const { pat } = parseBody(bindBody, request.body);
      const user = await codeup.getUser(pat);
      // Check the configured Codeup organization and required repository-list scope.
      await codeup.listRepositories(pat, 1, 1);
      return authorization.mutate(async () => {
        await store.transaction(async (tx) => {
          const account = await sessionService.assertCurrent(session, tx);
          const currentOwner = await tx.getAccountByCodeupId(user.id);
          if (
            (account.codeup_user_id !== null && account.codeup_user_id !== user.id) ||
            (currentOwner && currentOwner.id !== account.id)
          ) {
            fail(409, 'CODEUP_ACCOUNT_CONFLICT');
          }
          await savePat(tx, cipher, user, pat);
          if (account.codeup_user_id === null) await tx.linkCodeupAccount(account.id, user.id);
        });
        return { user: { id: user.id, name: user.name } };
      });
    },
  });
}
