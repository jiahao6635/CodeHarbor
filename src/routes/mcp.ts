import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hashAccessKey } from '../auth.js';
import { bearerToken, type Principal } from '../authorization.js';
import type { AppContext } from '../http/context.js';
import { fail, HttpError } from '../http/errors.js';
import { admitBearerAuthentication, releaseBearerAuthentication } from '../http/guards.js';
import { mcpRepository } from '../http/views.js';
import { createMcpHandler } from '../mcp.js';

/**
 * The public MCP endpoint speaks Streamable HTTP over the raw Node streams, so it
 * hijacks the reply in onRequest before Fastify touches the body.
 */
export function registerMcpRoute(app: FastifyInstance, ctx: AppContext): void {
  const { authorization, config } = ctx;
  const requests = new WeakMap<IncomingMessage, FastifyRequest>();
  const admissions = new WeakMap<IncomingMessage, string>();

  const handler = createMcpHandler<Principal>({
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
    async authenticate(raw) {
      const client = admissions.get(raw);
      try {
        const key = await authorization.authenticateBearer(raw.headers.authorization ?? '');
        if (client) {
          admissions.delete(raw);
          if (key) releaseBearerAuthentication(ctx, client);
        }
        if (!key) return null;
        const request = requests.get(raw);
        if (request) {
          request.actor = { ...request.actor, subject: key.owner, key_prefix: key.prefix, authentication: 'api_key' };
        }
        return key;
      } catch (error) {
        if (client) {
          admissions.delete(raw);
          releaseBearerAuthentication(ctx, client);
        }
        throw error;
      }
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
      if (token && !ctx.limiters.mcpKey.hit(hashAccessKey(token))) fail(429, 'RATE_LIMITED');
      admissions.set(request.raw, admitBearerAuthentication(ctx, request));
      requests.set(request.raw, request);
      reply.hijack();
      await handler(request.raw, reply.raw as ServerResponse);
    },
    handler: async () => {},
  });
}
