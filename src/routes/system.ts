import type { FastifyInstance } from 'fastify';
import { constantTimeEqual } from '../auth.js';
import type { AppContext } from '../http/context.js';
import { fail } from '../http/errors.js';
import {
  assertActiveWrite,
  assertSuperAdmin,
  authenticateHook,
  authenticateSuperAdminHook,
  requireAdminHook,
} from '../http/guards.js';
import { renderJobMetrics } from '../job-metrics.js';
import { collectSystemPerformance, formatSystemPerformanceMetrics } from '../system-performance.js';

const STATUS_PROBE_TIMEOUT_MS = 3_000;
type DependencyStatus = 'ok' | 'unavailable';

function runtimeFences(ctx: AppContext): Record<string, boolean> {
  return { graph_client: ctx.graph.isUnsafe?.() ?? false, ...ctx.fenced() };
}

function statusProbe(check: (signal: AbortSignal) => Promise<void>) {
  let pending: Promise<DependencyStatus> | undefined;
  return () => {
    if (pending) return pending;
    const signal = AbortSignal.timeout(STATUS_PROBE_TIMEOUT_MS);
    const checked = Promise.resolve()
      .then(() => check(signal))
      .then<DependencyStatus, DependencyStatus>(
        () => 'ok',
        () => 'unavailable',
      );
    const timedOut = new Promise<DependencyStatus>((resolve) => {
      signal.addEventListener('abort', () => resolve('unavailable'), { once: true });
    });
    pending = Promise.race([checked, timedOut]);
    // Keep sharing a timed-out probe until it exits so refreshes cannot queue behind it.
    void checked.then(() => {
      pending = undefined;
    });
    return pending;
  };
}

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      await ctx.store.checkHealth();
      await ctx.graph.probe();
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
    return { status: 'ok' };
  });

  app.get('/metrics', async (request, reply) => {
    const token = ctx.config.metricsToken;
    if (!token) fail(404, 'NOT_FOUND');
    if (!constantTimeEqual(request.headers.authorization ?? '', `Bearer ${token}`)) fail(401, 'UNAUTHENTICATED');
    const now = Date.now();
    const [jobMetrics, performance] = await Promise.all([
      ctx.store.jobMetrics(now),
      collectSystemPerformance(ctx.config.dataDir),
    ]).catch(() => fail(503, 'METRICS_UNAVAILABLE'));
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return (
      ctx.metrics.render({ fenced: runtimeFences(ctx), audit: ctx.auditStats() }) +
      renderJobMetrics(jobMetrics, now) +
      formatSystemPerformanceMetrics(performance)
    );
  });

  const feishu = ctx.authorization.enforceFeishu;
  const databaseStatus = statusProbe(() => ctx.store.checkHealth());
  const indexRuntimeStatus = statusProbe((signal) => ctx.graph.probe(signal));
  app.get(
    '/api/v1/admin/system/performance',
    { onRequest: feishu ? authenticateSuperAdminHook(ctx) : [authenticateHook(ctx), requireAdminHook(ctx)] },
    async (request) => {
      if (feishu) await assertSuperAdmin(ctx, request);
      else await assertActiveWrite(ctx, request);
      const [database, indexRuntime, performance] = await Promise.all([
        databaseStatus(),
        indexRuntimeStatus(),
        collectSystemPerformance(ctx.config.dataDir),
      ]);
      const fenced = runtimeFences(ctx);
      const healthy = database === 'ok' && indexRuntime === 'ok' && !Object.values(fenced).includes(true);
      return { health: { status: healthy ? 'ok' : 'degraded', database, indexRuntime, fenced }, performance };
    },
  );
}
