import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import { CredentialCipher } from './auth.js';
import { Authorization } from './authorization.js';
import { BrowserSessionService } from './browser-auth.js';
import { checkCloneAccess } from './clone-access.js';
import { CodeGraphClient, type GraphClient } from './codegraph.js';
import { CodeupClient } from './codeup.js';
import type { AppConfig, AppContext, AuditEvent } from './http/context.js';
import { toErrorReply } from './http/errors.js';
import { HttpMetrics } from './http/metrics.js';
import type { ImageIndexPipeline } from './image-indexer.js';
import type { IndexRequest } from './indexer.js';
import { createInternalMcpBackend } from './internal-mcp-backend.js';
import type { Logger } from './logger.js';
import { openApiDocument } from './openapi.js';
import { RateLimiter } from './rate-limit.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCodeupBranchRoutes } from './routes/codeup-branches.js';
import { registerConsoleRoutes, UI_ASSET_ROUTE, UI_CSP, UI_ROUTE } from './routes/console.js';
import { registerHookRoutes } from './routes/hooks.js';
import { registerKeyRoutes } from './routes/keys.js';
import { registerMcpRoute } from './routes/mcp.js';
import { registerRepositoryRoutes } from './routes/repositories.js';
import { registerSystemRoutes } from './routes/system.js';
import type { StoreBackend } from './store.js';
import { IndexWorker } from './worker.js';

export type { AppConfig, AuditEvent } from './http/context.js';

export type AppDependencies = {
  store: StoreBackend;
  codeup?: CodeupClient;
  feishuFetch?: typeof fetch;
  /** Legacy behavior for existing regression fixtures. The server entrypoint never sets it. */
  legacyAuthForTests?: (app: FastifyInstance, ctx: AppContext) => void;
  graph?: GraphClient;
  worker?: IndexWorker;
  imagePipeline?: ImageIndexPipeline;
  logger?: Logger;
  audit?: (event: AuditEvent) => void;
  probe?: (request: IndexRequest, signal?: AbortSignal) => Promise<boolean>;
  /** Fail-closed runtime fences by component, for the metrics endpoint. */
  fenced?: () => Record<string, boolean>;
  auditStats?: () => { dropped: number; failed: number };
};

const BODY_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const AUDITED_ROUTE = /^\/(mcp$|api\/v1\/)/;
const DOCS_ROUTE = /^\/(docs(\/|$)|openapi\.json$)/;

function routeLabel(url: string | undefined): string {
  return !url || url === '/*' ? '<unmatched>' : url;
}

