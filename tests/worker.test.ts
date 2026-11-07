import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialCipher } from '../src/auth.js';
import type { CodeupClient } from '../src/codeup.js';
import type { CodeGraphClient } from '../src/codegraph.js';
import { Store } from '../src/store.js';
import { IndexWorker } from '../src/worker.js';

async function waitFor(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting for worker');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture() {
  const store = new Store(':memory:');
  const cipher = new CredentialCipher(Buffer.alloc(32, 1));
  store.createUser({ id: 'user', username: 'user', credential: cipher.encrypt('secret', 'user'), credential_version: 1 });
  store.createRepository({ id: 'repo_1', codeup_id: '123', name: 'repo', branch: 'main', owner: 'user', sync_owner: 'user', sync_credential_version: 1, hook_hash: 'hash', path: null, commit: null, indexed_at: null, status: 'pending', error: null });
  const codeup = {
    getRepository: async () => ({ id: '123', name: 'repo', path: 'repo', accessLevel: 30, cloneDownloadRestricted: false, httpUrlToRepo: 'https://git.example.com/repo' }),
    getCloneUsername: async () => 'user',
  } as unknown as CodeupClient;
  const graph = { withExclusive: async (fn: (explore: () => Promise<string>) => Promise<void>) => fn(async () => 'ok') } as unknown as CodeGraphClient;
  return { store, cipher, codeup, graph };
}

test('coalesces queued work while preserving events during a build', async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let builds = 0;
  const worker = new IndexWorker({ ...f, dataDir: '/unused', allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => 'b'.repeat(40),
    build: async () => { builds++; await blocked; return { path: '/candidate', commit: 'b'.repeat(40), generation: 'v1' }; },
  });
  try {
    const first = worker.enqueue('repo_1', 'initial');
    assert.equal(worker.enqueue('repo_1', 'duplicate').id, first.id);
    worker.start();
    await waitFor(() => builds === 1);
    const next = worker.enqueue('repo_1', 'push');
    assert.notEqual(next.id, first.id);
    assert.equal(worker.enqueue('repo_1', 'duplicate').id, next.id);
    release();
    await waitFor(() => f.store.getJob(next.id)?.status === 'succeeded');
    assert.equal(builds, 1, 'unchanged remote HEAD does not rebuild');
    assert.equal(f.store.getRepository('repo_1')?.commit, 'b'.repeat(40));
    assert.equal(f.store.getRepository('repo_1')?.status, 'ready');
  } finally {
    release();
    await worker.stop();
    f.store.close();
  }
});

test('failed builds preserve the previous published index', async () => {
  const f = fixture();
  f.store.updateRepository('repo_1', { path: '/old', commit: 'a'.repeat(40), status: 'ready' });
  const worker = new IndexWorker({ ...f, dataDir: '/unused', allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => 'b'.repeat(40), build: async () => { throw new Error('secret internal error'); },
  });
  try {
    const job = worker.enqueue('repo_1', 'manual');
    worker.start();
    await waitFor(() => f.store.getJob(job.id)?.status === 'failed');
    assert.equal(f.store.getRepository('repo_1')?.path, '/old');
    assert.equal(f.store.getRepository('repo_1')?.commit, 'a'.repeat(40));
    assert.equal(f.store.getRepository('repo_1')?.status, 'stale');
    assert.equal(f.store.getJob(job.id)?.error, 'Index update failed');
  } finally {
    await worker.stop();
    f.store.close();
  }
});

