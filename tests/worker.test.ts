import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialCipher } from '../src/auth.js';
import type { CodeupClient } from '../src/codeup.js';
import type { CodeGraphClient } from '../src/codegraph.js';
import { Store } from '../src/store.js';
import { AsyncSqliteStore } from '../src/async-store.js';
import { IndexWorker } from '../src/worker.js';
import { IndexError } from '../src/indexer.js';

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
  } as unknown as CodeupClient;
  const graph = { withExclusive: async (fn: (explore: () => Promise<string>) => Promise<void>) => fn(async () => 'ok') } as unknown as CodeGraphClient;
  return { store, workerStore: new AsyncSqliteStore(store), cipher, codeup, graph, probe: async () => true };
}

test('uses the bound login username for Git PAT authentication', async () => {
  const f = fixture();
  f.store.updateUserCredential('user', 'login-name', f.cipher.encrypt('secret', 'user'));
  f.store.updateRepository('repo_1', { sync_credential_version: 2 });
  let gitUsername: string | undefined;
  const worker = new IndexWorker({ ...f, store: f.workerStore, dataDir: '/unused', allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async request => { gitUsername = request.gitUsername; return 'a'.repeat(40); },
    build: async () => ({ path: '/candidate', commit: 'a'.repeat(40), generation: 'v1' }),
  });
  try {
    const job = await worker.enqueue('repo_1', 'initial');
    await worker.start();
    await waitFor(() => f.store.getJob(job.id)?.status === 'succeeded');
    assert.equal(gitUsername, 'login-name');
  } finally {
    await worker.stop();
    f.store.close();
  }
});

