import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloneProbeGate, checkCloneAccess } from '../src/clone-access.js';
import type { IndexRequest } from '../src/indexer.js';

test('clone authorization gate grants queued callers in FIFO order and bounds the queue', async () => {
  const gate = new CloneProbeGate(2, 2, 1000);
  const first = await gate.acquire();
  const second = await gate.acquire();
  const order: number[] = [];
  const third = gate.acquire().then(release => { order.push(3); return release; });
  const fourth = gate.acquire().then(release => { order.push(4); return release; });
  await assert.rejects(gate.acquire(), (error: any) => error.code === 'AUTH_BUSY');
  assert.deepEqual(order, []);
  first(); first();
  const releaseThird = await third;
  assert.deepEqual(order, [3]);
  releaseThird();
  const releaseFourth = await fourth;
  assert.deepEqual(order, [3, 4]);
  releaseFourth(); second();
  const final = await gate.acquire(); final();
});

test('timed out and cancelled waiters release queue space without consuming a permit', async () => {
  const gate = new CloneProbeGate(1, 2, 25);
  const active = await gate.acquire();
  const cancel = new AbortController();
  const cancelled = gate.acquire(cancel.signal);
  const timedOut = gate.acquire();
  cancel.abort();
  await assert.rejects(cancelled, (error: any) => error.code === 'AUTH_UNAVAILABLE');
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(timedOut, (error: any) => error.code === 'AUTH_BUSY'); }
  finally { clearTimeout(keepAlive); }
  const next = gate.acquire();
  active();
  const release = await next;
  release();
  const final = await gate.acquire(); final();
});

test('real clone probes wait in order and a failed probe releases the next permit', async () => {
  const originalFetch = globalThis.fetch;
  const started: string[] = [];
  const pending = new Map<string, { resolve: (value: Response) => void; reject: (error: Error) => void }>();
  globalThis.fetch = ((input: string | URL | Request) => new Promise<Response>((resolve, reject) => {
    const id = new URL(String(input)).pathname.split('/')[1];
    started.push(id); pending.set(id, { resolve, reject });
  })) as typeof fetch;
  const request = (id: string): IndexRequest => ({ dataDir: '/tmp', repositoryId: id, branch: 'main',
    cloneUrl: `https://git.example/${id}.git`, allowedGitHosts: ['git.example'], gitUsername: 'alice', token: 'test-pat' });
  try {
    const first = checkCloneAccess(request('first'));
    const second = checkCloneAccess(request('second'));
    const third = checkCloneAccess(request('third'));
    const fourth = checkCloneAccess(request('fourth'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['first.git', 'second.git']);
    pending.get('first.git')!.reject(new Error('network unavailable'));
    await assert.rejects(first, (error: any) => error.code === 'AUTH_UNAVAILABLE');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['first.git', 'second.git', 'third.git']);
    pending.get('third.git')!.resolve(new Response(null, { status: 403 }));
    assert.equal(await third, false);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['first.git', 'second.git', 'third.git', 'fourth.git']);
    pending.get('second.git')!.resolve(new Response(null, { status: 403 }));
    pending.get('fourth.git')!.resolve(new Response(null, { status: 403 }));
    assert.equal(await second, false);
    assert.equal(await fourth, false);
  } finally { globalThis.fetch = originalFetch; }
});

test('cancelling a running probe and a queued caller does not consume capacity', async () => {
  const originalFetch = globalThis.fetch;
  const started: string[] = [];
  const pending = new Map<string, (value: Response) => void>();
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const id = new URL(String(input)).pathname.split('/')[1];
    started.push(id); pending.set(id, resolve);
    init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  })) as typeof fetch;
  const request = (id: string): IndexRequest => ({ dataDir: '/tmp', repositoryId: id, branch: 'main',
    cloneUrl: `https://git.example/${id}.git`, allowedGitHosts: ['git.example'], gitUsername: 'alice', token: 'test-pat' });
  try {
    const runningController = new AbortController();
    const queuedController = new AbortController();
    const first = checkCloneAccess(request('first'), runningController.signal);
    const second = checkCloneAccess(request('second'));
    const cancelled = checkCloneAccess(request('cancelled'), queuedController.signal);
    const next = checkCloneAccess(request('next'));
    await new Promise<void>(resolve => setImmediate(resolve));
    queuedController.abort();
    await assert.rejects(cancelled, (error: any) => error.code === 'AUTH_UNAVAILABLE');
    runningController.abort();
    await assert.rejects(first, (error: any) => error.code === 'AUTH_UNAVAILABLE');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['first.git', 'second.git', 'next.git']);
    pending.get('second.git')!(new Response(null, { status: 403 }));
    pending.get('next.git')!(new Response(null, { status: 403 }));
    assert.equal(await second, false);
    assert.equal(await next, false);
  } finally { globalThis.fetch = originalFetch; }
});
