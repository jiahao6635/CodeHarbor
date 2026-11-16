import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { SocketImageAuthorizer } from '../src/image-authorizer.js';
import { serveImageRuntime } from '../src/image-runtime-socket.js';
import { openPostgresStore } from '../src/postgres-store.js';
import type { StoreBackend } from '../src/store.js';
import { TEST_DATABASE_URL } from './helpers/postgres.js';

const baseUrl = TEST_DATABASE_URL;
const digest = `sha256:${'a'.repeat(64)}`;
const commit = 'b'.repeat(40);

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a test port');
  await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  return address.port;
}

async function waitForReady(child: ChildProcess, base: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Image-mode test service exited before readiness');
    try {
      const result = await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(500) });
      if (result.status === 200) {
        assert.deepEqual(await result.json(), { status: 'ok' });
        return;
      }
    } catch {
      /* The isolated server may still be starting. */
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error('Image-mode test service did not become ready');
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Image-mode test service did not stop'));
    }, 5_000);
    timer.unref();
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolveStop();
      else reject(new Error('Image-mode test service did not shut down cleanly'));
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Image-mode test service could not be stopped'));
    });
    child.kill('SIGTERM');
  });
}

test('image mode starts on PostgreSQL, authorizes published images, and restarts cleanly', {
  timeout: 45_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ch-main-'));
  const dataDir = join(root, 'data');
  const authDir = join(root, 'auth');
  const dbName = `codeharbor_main_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  let child: ChildProcess | undefined;
  let store: StoreBackend | undefined;
  let runtime: Awaited<ReturnType<typeof serveImageRuntime>> | undefined;
  let databaseCreated = false;
  let adminConnected = false;
  try {
    await admin.connect();
    adminConnected = true;
    await admin.query(`CREATE DATABASE "${dbName}"`);
    databaseCreated = true;
    const dbUrl = new URL(baseUrl);
    dbUrl.pathname = `/${dbName}`;
    store = await openPostgresStore(dbUrl.href);
    await store.createUser({
      id: 'user-1',
      username: 'test-user',
      credential: 'test-encrypted-value',
      credential_version: 1,
    });
    await store.createRepository({
      id: 'repo-1',
      codeup_id: '123',
      name: 'test-repository',
      branch: 'main',
      owner: 'user-1',
      sync_owner: 'user-1',
      sync_credential_version: 1,
      hook_hash: 'test-hash',
      path: `oci://${digest}`,
      commit,
      indexed_at: 123,
      status: 'ready',
      error: null,
    });
    await store.close();
    store = undefined;

    await mkdir(dataDir, { mode: 0o700 });
    await mkdir(authDir, { mode: 0o700 });
    const queryToken = randomBytes(32).toString('hex');
    const buildToken = randomBytes(32).toString('hex');
    const authToken = randomBytes(32).toString('hex');
    const queryFile = join(root, 'query-token');
    const buildFile = join(root, 'build-token');
    const authFile = join(root, 'auth-token');
    const dbFile = join(root, 'db-url');
    await Promise.all([
      writeFile(queryFile, queryToken, { mode: 0o600 }),
      writeFile(buildFile, buildToken, { mode: 0o600 }),
      writeFile(authFile, authToken, { mode: 0o600 }),
      writeFile(dbFile, dbUrl.href, { mode: 0o600 }),
    ]);
    const querySocket = join(root, 'q.sock');
    const authSocket = join(authDir, 'a.sock');
    let probeCount = 0;
    runtime = await serveImageRuntime({
      path: querySocket,
      token: queryToken,
      backend: {
        async probe() {
          probeCount++;
        },
        async close() {},
        async explore() {
          throw new Error('not used');
        },
      },
    });
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: root,
      NODE_ENV: 'test',
      PORT: String(port),
      CODEHARBOR_BIND: '127.0.0.1',
      CODEHARBOR_DATA_DIR: dataDir,
      CODEHARBOR_MASTER_KEY: randomBytes(32).toString('base64'),
      CODEHARBOR_DATABASE_URL_FILE: dbFile,
      CODEHARBOR_INDEX_BACKEND: 'image',
      CODEHARBOR_REPOSITORY_RUNTIME_IMAGE: `sha256:${'c'.repeat(64)}`,
      CODEHARBOR_IMAGE_QUERY_SOCKET: querySocket,
      CODEHARBOR_IMAGE_QUERY_TOKEN_FILE: queryFile,
      CODEHARBOR_IMAGE_BUILD_SOCKET: join(root, 'b.sock'),
      CODEHARBOR_IMAGE_BUILD_TOKEN_FILE: buildFile,
      CODEHARBOR_IMAGE_AUTH_SOCKET: authSocket,
      CODEHARBOR_IMAGE_AUTH_TOKEN_FILE: authFile,
      CODEGRAPH_BIN: process.execPath,
      YUNXIAO_ENDPOINT: 'https://codeup.example.invalid',
      CODEHARBOR_GIT_HOSTS: 'git.example.invalid',
    };
    const start = () => spawn(process.execPath, [resolve('dist/main.js')], { env, stdio: 'ignore' });
    const authorizer = new SocketImageAuthorizer(authSocket, authToken, 2_000);
    for (let run = 0; run < 2; run++) {
      child = start();
      await waitForReady(child, base);
      assert.equal((await lstat(authSocket)).isSocket(), true);
      assert.equal(await authorizer.authorize(digest, 'repo-1', commit), true);
      assert.equal(await authorizer.authorize(digest, 'repo-1', 'd'.repeat(40)), false);
      assert.equal(await authorizer.authorize(digest, 'another', commit), false);
      const connections = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [
        dbName,
      ]);
      assert.ok(connections.rows[0].n >= 1);
      await stop(child);
      child = undefined;
      await assert.rejects(lstat(authSocket), { code: 'ENOENT' });
    }
    assert.ok(probeCount >= 4, 'each start and readiness request probes the isolated runtime');
  } finally {
    if (child)
      await stop(child).catch(() => {
        child?.kill('SIGKILL');
      });
    await runtime?.close();
    await store?.close();
    if (databaseCreated) await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    if (adminConnected) await admin.end();
    await rm(root, { recursive: true, force: true });
  }
});
