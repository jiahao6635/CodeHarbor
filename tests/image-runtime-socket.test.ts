import { strict as assert } from 'node:assert';
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { IMAGE_PROJECT_PATH, type ImageDigest, type ImageQueryBackend } from '../src/image-codegraph.js';
import { serveImageRuntime, SocketImageQueryBackend } from '../src/image-runtime-socket.js';
import { ImageRuntimeCancelledError, ImageRuntimeRequestError, ImageRuntimeUncertainError } from '../src/image-runtime-errors.js';

const token = 'this-is-an-isolated-runtime-test-token';
const digest = `sha256:${'c'.repeat(64)}` as ImageDigest;
const identity = { repoId: 'repo_1', commit: 'd'.repeat(40) };
function backend(overrides: Partial<ImageQueryBackend> = {}): ImageQueryBackend {
  return { explore: async () => 'ok', probe: async () => {}, close: async () => {}, ...overrides };
}
async function raw(path: string, message: unknown): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(path); let text = '';
    socket.once('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', (chunk) => { text += chunk.toString(); });
    socket.once('error', reject); socket.once('close', () => resolve(text));
  });
}

test('Unix runtime accepts only authenticated, bounded fixed operations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-runtime-socket-'));
  const path = join(dir, 'runtime.sock'); let called = 0; let closes = 0;
  const server = await serveImageRuntime({ path, token, maxConcurrent: 2, backend: backend({
    explore: async (request) => { called++; assert.equal(request.projectPath, IMAGE_PROJECT_PATH); assert.equal(request.readOnlyRoot, true); assert.equal(request.repoId, identity.repoId); assert.equal(request.commit, identity.commit); return 'result'; },
    close: async () => { closes++; },
  }) });
  try {
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    const client = new SocketImageQueryBackend(path, token);
    assert.equal(await client.explore({ digest, ...identity, query: 'symbol', projectPath: IMAGE_PROJECT_PATH, readOnlyRoot: true, signal: new AbortController().signal }), 'result');
    await client.probe(new AbortController().signal);
    assert.match(await raw(path, { op: 'explore', token: 'wrong', digest, ...identity, query: 'symbol' }), /"ok":false/);
    assert.match(await raw(path, { op: 'explore', token, digest, ...identity, query: 'symbol', projectPath: '/elsewhere' }), /"ok":false/);
    assert.match(await raw(path, { op: 'explore', token, digest, query: 'symbol' }), /"ok":false/);
    assert.match(await raw(path, { op: 'explore', token, digest, repoId: identity.repoId, commit: 'bad', query: 'symbol' }), /"ok":false/);
    assert.match(await raw(path, { op: 'shell', token, digest, ...identity, query: 'symbol' }), /"ok":false/);
    assert.equal(await raw(path, { op: 'explore', token, digest, ...identity, query: 'x'.repeat(17000) }), '');
    assert.equal(called, 1);
    await client.close();
    assert.equal(closes, 1);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('disconnect cancels query and drain waits for backend cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-runtime-socket-'));
  const path = join(dir, 'runtime.sock'); let cancelled = false; let released = false;
  let enter!: () => void;
  const started = new Promise<void>((resolve) => { enter = resolve; });
  const server = await serveImageRuntime({ path, token, backend: backend({
    explore: async ({ signal }) => {
      enter();
      return await new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new Error('stopped')); }, { once: true }));
    },
    close: async () => { released = true; },
  }) });
  try {
    const client = new SocketImageQueryBackend(path, token); const controller = new AbortController();
    const result = client.explore({ digest, ...identity, query: 'symbol', projectPath: IMAGE_PROJECT_PATH, readOnlyRoot: true, signal: controller.signal });
    await started; controller.abort(); await assert.rejects(result);
    await client.close();
    assert.equal(cancelled, true); assert.equal(released, true);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('controller refuses a writable socket directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-runtime-socket-'));
  try {
    await chmod(dir, 0o777);
    await assert.rejects(serveImageRuntime({ path: join(dir, 'runtime.sock'), token, backend: backend() }), /Unsafe/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('two queries run concurrently; cancellation waits for its own cleanup without interrupting the other', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-runtime-parallel-'));
  const path = join(dir, 'runtime.sock');
  let startA!: () => void; let startB!: () => void; let releaseCleanup!: () => void; let releaseB!: () => void;
  const startedA = new Promise<void>(resolve => { startA = resolve; });
  const startedB = new Promise<void>(resolve => { startB = resolve; });
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const bGate = new Promise<void>(resolve => { releaseB = resolve; });
  let aCleanupStarted = false; let aCleanupComplete = false; let bAborted = false; let drains = 0;
  const server = await serveImageRuntime({ path, token, maxConcurrent: 2, backend: backend({
    explore: async ({ query, signal }) => {
      if (query === 'a') {
        startA();
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        aCleanupStarted = true; await cleanupGate; aCleanupComplete = true;
        throw new ImageRuntimeRequestError();
      }
      signal.addEventListener('abort', () => { bAborted = true; }, { once: true });
      startB(); await bGate; return 'result-b';
    },
    close: async () => { drains++; },
  }) });
  try {
    const client = new SocketImageQueryBackend(path, token, 1000);
    const controller = new AbortController();
    const request = (query: string, signal = new AbortController().signal) => client.explore({ digest, ...identity, query, projectPath: IMAGE_PROJECT_PATH, readOnlyRoot: true, signal });
    const a = request('a', controller.signal); const b = request('b');
    await Promise.all([startedA, startedB]);
    await client.probe(new AbortController().signal);
    await assert.rejects(request('third'), ImageRuntimeRequestError);
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(aCleanupStarted, true);
    assert.equal(aCleanupComplete, false);
    let settled = false; void a.catch(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false);
    assert.equal(bAborted, false);
    releaseCleanup();
    await assert.rejects(a, ImageRuntimeCancelledError);
    assert.equal(aCleanupComplete, true);
    releaseB(); assert.equal(await b, 'result-b');
    assert.equal(bAborted, false); assert.equal(drains, 0);
  } finally { releaseCleanup(); releaseB(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const limit of [10, 17, 32]) test(`runtime admits ${limit} simultaneous queries and leaves room for probes`, { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-runtime-limit-'));
  const path = join(dir, 'runtime.sock');
  let entered!: () => void; let release!: () => void; let active = 0;
  const allEntered = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = await serveImageRuntime({ path, token, ...(limit === 10 ? {} : { maxConcurrent: limit }), backend: backend({
    explore: async () => { if (++active === limit) entered(); await gate; return 'ok'; },
  }) });
  const client = new SocketImageQueryBackend(path, token, 5000);
  const request = () => client.explore({ digest, ...identity, query: 'symbol', projectPath: IMAGE_PROJECT_PATH, readOnlyRoot: true, signal: new AbortController().signal });
  const pending = Array.from({ length: limit }, request);
  try {
    await allEntered;
    await client.probe(new AbortController().signal);
    await assert.rejects(request(), ImageRuntimeRequestError);
    release();
    assert.deepEqual(await Promise.all(pending), Array.from({ length: limit }, () => 'ok'));
  } finally { release(); await Promise.allSettled(pending); await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a disconnected or malformed cleanup response is uncertain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-runtime-uncertain-'));
  const path = join(dir, 'runtime.sock');
  let mode: 'malformed' | 'disconnect' | 'timeout' = 'malformed';
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.once('data', () => {
      if (mode === 'malformed') socket.end('{"ok":false}\n');
      if (mode === 'disconnect') socket.destroy();
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    const client = new SocketImageQueryBackend(path, token, 50);
    const request = () => client.explore({ digest, ...identity, query: 'x', projectPath: IMAGE_PROJECT_PATH, readOnlyRoot: true, signal: new AbortController().signal });
    await assert.rejects(request(), ImageRuntimeUncertainError);
    mode = 'disconnect'; await assert.rejects(request(), ImageRuntimeUncertainError);
    mode = 'timeout'; await assert.rejects(request(), ImageRuntimeUncertainError);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('controller reports uncertain cleanup without claiming successful cancellation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-runtime-failure-'));
  const path = join(dir, 'runtime.sock');
  const server = await serveImageRuntime({ path, token, backend: backend({ explore: async () => { throw new ImageRuntimeUncertainError(); } }) });
  try {
    const client = new SocketImageQueryBackend(path, token);
    await assert.rejects(client.explore({ digest, ...identity, query: 'x', projectPath: IMAGE_PROJECT_PATH, readOnlyRoot: true, signal: new AbortController().signal }), ImageRuntimeUncertainError);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
