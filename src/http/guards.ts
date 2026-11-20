import type { IncomingMessage } from 'node:http';
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { Principal } from '../authorization.js';
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
    current.revoked ||
    (current.expires_at !== null && current.expires_at <= Date.now()) ||
    user?.credential_version !== request.credentialVersion
  ) {
    fail(401, 'UNAUTHENTICATED');
  }
  ctx.authorization.requireWrite(current);
  return current;
}
