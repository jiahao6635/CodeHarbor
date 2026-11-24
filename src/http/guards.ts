import type { IncomingMessage } from 'node:http';
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { Principal } from '../authorization.js';
import { requireBrowserSession } from '../browser-auth.js';
import type { AccountRecord, StoreAccess } from '../store.js';
import type { AppContext } from './context.js';
import { fail } from './errors.js';

type BearerRequest = Pick<IncomingMessage, 'headers' | 'socket'> & { durableAudit?: boolean };

/** Reserves per-client authentication capacity before any bearer value can reach the key store. */
export function admitBearerAuthentication(ctx: AppContext, request: BearerRequest): () => void {
  const release = ctx.limiters.authFailure.reserve(ctx.clientIp(request));
  if (!release) {
    request.durableAudit = false;
    fail(429, 'RATE_LIMITED');
  }
  return release;
}

export async function authenticateBearerRequest(ctx: AppContext, request: BearerRequest): Promise<Principal | null> {
  const release = admitBearerAuthentication(ctx, request);
  try {
    const key = await ctx.authorization.authenticateBearer(request.headers.authorization ?? '');
    if (key) release();
    return key;
  } catch (error) {
    release();
    throw error;
  }
}

/** Resolves the bearer key before the body is read so slow uploads cannot hold an unauthenticated connection. */
export function authenticateHook(ctx: AppContext): onRequestAsyncHookHandler {
  return async (request) => {
    const key = await authenticateBearerRequest(ctx, request);
    if (!key) fail(401, 'UNAUTHENTICATED');
    const user = await ctx.store.getUser(key.owner);
    if (!user) fail(401, 'UNAUTHENTICATED');
    request.principal = key;
    request.credentialVersion = user.credential_version;
    request.actor = { ...request.actor, subject: key.owner, key_prefix: key.prefix, authentication: 'api_key' };
  };
}

/** For APIs that deliberately support scoped machine access as well as browser sessions. */
export function authenticateRepositoryHook(ctx: AppContext): onRequestAsyncHookHandler {
  const bearer = authenticateHook(ctx);
  return async function (request, reply) {
    if (!ctx.authorization.enforceFeishu || request.headers.authorization !== undefined) {
      await bearer.call(this, request, reply);
    } else {
      await requireBrowserSession(ctx, request);
    }
  };
}

export function authenticateBrowserHook(ctx: AppContext): onRequestAsyncHookHandler {
  return async (request) => {
    if (request.headers.authorization !== undefined) fail(401, 'UNAUTHENTICATED');
    await requireBrowserSession(ctx, request);
  };
}

export async function assertCurrentBrowser(ctx: AppContext, request: FastifyRequest, tx?: StoreAccess) {
  const session = request.browserSession;
  if (!session || !ctx.sessionService) fail(401, 'UNAUTHENTICATED');
  return ctx.sessionService.assertCurrent(session, tx);
}

export function authenticateSuperAdminHook(ctx: AppContext): onRequestAsyncHookHandler {
  const browser = authenticateBrowserHook(ctx);
  return async function (request, reply) {
    await browser.call(this, request, reply);
    if (request.browserSession?.account.role !== 'super_admin') fail(403, 'FORBIDDEN');
  };
}

export async function assertSuperAdmin(ctx: AppContext, request: FastifyRequest, tx?: StoreAccess) {
  const account = await assertCurrentBrowser(ctx, request, tx);
  if (account.role !== 'super_admin') fail(403, 'FORBIDDEN');
  return account;
}

export async function requireBoundPat(ctx: AppContext, account: AccountRecord) {
  const user = account.codeup_user_id && (await ctx.store.getUser(account.codeup_user_id));
  if (!user) fail(409, 'PAT_REQUIRED');
  return user;
}

export async function assertCurrentPat(
  ctx: AppContext,
  request: FastifyRequest,
  user: {
    id: string;
    credential_version: number;
  },
) {
  const account = await assertCurrentBrowser(ctx, request);
  const currentUser = account.codeup_user_id === user.id && (await ctx.store.getUser(user.id));
  if (!currentUser || currentUser.credential_version !== user.credential_version) fail(409, 'PAT_CHANGED');
  return account;
}

export function requireWriteHook(ctx: AppContext): onRequestAsyncHookHandler {
  return async (request) => {
    ctx.authorization.requireWrite(principalOf(request));
  };
}

export function requireAdminHook(ctx: AppContext): onRequestAsyncHookHandler {
  return async (request) => {
    ctx.authorization.requireAdmin(principalOf(request));
  };
}

export function principalOf(request: FastifyRequest): Principal {
  if (!request.principal) fail(401, 'UNAUTHENTICATED');
  return request.principal;
}

/** After a body has been read, confirms the key is still live and still a write key for an unchanged owner credential. */
export async function assertActiveWrite(ctx: AppContext, request: FastifyRequest): Promise<Principal> {
  const key = principalOf(request);
  const current = await ctx.store.getKey(key.hash);
  const user = await ctx.store.getUser(key.owner);
  if (
    !current ||
    !(await ctx.authorization.isActiveKey(current)) ||
    user?.credential_version !== request.credentialVersion
  ) {
    fail(401, 'UNAUTHENTICATED');
  }
  ctx.authorization.requireWrite(current);
  return current;
}
