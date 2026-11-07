import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createApp } from './server.js';
import { loadMasterKey } from './master-key.js';
import { databaseUrl, validateProduction } from './config.js';
import { PostgresStore } from './postgres-store.js';
import { AsyncSqliteStore } from './async-store.js';

async function main() {
  const dataDir = resolve(process.env.CODEHARBOR_DATA_DIR ?? './data');
  const endpoint = process.env.YUNXIAO_ENDPOINT;
  if (!endpoint) throw new Error('YUNXIAO_ENDPOINT is required');
  const dbUrl = await databaseUrl(process.env);
  validateProduction(process.env, dbUrl);
  const key = await loadMasterKey();
  const metricsToken = process.env.CODEHARBOR_METRICS_TOKEN_FILE
    ? (await readFile(process.env.CODEHARBOR_METRICS_TOKEN_FILE, 'utf8')).trim() : undefined;
  const host = process.env.CODEHARBOR_BIND ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const list = (s: string | undefined) => s?.split(',').map(x => x.trim()).filter(Boolean) ?? [];
  const allowedGitHosts = list(process.env.CODEHARBOR_GIT_HOSTS);
  if (!allowedGitHosts.length) throw new Error('CODEHARBOR_GIT_HOSTS must list trusted HTTPS Git hosts');
  const allowedHosts = list(process.env.CODEHARBOR_ALLOWED_HOSTS);
  if (!allowedHosts.length) allowedHosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const require = createRequire(import.meta.url);
  const platformCodegraph = process.env.CODEGRAPH_BIN ?? require.resolve(`@colbymchenry/codegraph-${process.platform}-${process.arch}/bin/codegraph`);
  const store = dbUrl ? await PostgresStore.open(dbUrl) : new AsyncSqliteStore(resolve(dataDir, 'codeharbor.sqlite'));
  let app: ReturnType<typeof createApp> | undefined;
  try {
    app = createApp({
      dataDir, databasePath: resolve(dataDir, 'codeharbor.sqlite'), credentialKey: key,
      codeupEndpoint: endpoint, organizationId: process.env.YUNXIAO_ORGANIZATION_ID || undefined,
      allowedGitHosts, allowedHosts, allowedOrigins: list(process.env.CODEHARBOR_ALLOWED_ORIGINS),
      writeUsers: list(process.env.CODEHARBOR_WRITE_USERS), codegraphBin: platformCodegraph, metricsToken,
    }, { store });
    key.fill(0);
    await app.start();
    await app.listen({ port, host });
  } catch (error) {
    key.fill(0);
    if (app) await app.close().catch(() => {}); else await store.close().catch(() => {});
    throw error;
  }
  const runningApp = app;
  let stopping = false;
  async function shutdown() {
    if (stopping) return; stopping = true;
    try { await runningApp.close(); process.exitCode = 0; } catch { process.exitCode = 1; }
  }
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}
main().catch((error: unknown) => {
  // Only a fixed, non-secret-bearing summary reaches logs.
  const message = error instanceof Error && /^(YUNXIAO_ENDPOINT is required|Invalid PORT|CODEHARBOR_GIT_HOSTS must|PostgreSQL is required|Invalid PostgreSQL URL|Production PostgreSQL requires|Production requires|Configure only one database|Database URL file is unavailable)/.test(error.message)
    ? error.message : 'Startup failed; check database, key provider, and service configuration';
  console.error(message);
  process.exitCode = 1;
});