test('coalesces queued work while preserving events during a build', async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let builds = 0;
  const worker = new IndexWorker({ ...f, store: f.workerStore, dataDir: '/unused', allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => 'b'.repeat(40),
    healthy: async () => true,
    build: async () => { builds++; await blocked; return { path: '/candidate', commit: 'b'.repeat(40), generation: 'v1' }; },
  });
  try {
    const first = await worker.enqueue('repo_1', 'initial');
    assert.equal((await worker.enqueue('repo_1', 'duplicate')).id, first.id);
    await worker.start();
    await waitFor(() => builds === 1);
    const next = await worker.enqueue('repo_1', 'push');
    assert.notEqual(next.id, first.id);
    assert.equal((await worker.enqueue('repo_1', 'duplicate')).id, next.id);
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
  const worker = new IndexWorker({ ...f, store: f.workerStore, dataDir: '/unused', allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => 'b'.repeat(40), build: async () => { throw new Error('secret internal error'); },
  });
  try {
    const job = await worker.enqueue('repo_1', 'manual');
    await worker.start();
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

test('image publication records the previously published image and commit atomically', async () => {
  const f = fixture();
  const previous = `oci://sha256:${'a'.repeat(64)}`;
  const next = `oci://sha256:${'b'.repeat(64)}`;
  const oldCommit = 'c'.repeat(40); const newCommit = 'd'.repeat(40);
  f.store.updateRepository('repo_1', { path: previous, commit: oldCommit, status: 'ready' });
  const worker = new IndexWorker({ ...f, store: f.workerStore, dataDir: '/unused', allowedGitHosts:['git.example.com'], reconcileIntervalMs:0,
    head:async () => newCommit, build:async () => ({path:next, commit:newCommit, generation:'v1'}),
  });
  try {
    const job = await worker.enqueue('repo_1', 'manual'); await worker.start();
    await waitFor(() => f.store.getJob(job.id)?.status === 'succeeded');
    const record = f.store.getRepository('repo_1')!;
    assert.equal(record.path, next); assert.equal(record.commit, newCommit);
    assert.equal(record.previous_image, previous); assert.equal(record.previous_commit, oldCommit);
  } finally { await worker.stop(); f.store.close(); }
});

test('worktree migration is not recorded as a previous image and failed image updates retain history', async () => {
  const f = fixture();
  const next = `oci://sha256:${'b'.repeat(64)}`; const nextCommit = 'd'.repeat(40);
  f.store.updateRepository('repo_1', { path:'/old/worktree', commit:'a'.repeat(40), status:'ready' });
  let fail = false;
  const worker = new IndexWorker({ ...f, store:f.workerStore, dataDir:'/unused', allowedGitHosts:['git.example.com'], reconcileIntervalMs:0,
    head:async () => fail ? 'e'.repeat(40) : nextCommit,
    build:async () => { if (fail) throw new Error('test failure'); return {path:next, commit:nextCommit, generation:'v1'}; },
  });
  try {
    const initial = await worker.enqueue('repo_1', 'migration'); await worker.start();
    await waitFor(() => f.store.getJob(initial.id)?.status === 'succeeded');
    assert.equal(f.store.getRepository('repo_1')?.previous_image, null);
    assert.equal(f.store.getRepository('repo_1')?.previous_commit, null);
    const older = `oci://sha256:${'f'.repeat(64)}`; const olderCommit = '1'.repeat(40);
    f.store.updateRepository('repo_1', {previous_image:older, previous_commit:olderCommit});
    fail = true;
    const failed = await worker.enqueue('repo_1', 'manual');
    await waitFor(() => f.store.getJob(failed.id)?.status === 'failed');
    const record = f.store.getRepository('repo_1')!;
    assert.equal(record.path, next); assert.equal(record.commit, nextCommit);
    assert.equal(record.previous_image, older); assert.equal(record.previous_commit, olderCommit);
  } finally { await worker.stop(); f.store.close(); }
});

test('rebuilding the same image does not overwrite the prior version', async () => {
  const f = fixture();
  const current = `oci://sha256:${'b'.repeat(64)}`; const currentCommit = 'c'.repeat(40);
  const previous = `oci://sha256:${'d'.repeat(64)}`; const previousCommit = 'e'.repeat(40);
  f.store.updateRepository('repo_1', { path:current, commit:currentCommit, previous_image:previous, previous_commit:previousCommit, status:'ready' });
  const worker = new IndexWorker({ ...f, store:f.workerStore, dataDir:'/unused', allowedGitHosts:['git.example.com'], reconcileIntervalMs:0,
    head:async () => currentCommit, healthy:async () => false,
    build:async () => ({path:current, commit:currentCommit, generation:'v1'}),
  });
  try {
    const job = await worker.enqueue('repo_1', 'manual'); await worker.start();
    await waitFor(() => f.store.getJob(job.id)?.status === 'succeeded');
    const record = f.store.getRepository('repo_1')!;
    assert.equal(record.previous_image, previous); assert.equal(record.previous_commit, previousCommit);
  } finally { await worker.stop(); f.store.close(); }
});

test('a newer branch head during image construction prevents publishing the older image', async () => {
  const f = fixture();
  f.store.updateRepository('repo_1', { path: '/old', commit: 'a'.repeat(40), status: 'ready' });
  let heads = 0;
  let allowRetry!: () => void;
  const retryBlocked = new Promise<void>(resolve => { allowRetry = resolve; });
  let builds = 0;
  const worker = new IndexWorker({ ...f, store: f.workerStore, dataDir: '/unused', allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => ++heads === 1 ? 'b'.repeat(40) : 'c'.repeat(40),
    build: async () => {
      if (++builds > 1) await retryBlocked;
      return { path: `oci://sha256:${'d'.repeat(64)}`, commit: builds === 1 ? 'b'.repeat(40) : 'c'.repeat(40), generation: 'v1' };
    },
  });
  try {
    const job = await worker.enqueue('repo_1', 'manual');
    await worker.start();
    await waitFor(() => f.store.getJob(job.id)?.status === 'failed' && builds > 1);
    assert.equal(f.store.getRepository('repo_1')?.path, '/old');
    assert.equal(f.store.getRepository('repo_1')?.commit, 'a'.repeat(40));
    allowRetry();
    await waitFor(() => f.store.getRepository('repo_1')?.commit === 'c'.repeat(40));
  } finally { allowRetry(); await worker.stop(); f.store.close(); }
});

test('revoked clone permission after indexing blocks publication', async () => {
  const f = fixture(); let probes = 0;
  const worker = new IndexWorker({ ...f, store: f.workerStore, dataDir: '/unused', allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    probe: async request => { assert.equal(request.token, 'secret'); return ++probes === 1; },
    head: async () => 'b'.repeat(40), build: async () => ({ path: '/candidate', commit: 'b'.repeat(40), generation: 'v1' }),
  });
  try {
    const job = await worker.enqueue('repo_1', 'initial'); await worker.start();
    await waitFor(() => f.store.getJob(job.id)?.status === 'failed');
    assert.equal(probes, 2);
    assert.equal(f.store.getRepository('repo_1')?.path, null);
    assert.equal(f.store.getRepository('repo_1')?.status, 'credential_required');
  } finally { await worker.stop(); f.store.close(); }
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
  const worker = new IndexWorker({ ...f, store: f.workerStore, dataDir, allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => 'b'.repeat(40),
    build: async () => { building = true; await blocked; return { path: candidate, commit: 'b'.repeat(40), generation }; },
  });
  try {
    const job = await worker.enqueue('repo_1', 'push');
    await worker.start();
    await waitFor(() => building);
    f.store.updateRepository('repo_1', { status: 'branch_deleted' });
    release();
    await waitFor(() => f.store.getJob(job.id)?.status === 'failed');
    await waitFor(() => f.store.getRepository('repo_1')?.status === 'branch_deleted');
    await worker.stop();
    assert.equal(f.store.getRepository('repo_1')?.path, '/old');
    await assert.rejects(access(candidate));
    const recovery = await worker.enqueue('repo_1', 'push');
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
  const worker = new IndexWorker({ ...f, store: f.workerStore, dataDir: '/unused', allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => 'a'.repeat(40), build: async () => ({ path: '/candidate', commit: 'a'.repeat(40), generation: 'v1' }),
  });
  try {
    const job = await worker.enqueue('repo_1', 'push');
    f.store.updateRepository('repo_1', { status: 'branch_deleted', error: 'BRANCH_DELETED' });
    assert.equal((await worker.enqueue('repo_1', 'webhook')).id, job.id);
    assert.equal(f.store.getRepository('repo_1')?.status, 'pending');
    await worker.start();
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
  } as unknown as CodeupClient;
  const worker = new IndexWorker({ ...f, store: f.workerStore, codeup, dataDir: '/unused', allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => 'a'.repeat(40), build: async () => ({ path: '/candidate', commit: 'a'.repeat(40), generation: 'v1' }),
  });
  try {
    f.store.updateUserCredential('user', 'user', f.cipher.encrypt('new-secret', 'user'));
    const job = await worker.enqueue('repo_1', 'push');
    await worker.start();
    await waitFor(() => f.store.getJob(job.id)?.status === 'failed');
    assert.equal(calls, 0);
    assert.equal(f.store.getRepository('repo_1')?.status, 'credential_required');
    f.store.updateRepository('repo_1', { sync_credential_version: 2 });
    const retry = await worker.enqueue('repo_1', 'reauthorized');
    await waitFor(() => f.store.getJob(retry.id)?.status === 'succeeded');
    assert.equal(calls, 2);
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
  const worker = new IndexWorker({ ...f, store: f.workerStore, dataDir: '/unused', allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => 'b'.repeat(40), build: async () => { building = true; await blocked; return { path: '/candidate', commit: 'b'.repeat(40), generation: 'v1' }; },
  });
  try {
    const job = await worker.enqueue('repo_1', 'push');
    await worker.start();
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

test('unchanged HEAD rebuilds when the published index is missing', async () => {
  const f = fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'codeharbor-missing-'));
  const commit = 'a'.repeat(40);
  const missing = join(dataDir, 'repositories', 'repo_1', 'versions', randomUUID(), 'worktree');
  f.store.updateRepository('repo_1', { path: missing, commit, status: 'ready' });
  let builds = 0;
  const worker = new IndexWorker({ ...f, store: f.workerStore, dataDir, allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => commit,
    build: async () => { builds++; return { path: '/replacement', commit, generation: 'v1' }; },
  });
  try {
    const job = await worker.enqueue('repo_1', 'reconcile');
    await worker.start();
    await waitFor(() => f.store.getJob(job.id)?.status === 'succeeded');
    assert.equal(builds, 1);
    assert.equal(f.store.getRepository('repo_1')?.path, '/replacement');
  } finally {
    await worker.stop();
    f.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('branch deletion is retained while old work runs and later reconciliation recovers', async () => {
  const f = fixture();
  let release!: () => void;
  let building = false;
  let missing = false;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const commit = 'a'.repeat(40);
  const worker = new IndexWorker({ ...f, store: f.workerStore, dataDir: '/unused', allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => { if (missing) throw new IndexError('BRANCH_NOT_FOUND', 'Remote branch does not exist'); return commit; },
    build: async () => { building = true; await blocked; return { path: '/candidate', commit, generation: 'v1' }; },
  });
  try {
    const oldJob = await worker.enqueue('repo_1', 'initial');
    await worker.start();
    await waitFor(() => building);
    f.store.updateRepository('repo_1', { status: 'branch_deleted' });
    missing = true;
    const check = await worker.enqueue('repo_1', 'reconcile');
    assert.equal(f.store.getRepository('repo_1')?.status, 'branch_deleted');
    release();
    await waitFor(() => f.store.getJob(check.id)?.status === 'failed');
    assert.equal(f.store.getJob(oldJob.id)?.status, 'failed');
    assert.equal(f.store.getRepository('repo_1')?.status, 'branch_deleted');
    assert.equal(f.store.getRepository('repo_1')?.path, null);
    missing = false;
    const retry = await worker.enqueue('repo_1', 'reconcile');
    await waitFor(() => f.store.getJob(retry.id)?.status === 'succeeded');
    assert.equal(f.store.getRepository('repo_1')?.status, 'ready');
    assert.equal(f.store.getRepository('repo_1')?.commit, commit);
  } finally {
    release();
    await worker.stop();
    f.store.close();
  }
});

test('publishing retains current and previous owned versions after draining queries', async () => {
  const f = fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'codeharbor-retention-'));
  const root = join(dataDir, 'repositories', 'repo_1', 'versions');
  async function version(owned: boolean): Promise<{ id: string; path: string }> {
    const id = randomUUID();
    const dir = join(root, id);
    await mkdir(join(dir, 'worktree'), { recursive: true });
    if (owned) await writeFile(join(dir, '.codeharbor-generation.json'), JSON.stringify({ version: 1, repositoryId: 'repo_1', generation: id }));
    return { id, path: join(dir, 'worktree') };
  }
  const old = await version(true);
  const previous = await version(true);
  const current = await version(true);
  const unknown = await version(false);
  f.store.updateRepository('repo_1', { path: previous.path, commit: 'a'.repeat(40), status: 'ready' });
  let validatedUnderExclusive = false;
  const graph = {
    withExclusive: async (fn: (explore: () => Promise<string>) => Promise<void>) => {
      // Real adapter closes the old shared connection before entering the callback.
      await fn(async () => { validatedUnderExclusive = true; return 'ok'; });
      await assert.rejects(access(old.path));
      await access(previous.path);
      await access(current.path);
    },
  } as unknown as CodeGraphClient;
  const worker = new IndexWorker({ ...f, store: f.workerStore, graph, dataDir, allowedGitHosts: ['git.example.com'], reconcileIntervalMs: 0,
    head: async () => 'b'.repeat(40),
    build: async () => ({ path: current.path, commit: 'b'.repeat(40), generation: current.id }),
  });
  try {
    const job = await worker.enqueue('repo_1', 'push');
    await worker.start();
    await waitFor(() => f.store.getJob(job.id)?.status === 'succeeded');
    await worker.stop();
    assert.equal(validatedUnderExclusive, true);
    assert.equal(f.store.getRepository('repo_1')?.path, current.path);
    await assert.rejects(access(old.path));
    await access(previous.path);
    await access(current.path);
    await access(unknown.path);
  } finally {
    await worker.stop();
    f.store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