test('branch deletion prevents in-flight candidate publication and removes it', async () => {
  const f = fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'codeharbor-worker-'));
  const generation = randomUUID();
  const candidate = join(dataDir, 'repositories', 'repo_1', 'versions', generation, 'worktree');
  await mkdir(candidate, { recursive: true });
  f.store.updateRepository('repo_1', { path: '/old', commit: 'a'.repeat(40), status: 'ready' });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let building = false;
  const worker = new IndexWorker({ ...f, dataDir, allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => 'b'.repeat(40),
    build: async () => { building = true; await blocked; return { path: candidate, commit: 'b'.repeat(40), generation }; },
  });
  try {
    const job = worker.enqueue('repo_1', 'push');
    worker.start();
    await waitFor(() => building);
    f.store.updateRepository('repo_1', { status: 'branch_deleted' });
    release();
    await waitFor(() => f.store.getJob(job.id)?.status === 'failed');
    await waitFor(() => f.store.getRepository('repo_1')?.status === 'branch_deleted');
    await worker.stop();
    assert.equal(f.store.getRepository('repo_1')?.path, '/old');
    await assert.rejects(access(candidate));
    const recovery = worker.enqueue('repo_1', 'push');
    assert.equal(recovery.status, 'queued');
    assert.equal(f.store.getRepository('repo_1')?.status, 'updating');
  } finally {
    release();
    await worker.stop();
    f.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('new push after branch deletion reuses queued work and resumes the repository', async () => {
  const f = fixture();
  const worker = new IndexWorker({ ...f, dataDir: '/unused', allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => 'a'.repeat(40), build: async () => ({ path: '/candidate', commit: 'a'.repeat(40), generation: 'v1' }),
  });
  try {
    const job = worker.enqueue('repo_1', 'push');
    f.store.updateRepository('repo_1', { status: 'branch_deleted', error: 'BRANCH_DELETED' });
    assert.equal(worker.enqueue('repo_1', 'webhook').id, job.id);
    assert.equal(f.store.getRepository('repo_1')?.status, 'pending');
    worker.start();
    await waitFor(() => f.store.getJob(job.id)?.status === 'succeeded');
    assert.equal(f.store.getRepository('repo_1')?.status, 'ready');
  } finally {
    await worker.stop();
    f.store.close();
  }
});

test('new PAT version requires explicit authorization before use for synchronization', async () => {
  const f = fixture();
  let calls = 0;
  const codeup = {
    getRepository: async () => { calls++; return { id: '123', name: 'repo', path: 'repo', accessLevel: 30, cloneDownloadRestricted: false, httpUrlToRepo: 'https://git.example.com/repo' }; },
    getCloneUsername: async () => 'user',
  } as unknown as CodeupClient;
  const worker = new IndexWorker({ ...f, codeup, dataDir: '/unused', allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => 'a'.repeat(40), build: async () => ({ path: '/candidate', commit: 'a'.repeat(40), generation: 'v1' }),
  });
  try {
    f.store.updateUserCredential('user', 'user', f.cipher.encrypt('new-secret', 'user'));
    const job = worker.enqueue('repo_1', 'push');
    worker.start();
    await waitFor(() => f.store.getJob(job.id)?.status === 'failed');
    assert.equal(calls, 0);
    assert.equal(f.store.getRepository('repo_1')?.status, 'credential_required');
    f.store.updateRepository('repo_1', { sync_credential_version: 2 });
    const retry = worker.enqueue('repo_1', 'reauthorized');
    await waitFor(() => f.store.getJob(retry.id)?.status === 'succeeded');
    assert.equal(calls, 1);
    assert.equal(f.store.getRepository('repo_1')?.status, 'ready');
  } finally {
    await worker.stop();
    f.store.close();
  }
});

test('PAT rotation during indexing blocks publication', async () => {
  const f = fixture();
  let release!: () => void;
  let building = false;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const worker = new IndexWorker({ ...f, dataDir: '/unused', allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => 'b'.repeat(40), build: async () => { building = true; await blocked; return { path: '/candidate', commit: 'b'.repeat(40), generation: 'v1' }; },
  });
  try {
    const job = worker.enqueue('repo_1', 'push');
    worker.start();
    await waitFor(() => building);
    f.store.updateUserCredential('user', 'user', f.cipher.encrypt('new-secret', 'user'));
    release();
    await waitFor(() => f.store.getJob(job.id)?.status === 'failed');
    assert.equal(f.store.getRepository('repo_1')?.path, null);
    assert.equal(f.store.getRepository('repo_1')?.status, 'credential_required');
  } finally {
    release();
    await worker.stop();
    f.store.close();
  }
});
