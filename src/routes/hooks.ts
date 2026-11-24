import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { constantTimeEqual, hashAccessKey } from '../auth.js';
import type { AppContext } from '../http/context.js';
import { fail } from '../http/errors.js';
import { identifier, parseBody, parseParams } from '../http/validation.js';
import { verifyPushWebhook } from '../indexer.js';

const params = z.object({ id: identifier });
const payload = z.record(z.string(), z.unknown());

export function registerHookRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, worker, authorization } = ctx;

  app.post<{ Params: { id: string } }>('/api/v1/hooks/codeup/:id', {
    onRequest: async (request) => {
      const { id } = parseParams(params, request.params);
      const repo = await store.getRepository(id);
      const token = request.headers['x-codeup-token'];
      if (!repo || typeof token !== 'string' || !constantTimeEqual(hashAccessKey(token), repo.hook_hash)) {
        fail(404, 'NOT_FOUND');
      }
      request.actor = { repo_id: repo.id, authentication: 'webhook' };
    },
    handler: async (request, reply) => {
      const { id } = parseParams(params, request.params);
      const token = request.headers['x-codeup-token'];
      const repo = await store.getRepository(id);
      if (!repo || typeof token !== 'string') fail(404, 'NOT_FOUND');
      const body = parseBody(payload, request.body);
      const event = typeof request.headers['codeup-event'] === 'string' ? request.headers['codeup-event'] : undefined;
      const outcome = verifyPushWebhook({
        token,
        expectedToken: token,
        event,
        body,
        codeupRepositoryId: repo.codeup_id,
        branch: repo.branch,
      });
      return authorization.mutate(async () => {
        const current = await store.getRepository(repo.id);
        if (!current || !constantTimeEqual(hashAccessKey(token), current.hook_hash)) fail(404, 'NOT_FOUND');
        if (current.status !== 'disabled') {
          if (outcome === 'enqueue') await worker.enqueue(repo.id, 'webhook');
          if (outcome === 'branch_deleted') {
            await store.updateRepository(repo.id, { status: 'branch_deleted', error: 'BRANCH_DELETED' });
          }
        }
        return reply.code(202).send({ accepted: true });
      });
    },
  });
}
