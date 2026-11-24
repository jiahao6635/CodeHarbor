import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBrowserSession } from '../browser-auth.js';
import { CodeupError, hasRepositoryRole } from '../codeup.js';
import type { AppContext } from '../http/context.js';
import { fail } from '../http/errors.js';
import { assertCurrentPat, authenticateBrowserHook, requireBoundPat } from '../http/guards.js';
import { parseParams, parseQuery, positivePage, singleQuery, text } from '../http/validation.js';

const paramsSchema = z.object({ id: z.string().regex(/^\d{1,30}$/) });
const querySchema = z.object({
  page: singleQuery(positivePage.max(Number.MAX_SAFE_INTEGER)).default(1),
  search: singleQuery(text(255)).optional(),
});

export function registerCodeupBranchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/codeup/repositories/:id/branches', { onRequest: authenticateBrowserHook(ctx) }, async (request) => {
    const session = await requireBrowserSession(ctx, request);
    const { id } = parseParams(paramsSchema, request.params);
    const { page, search } = parseQuery(querySchema, request.query);
    const user = await requireBoundPat(ctx, session.account);
    const pat = ctx.cipher.decrypt(user.credential, user.id);
    const repo = await ctx.codeup.getRepository(pat, id);
    if (!hasRepositoryRole(repo)) fail(404, 'NOT_FOUND');

    try {
      const { branches, nextPage } = await ctx.codeup.listBranches(pat, id, page, search);
      await assertCurrentPat(ctx, request, user);
      return {
        branches,
        default_branch: repo.defaultBranch ?? branches.find((branch) => branch.is_default)?.name ?? null,
        next_page: nextPage,
      };
    } catch (error) {
      if (error instanceof CodeupError && error.kind === 'forbidden') fail(403, 'CODEUP_BRANCH_SCOPE_REQUIRED');
      throw error;
    }
  });
}
