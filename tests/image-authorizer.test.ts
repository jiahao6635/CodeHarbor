import { strict as assert } from 'node:assert';
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveImageAuthorizer, SocketImageAuthorizer } from '../src/image-authorizer.js';

const token = 'sample-test-authorizer-token-0123456789';
const digest = `sha256:${'a'.repeat(64)}`;
const repoId = 'repository_1';
const commit = 'b'.repeat(40);

async function raw(path: string, message: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(path); let data = '';
    socket.once('connect', () => socket.write(message));
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.once('error', reject); socket.once('close', () => resolve(data));
  });
}

test('private authorization validates token and exact repository image identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ch-auth-')); const path = join(dir, 'auth.sock');
  const calls: string[][] = [];
  const server = await serveImageAuthorizer({ path, token, authorize: async (id, repo, rev) => {
    calls.push([id, repo, rev]); return id === digest && repo === repoId && rev === commit;
  } });
  try {
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    const client = new SocketImageAuthorizer(path, token);
    assert.equal(await client.authorize(digest, repoId, commit), true);
    assert.equal(await client.authorize(digest, 'another', commit), false);
    assert.equal(await client.authorize('invalid', repoId, commit), false);
    assert.equal(await new SocketImageAuthorizer(path, `${token}wrong`).authorize(digest, repoId, commit), false);
    assert.match(await raw(path, `${JSON.stringify({ token, digest, repoId, commit, extra: true })}\n`), /"allowed":false/);
    assert.equal(await raw(path, `${'x'.repeat(5000)}\n`), '');
    assert.deepEqual(calls, [[digest, repoId, commit], [digest, 'another', commit]]);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('denies on callback error, deadline, cancellation, or missing controller', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ch-auth-')); const path = join(dir, 'auth.sock');
  const server = await serveImageAuthorizer({ path, token, timeoutMs: 100, authorize: async (_id, repo, _rev, signal) => {
    if (repo === 'throw') throw new Error('private error');
    return await new Promise<boolean>(resolve => signal.addEventListener('abort', () => resolve(true), { once: true }));
  } });
  try {
    const client = new SocketImageAuthorizer(path, token, 30);
    assert.equal(await client.authorize(digest, 'throw', commit), false);
    assert.equal(await client.authorize(digest, repoId, commit), false);
    const controller = new AbortController(); controller.abort();
    assert.equal(await client.authorize(digest, repoId, commit, controller.signal), false);
  } finally { await server.close(); }
  assert.equal(await new SocketImageAuthorizer(path, token, 30).authorize(digest, repoId, commit), false);
  await rm(dir, { recursive: true, force: true });
});

test('rejects unsafe socket directory and invalid configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ch-auth-'));
  try {
    assert.throws(() => new SocketImageAuthorizer('relative.sock', token));
    assert.throws(() => new SocketImageAuthorizer(join(dir, 'a.sock'), 'short'));
    await chmod(dir, 0o777);
    await assert.rejects(serveImageAuthorizer({ path: join(dir, 'auth.sock'), token, authorize: async () => true }), /Unsafe/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('authorizer accepts 32 parallel queries without dropping connections', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ch-auth-parallel-')); const path = join(dir, 'auth.sock');
  let entered!: () => void; let release!: () => void; let active = 0;
  const allEntered = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = await serveImageAuthorizer({ path, token, authorize: async () => {
    if (++active === 32) entered();
    await gate; return true;
  } });
  const client = new SocketImageAuthorizer(path, token, 5000);
  const pending = Array.from({ length: 32 }, () => client.authorize(digest, repoId, commit));
  try {
    await allEntered; release();
    assert.deepEqual(await Promise.all(pending), Array.from({ length: 32 }, () => true));
  } finally { release(); await Promise.allSettled(pending); await server.close(); await rm(dir, { recursive: true, force: true }); }
});
