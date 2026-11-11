import { strict as assert } from 'node:assert';
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { IMAGE_PROJECT_PATH, type ImageDigest, type ImageQueryBackend } from '../src/image-codegraph.js';
import { serveImageRuntime, SocketImageQueryBackend } from '../src/image-runtime-socket.js';

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
  const server = await serveImageRuntime({ path, token, backend: backend({
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
