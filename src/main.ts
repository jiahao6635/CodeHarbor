import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { AuditWriter } from './audit-writer.js';
import { databaseUrl, indexBackend as resolveIndexBackend, validateProduction } from './config.js';
import { imageAuthorization } from './image-authorization.js';
import { serveImageAuthorizer } from './image-authorizer.js';
import { SocketImageBuildExecutor } from './image-build-socket.js';
import { buildRepositoryImage } from './image-builder.js';
import { ImageCodeGraphClient } from './image-codegraph.js';
import { ImageIndexPipeline } from './image-indexer.js';
import { SocketImageQueryBackend } from './image-runtime-socket.js';
import { createInternalMcpHandler } from './internal-mcp.js';
import { createLogger } from './logger.js';
import { loadMasterKey } from './master-key.js';
import { openPostgresStore } from './postgres-store.js';
import { queryConcurrency } from './query-concurrency.js';
import { createApp } from './server.js';

const logger = createLogger({ name: 'codeharbor' });

async function main() {
  const dataDir = resolve(process.env.CODEHARBOR_DATA_DIR ?? './data');
  const endpoint = process.env.YUNXIAO_ENDPOINT;
  if (!endpoint) throw new Error('YUNXIAO_ENDPOINT is required');
  const dbUrl = await databaseUrl(process.env);
  validateProduction(process.env, dbUrl);
  const indexBackend = resolveIndexBackend(process.env);
  const key = await loadMasterKey();
  const metricsToken = process.env.CODEHARBOR_METRICS_TOKEN_FILE
    ? (await readFile(process.env.CODEHARBOR_METRICS_TOKEN_FILE, 'utf8')).trim()
    : undefined;
  const internalMcpSocket = process.env.CODEHARBOR_INTERNAL_MCP_SOCKET;
  const internalMcpTokenFile = process.env.CODEHARBOR_INTERNAL_MCP_TOKEN_FILE;
  if (!!internalMcpSocket !== !!internalMcpTokenFile) throw new Error('Incomplete internal MCP configuration');
  const internalMcpToken = internalMcpTokenFile ? (await readFile(internalMcpTokenFile, 'utf8')).trim() : undefined;
  const publicMcpDisabled = process.env.CODEHARBOR_PUBLIC_MCP_DISABLED === 'true';
  if (
    process.env.CODEHARBOR_PUBLIC_MCP_DISABLED &&
    !['true', 'false'].includes(process.env.CODEHARBOR_PUBLIC_MCP_DISABLED)
  )
    throw new Error('Invalid public MCP configuration');
  if (internalMcpToken && internalMcpToken === metricsToken) throw new Error('Internal MCP token must be independent');
  const flag = (name: string, fallback: boolean) => {
    const value = process.env[name];
    if (value === undefined || value === '') return fallback;
    if (value !== 'true' && value !== 'false') throw new Error(`Invalid ${name}`);
    return value === 'true';
  };
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = process.env[name];
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${name}`);
    return parsed;
  };
  const docsEnabled = flag('CODEHARBOR_DOCS_ENABLED', process.env.NODE_ENV !== 'production');
  const trustProxy = flag('CODEHARBOR_TRUST_PROXY', false);
  const accessTtlMs = integer('CODEHARBOR_ACCESS_TTL_MS', 6 * 3_600_000, 60_000, 7 * 86_400_000);
  const mcpKeyRatePerMinute = integer('CODEHARBOR_MCP_KEY_RATE_PER_MIN', 120, 1, 100_000);
  const authFailureRatePerMinute = integer('CODEHARBOR_AUTH_FAILURE_RATE_PER_MIN', 30, 1, 100_000);
  const auditRetentionDays = integer('CODEHARBOR_AUDIT_RETENTION_DAYS', 180, 1, 3650);
  const host = process.env.CODEHARBOR_BIND ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const list = (s: string | undefined) =>
    s
      ?.split(',')
      .map((x) => x.trim())
      .filter(Boolean) ?? [];
  const allowedGitHosts = list(process.env.CODEHARBOR_GIT_HOSTS);
  if (!allowedGitHosts.length) throw new Error('CODEHARBOR_GIT_HOSTS must list trusted HTTPS Git hosts');
  const allowedHosts = list(process.env.CODEHARBOR_ALLOWED_HOSTS);
  if (!allowedHosts.length) allowedHosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const require = createRequire(import.meta.url);
  const platformCodegraph =
    process.env.CODEGRAPH_BIN ??
    require.resolve(`@colbymchenry/codegraph-${process.platform}-${process.arch}/bin/codegraph`);
  const store = await openPostgresStore(dbUrl);
  const auditWriter = new AuditWriter(store, {
    onError: (error) => logger.error({ err: error }, 'Audit persistence failed'),
  });
  let runtimeFenced = false;
  let fencePoll: NodeJS.Timeout | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  let authorizer: Awaited<ReturnType<typeof serveImageAuthorizer>> | undefined;
  let internalMcp: Awaited<ReturnType<typeof createInternalMcpHandler>> | undefined;
  try {
    let graph: ImageCodeGraphClient | undefined;
    let imagePipeline: ImageIndexPipeline | undefined;
    if (indexBackend === 'image') {
      const runtimeImage = process.env.CODEHARBOR_REPOSITORY_RUNTIME_IMAGE;
      const querySocket = process.env.CODEHARBOR_IMAGE_QUERY_SOCKET;
      const buildSocket = process.env.CODEHARBOR_IMAGE_BUILD_SOCKET;
      const queryTokenFile = process.env.CODEHARBOR_IMAGE_QUERY_TOKEN_FILE;
      const buildTokenFile = process.env.CODEHARBOR_IMAGE_BUILD_TOKEN_FILE;
      const authSocket = process.env.CODEHARBOR_IMAGE_AUTH_SOCKET;
      const authTokenFile = process.env.CODEHARBOR_IMAGE_AUTH_TOKEN_FILE;
      if (
        !runtimeImage ||
        !/^sha256:[a-f0-9]{64}$/.test(runtimeImage) ||
        !querySocket ||
        !buildSocket ||
        !queryTokenFile ||
        !buildTokenFile ||
        !authSocket ||
        !authTokenFile
      ) {
        throw new Error('Incomplete image backend configuration');
      }
      const [queryToken, buildToken, authToken] = await Promise.all([
        readFile(queryTokenFile, 'utf8'),
        readFile(buildTokenFile, 'utf8'),
        readFile(authTokenFile, 'utf8'),
      ]);
      if (internalMcpToken && [queryToken, buildToken, authToken].some((token) => token.trim() === internalMcpToken))
        throw new Error('Internal MCP token must be independent');
      const runtimeId = runtimeImage as `sha256:${string}`;
      graph = new ImageCodeGraphClient(
        new SocketImageQueryBackend(querySocket, queryToken.trim()),
        undefined,
        queryConcurrency(process.env.CODEHARBOR_MCP_QUERY_CONCURRENCY),
      );
      const executor = new SocketImageBuildExecutor({
        path: buildSocket,
        token: buildToken.trim(),
        runtimeImage: runtimeId,
      });
      imagePipeline = new ImageIndexPipeline(runtimeId, graph, undefined, (request) =>
        buildRepositoryImage(request, executor.execute),
      );
      authorizer = await serveImageAuthorizer({
        path: authSocket,
        token: authToken.trim(),
        authorize: imageAuthorization(store, imagePipeline),
        socketMode: 0o660,
      });
      await graph.probe();
    }
    app = createApp(
      {
        dataDir,
        credentialKey: key,
        codeupEndpoint: endpoint,
        organizationId: process.env.YUNXIAO_ORGANIZATION_ID || undefined,
        allowedGitHosts,
        allowedHosts,
        allowedOrigins: list(process.env.CODEHARBOR_ALLOWED_ORIGINS),
        writeUsers: list(process.env.CODEHARBOR_WRITE_USERS),
        codegraphBin: platformCodegraph,
        metricsToken,
        publicMcpDisabled,
        docsEnabled,
        trustProxy,
        accessTtlMs,
        mcpKeyRatePerMinute,
        authFailureRatePerMinute,
        auditRetentionDays,
      },
      {
        store,
        graph,
        imagePipeline,
        logger,
        audit: (event) => auditWriter.record(event),
        auditStats: () => ({ dropped: auditWriter.dropped, failed: auditWriter.failed }),
        fenced: () => ({ image_query: graph?.isUnsafe() ?? false, image_runtime: runtimeFenced }),
      },
    );
    if (graph) {
      const runtimeGraph = graph;
      const poll = async () => {
        try {
          runtimeFenced = (await runtimeGraph.runtimeStatus()).uncertain;
        } catch {
          runtimeFenced = true;
        }
      };
      await poll();
      fencePoll = setInterval(() => {
        void poll();
      }, 30_000);
      fencePoll.unref();
    }
    key.fill(0);
    if (imagePipeline) {
      // Legacy checkouts remain intact for rollback and are rebuilt as images.
      for (const repository of await store.listRepositories()) {
        if (
          repository.path &&
          !repository.path.startsWith('oci://') &&
          !['disabled', 'branch_deleted'].includes(repository.status)
        ) {
          await app.worker.enqueue(repository.id, 'image_migration');
        }
      }
    }
    await app.start();
    if (internalMcpSocket && internalMcpToken)
      internalMcp = await createInternalMcpHandler({
        path: internalMcpSocket,
        token: internalMcpToken,
        backend: app.internalMcp,
      });
    await app.listen({ port, host });
  } catch (error) {
    key.fill(0);
    await internalMcp?.close().catch(() => {});
    await auditWriter.close().catch(() => {});
    if (app) await app.close().catch(() => {});
    else await store.close().catch(() => {});
    await authorizer?.close().catch(() => {});
    throw error;
  }
  const runningApp = app;
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    if (fencePoll) clearInterval(fencePoll);
    try {
      await internalMcp?.close();
      await auditWriter.close();
      await runningApp.close();
      await authorizer?.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  }
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}
main().catch((error: unknown) => {
  // Only a fixed, non-secret-bearing summary reaches logs.
  const message =
    error instanceof Error &&
    /^(YUNXIAO_ENDPOINT is required|Invalid PORT|CODEHARBOR_GIT_HOSTS must|PostgreSQL is required|Invalid PostgreSQL URL|Production PostgreSQL requires|Production requires|Configure only one database|Database URL file is unavailable)/.test(
      error.message,
    )
      ? error.message
      : 'Startup failed; check database, key provider, and service configuration';
  logger.fatal(message);
  process.exitCode = 1;
});