/** One instance only: the worker does not provide distributed coordination. */
export function createApp(config: AppConfig, deps: AppDependencies) {
  if (
    config.metricsToken !== undefined &&
    (config.metricsToken.length < 32 || /[^\x21-\x7e]/.test(config.metricsToken))
  ) {
    throw new Error('Invalid metrics token');
  }
  const accessTtlMs = config.accessTtlMs ?? 6 * 3_600_000;
  if (!Number.isSafeInteger(accessTtlMs) || accessTtlMs < 60_000) throw new Error('Invalid access TTL');

  const { store } = deps;
  const cipher = new CredentialCipher(config.credentialKey);
  const codeup =
    deps.codeup ?? new CodeupClient({ endpoint: config.codeupEndpoint, organizationId: config.organizationId });
  const graph = deps.graph ?? new CodeGraphClient(config.codegraphBin, config.dataDir);
  const authorization = new Authorization({
    store,
    codeup,
    cipher,
    writeUsers: config.writeUsers,
    enforceFeishu: !deps.legacyAuthForTests,
    dataDir: config.dataDir,
    allowedGitHosts: config.allowedGitHosts,
    probe: deps.probe ?? checkCloneAccess,
    accessTtlMs,
    auditRetentionDays: config.auditRetentionDays ?? 180,
  });
  const imagePipeline = deps.imagePipeline;
  const worker =
    deps.worker ??
    new IndexWorker({
      store,
      codeup,
      cipher,
      graph,
      dataDir: config.dataDir,
      allowedGitHosts: config.allowedGitHosts,
      codegraphBin: config.codegraphBin,
      reconcileIntervalMs: config.reconcileMs,
      logger: deps.logger,
      maintenance: () => authorization.maintenance(),
      ...(imagePipeline
        ? {
            build: (request: IndexRequest) => imagePipeline.build(request),
            healthy: (request: IndexRequest, reference: string, commit: string) =>
              imagePipeline.healthy(request, reference, commit),
            releaseCandidate: (candidate: { path: string }, retainedReferences: string[]) =>
              imagePipeline.release(candidate.path, retainedReferences),
          }
        : {}),
    });

  const ctx: AppContext = {
    config,
    store,
    cipher,
    codeup,
    graph,
    worker,
    authorization,
    metrics: new HttpMetrics(),
    limiters: {
      bind: new RateLimiter(10, 60_000),
      oauth: new RateLimiter(60, 60_000),
      authFailure: new RateLimiter(config.authFailureRatePerMinute ?? 30, 60_000),
      mcpKey: new RateLimiter(config.mcpKeyRatePerMinute ?? 120, 60_000),
    },
    sessionService: config.feishu
      ? new BrowserSessionService(config.feishu, store, authorization.mutate, deps.feishuFetch)
      : undefined,
    probe: deps.probe ?? checkCloneAccess,
    clientIp(request: Pick<IncomingMessage, 'headers' | 'socket'>) {
      if (config.trustProxy) {
        const forwarded = request.headers['x-forwarded-for'];
        const chain = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? ''))
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
        if (chain.length) return chain[chain.length - 1];
      }
      return request.socket.remoteAddress ?? 'unknown';
    },
    fenced: () => deps.fenced?.() ?? {},
    auditStats: () => deps.auditStats?.(),
  };

  const fastify = Fastify({
    ...(deps.logger ? { loggerInstance: deps.logger as FastifyBaseLogger } : { logger: true }),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: BODY_LIMIT,
    requestTimeout: REQUEST_TIMEOUT_MS,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  });

  function emitAudit(event: AuditEvent, durable = true) {
    fastify.log.info(event, 'audit');
    if (!durable) return;
    try {
      deps.audit?.(event);
    } catch {
      // An observer must not affect the response.
    }
  }

  // Reference-typed decorations are initialised per request in onRequest, never shared.
  fastify.decorateRequest('actor');
  fastify.decorateRequest('durableAudit');
  fastify.decorateRequest('principal');
  fastify.decorateRequest('browserSession');
  fastify.decorateRequest('credentialVersion');

  fastify.addHook('onRequest', async (request, reply) => {
    request.actor = {};
    request.durableAudit = true;
    const started = process.hrtime.bigint();
    const route = routeLabel(request.routeOptions.url);
    // Raw headers survive reply.hijack(), which the MCP route relies on.
    reply.raw.setHeader('x-request-id', request.id);
    reply.raw.setHeader('x-content-type-options', 'nosniff');
    if (UI_ASSET_ROUTE.test(request.url)) {
      // Vite emits content-hashed asset names, so they can be cached indefinitely.
      reply.raw.setHeader('cache-control', 'public, max-age=31536000, immutable');
    } else if (!DOCS_ROUTE.test(request.url)) {
      reply.raw.setHeader('cache-control', 'no-store');
    }
    if (UI_ROUTE.test(request.url)) {
      reply.raw.setHeader('content-security-policy', UI_CSP);
      reply.raw.setHeader('referrer-policy', 'same-origin');
      reply.raw.setHeader('x-frame-options', 'DENY');
    }
    reply.raw.once('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const status = reply.raw.statusCode;
      ctx.metrics.observe(request.method, status, seconds);
      fastify.log.info(
        { request_id: request.id, method: request.method, route, status, duration_ms: seconds * 1000 },
        'http_request',
      );
      if (AUDITED_ROUTE.test(route)) {
        emitAudit(
          { request_id: request.id, method: request.method, route, status, ...request.actor },
          request.durableAudit,
        );
      }
    });
    const { host, origin } = request.headers;
    if (!host || !config.allowedHosts.includes(host)) {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }
    // A page served from an allowed host (the bundled console) is same-origin by construction; browsers
    // still send Origin on non-GET requests, so it must pass without being listed separately.
    const sameOrigin = origin === `https://${host}` || origin === `http://${host}`;
    if (origin && !sameOrigin && origin !== config.feishu?.origin && !config.allowedOrigins?.includes(origin)) {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }
  });

  fastify.setErrorHandler((error, request, reply) => {
    const { status, code, log } = toErrorReply(error);
    if (log) request.log.error({ err: error, request_id: request.id }, 'request_failed');
    if (reply.raw.headersSent) {
      reply.raw.end();
      return;
    }
    reply.code(status).send({ error: code });
  });
  fastify.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'NOT_FOUND' }));

  const appOpenApiDocument = config.publicMcpDisabled
    ? {
        ...openApiDocument,
        paths: Object.fromEntries(Object.entries(openApiDocument.paths).filter(([path]) => path !== '/mcp')),
      }
    : openApiDocument;
  if (config.docsEnabled ?? true) {
    fastify.register(swagger, { mode: 'static', specification: { document: appOpenApiDocument } });
    fastify.register(swaggerUi, {
      routePrefix: '/docs',
      staticCSP: true,
      uiConfig: { docExpansion: 'list', persistAuthorization: false, validatorUrl: null },
    });
    fastify.get('/openapi.json', async () => appOpenApiDocument);
  }

  registerSystemRoutes(fastify, ctx);
  registerMcpRoute(fastify, ctx);
  if (deps.legacyAuthForTests) {
    if (config.feishu) throw new Error('Legacy test authentication cannot be combined with Feishu login');
    deps.legacyAuthForTests(fastify, ctx);
  } else {
    registerAuthRoutes(fastify, ctx);
    registerCodeupBranchRoutes(fastify, ctx);
  }
  registerHookRoutes(fastify, ctx);
  registerRepositoryRoutes(fastify, ctx);
  registerKeyRoutes(fastify, ctx);
  registerAdminRoutes(fastify, ctx);
  registerConsoleRoutes(fastify, ctx);

  const internalMcp = createInternalMcpBackend({ store, graph, authorization, audit: emitAudit });

  return {
    server: fastify.server,
    store,
    worker,
    internalMcp,
    maintenance: () => authorization.maintenance(),
    listen(options: { port: number; host: string }) {
      return fastify.listen(options);
    },
    start() {
      return worker.start();
    },
    async close() {
      await fastify.close();
      await worker.stop();
      await graph.close();
      await store.close();
    },
  };
}
