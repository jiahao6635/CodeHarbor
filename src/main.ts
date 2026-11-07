import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.js';

const dataDir = resolve(process.env.CODEHARBOR_DATA_DIR ?? './data');
const endpoint = process.env.YUNXIAO_ENDPOINT;
const encodedKey = process.env.CODEHARBOR_MASTER_KEY;
if (!endpoint || !encodedKey) throw new Error('YUNXIAO_ENDPOINT and CODEHARBOR_MASTER_KEY are required');
const key = Buffer.from(encodedKey, 'base64');
if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== encodedKey.replace(/=+$/, '')) throw new Error('CODEHARBOR_MASTER_KEY must be a base64-encoded 32-byte key');
const host = process.env.CODEHARBOR_BIND ?? '127.0.0.1';
const port = Number(process.env.PORT ?? '8080');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const list = (s: string | undefined) => s?.split(',').map(x => x.trim()).filter(Boolean) ?? [];
const allowedGitHosts = list(process.env.CODEHARBOR_GIT_HOSTS);
if (!allowedGitHosts.length) throw new Error('CODEHARBOR_GIT_HOSTS must list trusted HTTPS Git hosts');
const allowedHosts = list(process.env.CODEHARBOR_ALLOWED_HOSTS);
if (!allowedHosts.length) allowedHosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const app = createApp({
  dataDir,
  databasePath: resolve(dataDir, 'codeharbor.sqlite'),
  credentialKey: key,
  codeupEndpoint: endpoint,
  organizationId: process.env.YUNXIAO_ORGANIZATION_ID || undefined,
  allowedGitHosts,
  allowedHosts,
  allowedOrigins: list(process.env.CODEHARBOR_ALLOWED_ORIGINS),
  writeUsers: list(process.env.CODEHARBOR_WRITE_USERS),
  codegraphBin: process.env.CODEGRAPH_BIN ?? resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules/.bin/codegraph'),
});
app.server.listen(port, host, () => { app.start(); console.log(`CodeHarbor listening on ${host}:${port}`); });
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  try { await app.close(); process.exitCode = 0; } catch { process.exitCode = 1; }
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
