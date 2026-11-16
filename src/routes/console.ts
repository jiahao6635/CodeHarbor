import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../http/context.js';
import { authenticateHook } from '../http/guards.js';

export const UI_PREFIX = '/ui';
export const UI_ASSET_ROUTE = /^\/ui\/assets\//;
export const UI_ROUTE = /^\/ui(\/|$)/;

/** No remote resources: fonts, icons and scripts are bundled, so everything resolves to the page origin. */
export const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** Serves the built single-page console; unknown paths under /ui fall back to index.html for client routing. */
export function registerConsoleRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { uiDir } = ctx.config;
  if (!uiDir) return;
  if (!existsSync(join(uiDir, 'index.html'))) throw new Error(`Console build not found in ${uiDir}`);

  app.get('/api/v1/console', { onRequest: authenticateHook(ctx) }, async () => ({
    mcp_url: ctx.config.uiMcpUrl ?? null,
    public_mcp_disabled: ctx.config.publicMcpDisabled ?? false,
  }));

  app.register(
    async (ui) => {
      await ui.register(fastifyStatic, {
        root: uiDir,
        prefix: '/',
        index: ['index.html'],
        cacheControl: false,
        etag: true,
        lastModified: false,
        dotfiles: 'ignore',
        serveDotFiles: false,
        // Only the known build layout is served; nothing outside uiDir is reachable.
        allowedPath: (pathName) => !pathName.includes('..'),
      });
      ui.setNotFoundHandler((_request, reply) => reply.sendFile('index.html'));
    },
    { prefix: UI_PREFIX },
  );
}
