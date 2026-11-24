import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CredentialCipher, createAccessKey } from '../src/auth.js';
import { CodeupError } from '../src/codeup.js';
import { createInternalMcpHandler } from '../src/internal-mcp.js';
import type { AuditEvent } from '../src/server.js';
import { createLegacyTestApp as createApp } from './helpers/legacy-auth.js';
import { openTestStore } from './helpers/postgres.js';

function send(path: string, data: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path });
    let buffer = '';
    socket.once('connect', () => socket.write(`${JSON.stringify(data)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
    });
    socket.once('end', () => {
      try {
        resolve(JSON.parse(buffer));
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

test('private MCP socket recovers from a killed process without replacing an active listener', {
  timeout: 10_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ch-internal-recovery-'));
  const path = join(dir, 'rpc.sock');
  const secret = 'x'.repeat(40);
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const net=require('node:net'); const fs=require('node:fs'); net.createServer().listen(process.argv[1],()=>{fs.chmodSync(process.argv[1],0o600); process.stdout.write('ready\\n')})",
      path,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const backend = {
    async probe() {
      return true as const;
    },
    async authenticate() {
      return false;
    },
    async list() {
      return [];
    },
    async get() {
      return null;
    },
    async explore() {
      return null;
    },
  };
  let ipc: Awaited<ReturnType<typeof createInternalMcpHandler>> | undefined;
  try {
    await Promise.race([
      once(child.stdout!, 'data'),
      once(child, 'exit').then(() => {
        throw new Error('Socket child exited');
      }),
    ]);
    child.kill('SIGKILL');
    await once(child, 'exit');
    assert.ok(lstatSync(path).isSocket(), 'SIGKILL left the original socket entry');
    ipc = await createInternalMcpHandler({ path, token: secret, backend });
    assert.deepEqual(await send(path, { op: 'probe', token: secret }), { ok: true, result: true });
    const inode = lstatSync(path).ino;
    await assert.rejects(createInternalMcpHandler({ path, token: secret, backend }), /socket is active/);
    assert.equal(lstatSync(path).ino, inode);
    assert.deepEqual(await send(path, { op: 'probe', token: secret }), { ok: true, result: true });
  } finally {
    child.kill('SIGKILL');
    await ipc?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('private MCP socket recovery rejects unsafe directory, file and symlink without modifying them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ch-internal-unsafe-'));
  const path = join(dir, 'rpc.sock');
  const secret = 'x'.repeat(40);
  const backend = {
    async probe() {
      return true as const;
    },
    async authenticate() {
      return false;
    },
    async list() {
      return [];
    },
    async get() {
      return null;
    },
    async explore() {
      return null;
    },
  };
  try {
    chmodSync(dir, 0o755);
    await assert.rejects(
      createInternalMcpHandler({ path, token: secret, backend }),
      /Unsafe internal MCP socket directory/,
    );
    chmodSync(dir, 0o700);
    writeFileSync(path, 'preserve');
    await assert.rejects(createInternalMcpHandler({ path, token: secret, backend }), /Unsafe internal MCP socket/);
    assert.equal(readFileSync(path, 'utf8'), 'preserve');
    unlinkSync(path);
    const target = join(dir, 'target');
    writeFileSync(target, 'preserve');
    symlinkSync(target, path);
    await assert.rejects(createInternalMcpHandler({ path, token: secret, backend }), /Unsafe internal MCP socket/);
    assert.ok(lstatSync(path).isSymbolicLink());
    assert.equal(readFileSync(target, 'utf8'), 'preserve');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('private MCP IPC requires both credentials and rechecks authorization around queries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ch-internal-'));
  const path = join(dir, 'rpc.sock');
  const secret = 'x'.repeat(40);
  const key = randomBytes(32);
  const access = createAccessKey();
  const wrongKey = createAccessKey();
  const unscoped = createAccessKey();
  const otherRepo = createAccessKey();
  const expired = createAccessKey();
  let cloudCalls = 0;
  let permissionChecks = 0;
  let duringQuery: (() => Promise<void>) | undefined;
  let graphChecks = 0;
  const audit: AuditEvent[] = [];
  const graph = {
    async withQuery(fn: (explore: (...args: any[]) => Promise<unknown>) => Promise<unknown>) {
      return fn(async (_path: string, _query: string, signal: AbortSignal) => {
        assert.ok(!signal.aborted);
        await duringQuery?.();
        return { result: 'matching code' };
      });
    },
    async probe() {
      graphChecks++;
    },
    async close() {},
  };
  const db = await openTestStore();
  const app = createApp(
    {
      dataDir: dir,
      credentialKey: key,
      codeupEndpoint: 'https://devops.example',
      allowedGitHosts: ['git.example'],
      allowedHosts: [],
      writeUsers: [],
      codegraphBin: 'codegraph',
    },
    {
      store: db.store,
      graph: graph as never,
      worker: { async stop() {} } as never,
      // Self-scoped keys follow live Codeup permissions; explicitly scoped keys never consult the cloud.
      codeup: {
        async getRepository() {
          permissionChecks++;
          throw new CodeupError('not_found', 404);
        },
      } as never,
      probe: async () => {
        cloudCalls++;
        throw new Error('Clone probe must not run for indexed queries');
      },
      audit: (event) => audit.push(event),
    },
  );
  await app.store.createUser({
    id: 'alice',
    username: 'alice',
    credential: new CredentialCipher(key).encrypt('pat', 'alice'),
    credential_version: 1,
  });
  await app.store.createKey({
    hash: access.hash,
    prefix: access.prefix,
    owner: 'alice',
    scope: 'read',
    repos: ['repo1'],
    expires_at: null,
    revoked: 0,
  });
  await app.store.createKey({
    hash: unscoped.hash,
    prefix: unscoped.prefix,
    owner: 'alice',
    scope: 'read',
    repos: null,
    expires_at: null,
    revoked: 0,
  });
  await app.store.createKey({
    hash: otherRepo.hash,
    prefix: otherRepo.prefix,
    owner: 'alice',
    scope: 'read',
    repos: ['repo2'],
    expires_at: null,
    revoked: 0,
  });
  await app.store.createKey({
    hash: expired.hash,
    prefix: expired.prefix,
    owner: 'alice',
    scope: 'read',
    repos: ['repo1'],
    expires_at: Date.now() - 1,
    revoked: 0,
  });
  await app.store.createRepository({
    id: 'repo1',
    codeup_id: '11',
    name: 'repo',
    branch: 'main',
    owner: 'alice',
    sync_owner: 'alice',
    sync_credential_version: 1,
    hook_hash: 'hook',
    path: '/secret/internal/path',
    commit: 'a'.repeat(40),
    indexed_at: 1000,
    status: 'ready',
    error: null,
  });
  const ipc = await createInternalMcpHandler({ path, token: secret, backend: app.internalMcp });
  const request = (op: string, extra: Record<string, unknown> = {}) =>
    send(path, { op, token: secret, authorization: `Bearer ${access.token}`, ...extra });
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(await send(path, { op: 'probe', token: secret }), { ok: true, result: true });
    assert.equal(graphChecks, 1);
    assert.deepEqual(await send(path, { op: 'probe', token: 'not-the-token' }), { ok: false });
    assert.deepEqual(await request('authenticate'), { ok: true, result: true });
    assert.deepEqual(await request('authenticate', { authorization: `Bearer ${wrongKey.token}` }), {
      ok: true,
      result: false,
    });
    assert.deepEqual(await request('authenticate', { authorization: `Bearer ${expired.token}` }), {
      ok: true,
      result: false,
    });
    assert.deepEqual(await request('list', { authorization: `Bearer ${unscoped.token}` }), { ok: true, result: [] });
    assert.equal(permissionChecks, 1);
    assert.deepEqual(await request('get', { authorization: `Bearer ${unscoped.token}`, repoId: 'repo1' }), {
      ok: true,
      result: null,
    });
    assert.deepEqual(
      await request('explore', { authorization: `Bearer ${unscoped.token}`, repoId: 'repo1', query: 'query' }),
      { ok: true, result: null },
    );
    assert.deepEqual(await request('get', { authorization: `Bearer ${otherRepo.token}`, repoId: 'repo1' }), {
      ok: true,
      result: null,
    });
    assert.deepEqual(await request('list', { owner: 'alice' }), { ok: false });
    assert.deepEqual(await request('get', { repoId: '../repo1' }), { ok: false });
    assert.deepEqual(await request('explore', { repoId: 'repo1', query: 'query', projectPath: '/etc' }), { ok: false });
    const listed = await request('list');
    assert.equal(listed.result.length, 1);
    assert.equal(listed.result[0].repo_id, 'repo1');
    assert.ok(!JSON.stringify(listed).includes('/secret/internal/path'));
    assert.equal((await request('get', { repoId: 'repo1' })).result.repo_id, 'repo1');
    const queried = await request('explore', { repoId: 'repo1', query: 'find service' });
    assert.equal(queried.ok, true);
    assert.equal(queried.result.result.result, 'matching code');
    assert.ok(!JSON.stringify(queried).includes('/secret/internal/path'));
    assert.deepEqual(await request('get', { repoId: 'unknown' }), { ok: true, result: null });
    assert.equal(cloudCalls, 0);
    assert.equal(permissionChecks, 1);
    duringQuery = async () => {
      await app.store.updateRepository('repo1', { commit: 'b'.repeat(40) });
    };
    assert.deepEqual(await request('explore', { repoId: 'repo1', query: 'changed during query' }), {
      ok: true,
      result: null,
    });
    await app.store.updateRepository('repo1', { commit: 'a'.repeat(40) });
    duringQuery = async () => {
      await app.store.revokeKey(access.hash);
    };
    assert.deepEqual(await request('explore', { repoId: 'repo1', query: 'revoked during query' }), { ok: false });
    assert.deepEqual(await request('authenticate'), { ok: true, result: false });
    for (const tool of ['list_repositories', 'get_repository_status', 'codegraph_explore']) {
      assert.ok(
        audit.some(
          (event) =>
            event.tool === tool &&
            event.tool_outcome === 'success' &&
            event.subject === 'alice' &&
            event.key_prefix === access.prefix,
        ),
      );
    }
    assert.ok(
      audit.some(
        (event) =>
          event.tool === 'get_repository_status' && event.tool_outcome === 'error' && event.repo_id === 'unknown',
      ),
    );
    const auditText = JSON.stringify(audit);
    assert.ok(
      !auditText.includes(access.token) &&
        !auditText.includes(secret) &&
        !auditText.includes('find service') &&
        !auditText.includes('matching code') &&
        !auditText.includes('/secret/internal/path'),
    );
  } finally {
    await ipc.close();
    await app.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy public MCP can be disabled and removed from OpenAPI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ch-public-'));
  const allowedHosts: string[] = [];
  const db = await openTestStore();
  const app = createApp(
    {
      dataDir: dir,
      credentialKey: randomBytes(32),
      codeupEndpoint: 'https://devops.example',
      allowedGitHosts: ['git.example'],
      allowedHosts,
      writeUsers: [],
      codegraphBin: 'codegraph',
      publicMcpDisabled: true,
    },
    {
      store: db.store,
      graph: { async probe() {}, async close() {} } as never,
      worker: { async stop() {} } as never,
    },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  allowedHosts.push(`127.0.0.1:${address.port}`);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/mcp`)).status, 404);
    const doc = (await (await fetch(`http://127.0.0.1:${address.port}/openapi.json`)).json()) as any;
    assert.equal(Object.hasOwn(doc.paths, '/mcp'), false);
  } finally {
    await app.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
