import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CredentialCipher, createAccessKey } from '../src/auth.js';
import { CODEGRAPH_TOOL_NAMES } from '../src/codegraph-tools.js';
import { ImageCodeGraphClient } from '../src/image-codegraph.js';
import { createInternalMcpHandler } from '../src/internal-mcp.js';
import { type AuditEvent, createApp } from '../src/server.js';
import { openTestStore } from './helpers/postgres.js';

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  return address.port;
}
async function ready(child: ChildProcess, base: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('MCP child exited before readiness');
    try {
      if ((await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(500) })).status === 200) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error('MCP child did not become ready');
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('MCP child did not stop'));
    }, 5000);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      code === 0 && signal === null ? resolveStop() : reject(new Error('MCP child failed'));
    });
    child.kill('SIGTERM');
  });
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

test('split MCP process shares platform authorization and publication locking', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codeharbor-split-process-'));
  const path = join(root, 'internal.sock');
  const serviceToken = randomBytes(32).toString('hex');
  const tokenFile = join(root, 'internal-token');
  await writeFile(tokenFile, serviceToken, { mode: 0o600 });
  const encryptionKey = randomBytes(32);
  const credential = 'fixture-private-pat';
  const cipher = new CredentialCipher(encryptionKey);
  const events: string[] = [];
  const gates = new Map<string, { started: ReturnType<typeof deferred>; finish: ReturnType<typeof deferred> }>();
  const graph = new ImageCodeGraphClient({
    async explore({ query }) {
      events.push(`start:${query}`);
      const gate = gates.get(query);
      if (gate) {
        gate.started.release();
        await gate.finish.promise;
      }
      events.push(`end:${query}`);
      return 'fixture-query-result';
    },
    async probe() {},
    async close() {},
  });
  let cloudCalls = 0;
  const fakeCodeup = {
    async getRepository() {
      cloudCalls++;
      throw new Error('Cloud must not be called for indexed queries');
    },
  };
  const audits: AuditEvent[] = [];
  const allowedHosts: string[] = [];
  const worker = { async stop() {}, async start() {} };
  const db = await openTestStore();
  const app = createApp(
    {
      dataDir: root,
      credentialKey: encryptionKey,
      codeupEndpoint: 'https://devops.example',
      allowedGitHosts: ['git.example'],
      allowedHosts,
      writeUsers: [],
      codegraphBin: 'codegraph',
      publicMcpDisabled: true,
    },
    {
      store: db.store,
      codeup: fakeCodeup as never,
      graph: graph as never,
      worker: worker as never,
      probe: async () => {
        cloudCalls++;
        throw new Error('Clone probe must not run for indexed queries');
      },
      audit: (event) => audits.push(event),
    },
  );
  let internal: Awaited<ReturnType<typeof createInternalMcpHandler>> | undefined;
  let child: ChildProcess | undefined;
  let appClosed = false;
  const clients: Client[] = [];
  try {
    await app.store.createUser({
      id: 'owner',
      username: 'owner',
      credential: cipher.encrypt(credential, 'owner'),
      credential_version: 1,
    });
    const repoId = 'repo1';
    await app.store.createRepository({
      id: repoId,
      codeup_id: '123',
      name: 'fixture',
      branch: 'main',
      owner: 'owner',
      sync_owner: 'owner',
      sync_credential_version: 1,
      hook_hash: 'hook',
      path: `oci://sha256:${'a'.repeat(64)}`,
      commit: 'b'.repeat(40),
      indexed_at: Date.now(),
      status: 'ready',
      error: null,
    });
    const key1 = createAccessKey();
    const key2 = createAccessKey();
    for (const key of [key1, key2])
      await app.store.createKey({
        ...key,
        owner: 'owner',
        scope: 'read',
        repos: [repoId],
        expires_at: null,
        revoked: 0,
      });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const platformAddress = app.server.address();
    assert.ok(platformAddress && typeof platformAddress !== 'string');
    allowedHosts.push(`127.0.0.1:${platformAddress.port}`);
    assert.equal((await fetch(`http://127.0.0.1:${platformAddress.port}/mcp`)).status, 404);
    internal = await createInternalMcpHandler({ path, token: serviceToken, backend: app.internalMcp });
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['--import', 'tsx', resolve('src/mcp-main.ts')], {
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH,
        HOME: root,
        PORT: String(port),
        CODEHARBOR_BIND: '127.0.0.1',
        CODEHARBOR_ALLOWED_HOSTS: `127.0.0.1:${port}`,
        CODEHARBOR_INTERNAL_MCP_SOCKET: path,
        CODEHARBOR_INTERNAL_MCP_TOKEN_FILE: tokenFile,
        CODEHARBOR_MCP_READY_CACHE_MS: '1',
      },
    });
    await ready(child, base);
    assert.equal((await fetch(`${base}/api/v1/repositories`)).status, 404);
    assert.equal((await fetch(`${base}/docs`)).status, 404);
    const badHost = await new Promise<number | undefined>((resolveStatus, reject) => {
      httpRequest(`${base}/health/live`, { headers: { host: 'other.example' } }, (response) => {
        response.resume();
        resolveStatus(response.statusCode);
      })
        .on('error', reject)
        .end();
    });
    assert.equal(badHost, 403);
    async function clientFor(token: string): Promise<Client> {
      const client = new Client({ name: 'split-process-test', version: '1' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    }
    const first = await clientFor(key1.token);
    assert.deepEqual(
      (await first.listTools()).tools.map((tool) => tool.name),
      ['list_repositories', 'get_repository_status', ...CODEGRAPH_TOOL_NAMES],
    );
    assert.match(JSON.stringify(await first.callTool({ name: 'list_repositories', arguments: {} })), /fixture/);
    assert.match(
      JSON.stringify(await first.callTool({ name: 'get_repository_status', arguments: { repo_id: repoId } })),
      /fixture/,
    );
    assert.match(
      JSON.stringify(
        await first.callTool({ name: 'codegraph_explore', arguments: { repo_id: repoId, query: 'normal' } }),
      ),
      /fixture-query-result/,
    );

    const keyGate = { started: deferred(), finish: deferred() };
    gates.set('key-revoke', keyGate);
    const keyQuery = first.callTool({ name: 'codegraph_explore', arguments: { repo_id: repoId, query: 'key-revoke' } });
    await keyGate.started.promise;
    await app.store.revokeKey(key1.hash);
    keyGate.finish.release();
    const keyResult = await keyQuery;
    assert.equal(keyResult.isError, true);
    assert.doesNotMatch(JSON.stringify(keyResult), /fixture-query-result/);

    const second = await clientFor(key2.token);
    const disableGate = { started: deferred(), finish: deferred() };
    gates.set('repository-disabled', disableGate);
    const disabledQuery = second.callTool({
      name: 'codegraph_explore',
      arguments: { repo_id: repoId, query: 'repository-disabled' },
    });
    await disableGate.started.promise;
    await app.store.updateRepository(repoId, { status: 'disabled' });
    disableGate.finish.release();
    const disabledResult = await disabledQuery;
    assert.equal(disabledResult.isError, true);
    assert.doesNotMatch(JSON.stringify(disabledResult), /fixture-query-result/);
    await app.store.updateRepository(repoId, { status: 'ready' });

    const parallelAKey = createAccessKey();
    const parallelBKey = createAccessKey();
    for (const [owner, id, cloudId, image, commit, key] of [
      ['parallel-a', 'repo-a', '124', 'c', 'd', parallelAKey],
      ['parallel-b', 'repo-b', '125', 'e', 'f', parallelBKey],
    ] as const) {
      await app.store.createUser({
        id: owner,
        username: owner,
        credential: cipher.encrypt(credential, owner),
        credential_version: 1,
      });
      await app.store.createRepository({
        id,
        codeup_id: cloudId,
        name: id,
        branch: 'main',
        owner,
        sync_owner: owner,
        sync_credential_version: 1,
        hook_hash: 'hook',
        path: `oci://sha256:${image.repeat(64)}`,
        commit: commit.repeat(40),
        indexed_at: Date.now(),
        status: 'ready',
        error: null,
      });
      await app.store.createKey({ ...key, owner, scope: 'read', repos: [id], expires_at: null, revoked: 0 });
    }
    const parallelA = await clientFor(parallelAKey.token);
    const parallelB = await clientFor(parallelBKey.token);
    const gateA = { started: deferred(), finish: deferred() };
    const gateB = { started: deferred(), finish: deferred() };
    gates.set('parallel-a', gateA);
    gates.set('parallel-b', gateB);
    const queryA = parallelA.callTool({
      name: 'codegraph_explore',
      arguments: { repo_id: 'repo-a', query: 'parallel-a' },
    });
    const queryB = parallelB.callTool({
      name: 'codegraph_explore',
      arguments: { repo_id: 'repo-b', query: 'parallel-b' },
    });
    // Reaching both barriers proves independent users and repositories run concurrently.
    await Promise.all([gateA.started.promise, gateB.started.promise]);
    await app.store.revokeKey(parallelAKey.hash);
    gateA.finish.release();
    const resultA = await queryA;
    assert.equal(resultA.isError, true);
    assert.doesNotMatch(JSON.stringify(resultA), /fixture-query-result/);
    gateB.finish.release();
    const resultB = await queryB;
    assert.notEqual(resultB.isError, true);
    assert.match(JSON.stringify(resultB), /fixture-query-result/);

    const lockGate = { started: deferred(), finish: deferred() };
    gates.set('publish-lock', lockGate);
    const lockQuery = second.callTool({
      name: 'codegraph_explore',
      arguments: { repo_id: repoId, query: 'publish-lock' },
    });
    await lockGate.started.promise;
    let published = false;
    const publish = graph.withExclusive(async () => {
      events.push('publish');
      published = true;
    });
    assert.equal(published, false);
    lockGate.finish.release();
    assert.match(JSON.stringify(await lockQuery), /fixture-query-result/);
    await publish;
    assert.deepEqual(events.slice(-3), ['start:publish-lock', 'end:publish-lock', 'publish']);

    await internal.close();
    internal = undefined;
    await app.close();
    appClosed = true;
    assert.equal((await fetch(`${base}/health/ready`)).status, 503);
    assert.equal(
      (await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key2.token}` } })).status,
      503,
    );
    const serializedAudit = JSON.stringify(audits);
    assert.doesNotMatch(serializedAudit, /fixture-private-pat|fixture-query-result/);
    assert.ok(
      !serializedAudit.includes(key1.token) &&
        !serializedAudit.includes(parallelAKey.token) &&
        !serializedAudit.includes(parallelBKey.token) &&
        !serializedAudit.includes(serviceToken),
    );
    assert.equal(cloudCalls, 0);
  } finally {
    for (const gate of gates.values()) gate.finish.release();
    for (const client of clients) await client.close().catch(() => {});
    if (child)
      await stop(child).catch(() => {
        child?.kill('SIGKILL');
      });
    await internal?.close().catch(() => {});
    if (!appClosed) {
      await app.close();
      appClosed = true;
    }
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
