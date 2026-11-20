import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hashAccessKey } from '../auth.js';
import { bearerToken, type Principal } from '../authorization.js';
import type { AppContext } from '../http/context.js';
import { fail, HttpError } from '../http/errors.js';
import { admitBearerAuthentication } from '../http/guards.js';
import { mcpRepository } from '../http/views.js';
import { createMcpHandler } from '../mcp.js';

/**
 * The public MCP endpoint speaks Streamable HTTP over the raw Node streams, so it
 * hijacks the reply in onRequest before Fastify touches the body.
 */
export function registerMcpRoute(app: FastifyInstance, ctx: AppContext): void {
  const { authorization, config } = ctx;
  const requests = new WeakMap<IncomingMessage, FastifyRequest>();
  const admissions = new WeakMap<IncomingMessage, () => void>();

  const handler = createMcpHandler<Principal>({
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
    async authenticate(raw) {
      const release = admissions.get(raw);
      admissions.delete(raw);
      let key: Principal | null;
      try {
        key = await authorization.authenticateBearer(raw.headers.authorization ?? '');
      } catch (error) {
        release?.();
        throw error;
      }
      if (!key) return null;
      release?.();
      const request = requests.get(raw);
      if (request) {
        request.actor = { ...request.actor, subject: key.owner, key_prefix: key.prefix, authentication: 'api_key' };
      }
      return key;
    },
    listRepositories: async (key, signal) => (await authorization.queryList(key, signal)).map(mcpRepository),
    getRepository: async (key, id, signal) => {
      try {
        return mcpRepository(await authorization.queryVisible(key, id, signal));
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return null;
        throw error;
      }
    },
    onToolResult(raw, event) {
      const request = requests.get(raw);
      if (!request) return;
      request.actor = {
        ...request.actor,
        tool: event.tool,
        tool_outcome: event.outcome,
        ...(event.repo_id ? { repo_id: event.repo_id } : {}),
        ...(event.query_hash ? { query_hash: event.query_hash } : {}),
      };
    },
    codegraph: ctx.graph,
  });

  app.all('/mcp', {
    onRequest: async (request, reply) => {
      if (config.publicMcpDisabled) fail(404, 'NOT_FOUND');
      const token = bearerToken(request.headers.authorization ?? '');
      if (token && !ctx.limiters.mcpKey.hit(hashAccessKey(token))) {
        request.durableAudit = false;
        fail(429, 'RATE_LIMITED');
      }
      admissions.set(request.raw, admitBearerAuthentication(ctx, request));
      requests.set(request.raw, request);
      reply.hijack();
      try {
        await handler(request.raw, reply.raw as ServerResponse);
      } finally {
        admissions.get(request.raw)?.();
        admissions.delete(request.raw);
      }
    },
    handler: async () => {},
  });
}
