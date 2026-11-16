import type { FastifyInstance } from 'fastify';
import { constantTimeEqual } from '../auth.js';
import type { AppContext } from '../http/context.js';
import { fail } from '../http/errors.js';
import { renderJobMetrics } from '../job-metrics.js';

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
    let jobMetrics: Awaited<ReturnType<typeof ctx.store.jobMetrics>>;
    try {
      jobMetrics = await ctx.store.jobMetrics(now);
    } catch {
      fail(503, 'METRICS_UNAVAILABLE');
    }
    const fenced = { graph_client: ctx.graph.isUnsafe?.() ?? false, ...ctx.fenced() };
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return ctx.metrics.render({ fenced, audit: ctx.auditStats() }) + renderJobMetrics(jobMetrics, now);
  });
}
