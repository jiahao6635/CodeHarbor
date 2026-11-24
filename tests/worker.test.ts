import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CredentialCipher } from '../src/auth.js';
import type { CodeGraphClient } from '../src/codegraph.js';
import type { CodeupClient } from '../src/codeup.js';
import { IndexError } from '../src/indexer.js';
import { IndexWorker } from '../src/worker.js';
import { openTestStore } from './helpers/postgres.js';

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Timed out waiting for worker');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const { store, close } = await openTestStore();
  const cipher = new CredentialCipher(Buffer.alloc(32, 1));
  await store.createUser({
    id: 'user',
    username: 'user',
    credential: cipher.encrypt('secret', 'user'),
    credential_version: 1,
  });
  await store.createRepository({
    id: 'repo_1',
    codeup_id: '123',
    name: 'repo',
    branch: 'main',
    owner: 'user',
    sync_owner: 'user',
    sync_credential_version: 1,
    hook_hash: 'hash',
    path: null,
    commit: null,
    indexed_at: null,
    status: 'pending',
    error: null,
  });
  const codeup = {
    getRepository: async () => ({
      id: '123',
      name: 'repo',
      path: 'repo',
      accessLevel: 30,
      cloneDownloadRestricted: false,
      httpUrlToRepo: 'https://git.example.com/repo',
    }),
  } as unknown as CodeupClient;
  const graph = {
    withExclusive: async (fn: (explore: () => Promise<string>) => Promise<void>) => fn(async () => 'ok'),
  } as unknown as CodeGraphClient;
  return { store, cipher, codeup, graph, probe: async () => true, close };
}

test('uses the bound login username for Git PAT authentication', async () => {
  const f = await fixture();
  await f.store.updateUserCredential('user', 'login-name', f.cipher.encrypt('secret', 'user'));
  await f.store.updateRepository('repo_1', { sync_credential_version: 2 });
  let gitUsername: string | undefined;
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async (request) => {
      gitUsername = request.gitUsername;
      return 'a'.repeat(40);
    },
    build: async () => ({ path: '/candidate', commit: 'a'.repeat(40), generation: 'v1' }),
  });
  try {
    const job = await worker.enqueue('repo_1', 'initial');
    await worker.start();
    await waitFor(async () => (await f.store.getJob(job.id))?.status === 'succeeded');
    assert.equal(gitUsername, 'login-name');
  } finally {
    await worker.stop();
    await f.close();
  }
});

test('coalesces queued work while preserving events during a build', async () => {
  const f = await fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let builds = 0;
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => 'b'.repeat(40),
    healthy: async () => true,
    build: async (request) => {
      await request.onProgress?.('cloning');
      await request.onProgress?.('indexing');
      builds++;
      await blocked;
      return { path: '/candidate', commit: 'b'.repeat(40), generation: 'v1' };
    },
  });
  try {
    const first = await worker.enqueue('repo_1', 'initial');
    assert.equal(first.phase, 'queued');
    assert.equal((await worker.enqueue('repo_1', 'duplicate')).id, first.id);
    await worker.start();
    await waitFor(() => builds === 1);
    assert.equal((await f.store.getJob(first.id))?.phase, 'indexing');
    const next = await worker.enqueue('repo_1', 'push');
    assert.notEqual(next.id, first.id);
    assert.equal((await worker.enqueue('repo_1', 'duplicate')).id, next.id);
    release();
    await waitFor(async () => (await f.store.getJob(next.id))?.status === 'succeeded');
    assert.equal(builds, 1, 'unchanged remote HEAD does not rebuild');
    assert.equal((await f.store.getRepository('repo_1'))?.commit, 'b'.repeat(40));
    assert.equal((await f.store.getRepository('repo_1'))?.status, 'ready');
    assert.ok((await f.store.getJob(first.id))?.finished_at);
    assert.equal((await f.store.getJob(first.id))?.phase, 'complete');
    assert.ok(((await f.store.getJob(first.id))?.build_duration_ms ?? -1) >= 0);
    assert.ok((await f.store.getJob(next.id))?.finished_at);
    assert.equal((await f.store.getJob(next.id))?.phase, 'complete');
    assert.equal((await f.store.getJob(next.id))?.build_duration_ms, null, 'no-op reconcile has no build sample');
  } finally {
    release();
    await worker.stop();
    await f.close();
  }
});

test('failed builds preserve the previous published index', async () => {
  const f = await fixture();
  await f.store.updateRepository('repo_1', { path: '/old', commit: 'a'.repeat(40), status: 'ready' });
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => 'b'.repeat(40),
    build: async (request) => {
      await request.onProgress?.('indexing');
      throw new Error('secret internal error');
    },
  });
  try {
    const job = await worker.enqueue('repo_1', 'manual');
    await worker.start();
    await waitFor(async () => (await f.store.getJob(job.id))?.status === 'failed');
    assert.equal((await f.store.getRepository('repo_1'))?.path, '/old');
    assert.equal((await f.store.getRepository('repo_1'))?.commit, 'a'.repeat(40));
    assert.equal((await f.store.getRepository('repo_1'))?.status, 'stale');
    assert.equal((await f.store.getJob(job.id))?.error, 'Index update failed');
    assert.equal((await f.store.getJob(job.id))?.phase, 'indexing');
    assert.ok((await f.store.getJob(job.id))?.finished_at);
    assert.ok(((await f.store.getJob(job.id))?.build_duration_ms ?? -1) >= 0, 'failed builds retain a duration');
  } finally {
    await worker.stop();
    await f.close();
  }
});

test('restarting an interrupted job resets queue time and clears the interrupted attempt', async () => {
  const f = await fixture();
  const old = Date.now() - 60_000;
  await f.store.createJob({
    id: 'interrupted',
    repo_id: 'repo_1',
    status: 'running',
    phase: 'indexing',
    reason: 'initial',
    created_at: old,
    queued_at: old,
    finished_at: old,
    build_duration_ms: 123,
    error: null,
  });
  let release!: () => void;
  let building = false;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => 'a'.repeat(40),
    build: async () => {
      building = true;
      await blocked;
      return { path: '/candidate', commit: 'a'.repeat(40), generation: 'v1' };
    },
  });
  try {
    await worker.start();
    await waitFor(() => building);
    const job = await f.store.getJob('interrupted');
    assert.equal(job?.created_at, old);
    assert.ok((job?.queued_at ?? 0) > old);
    assert.equal(job?.finished_at, null);
    assert.equal(job?.build_duration_ms, null);
    assert.equal(job?.phase, 'validating');
    release();
    await waitFor(async () => (await f.store.getJob('interrupted'))?.status === 'succeeded');
    assert.ok(((await f.store.getJob('interrupted'))?.build_duration_ms ?? -1) >= 0);
  } finally {
    release();
    await worker.stop();
    await f.close();
  }
});

test('a disabled sync owner cannot publish an in-flight job or start another build', async () => {
  const f = await fixture();
  let builds = 0;
  const worker = new IndexWorker({
    ...f,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => 'a'.repeat(40),
    build: async () => {
      builds++;
      await f.store.updateAccount('account', { status: 'disabled' });
      return { path: '/candidate', commit: 'a'.repeat(40), generation: 'v1' };
    },
  });
  try {
    await f.store.upsertFeishuAccount({
      id: 'account',
      feishu_tenant_key: 'tenant',
      feishu_open_id: 'open',
      name: 'Account',
      role: 'member',
    });
    await f.store.linkCodeupAccount('account', 'user');
    const interrupted = await worker.enqueue('repo_1', 'initial');
    await worker.start();
    await waitFor(async () => (await f.store.getJob(interrupted.id))?.status === 'failed');
    assert.equal((await f.store.getJob(interrupted.id))?.phase, 'publishing');
    assert.equal((await f.store.getRepository('repo_1'))?.path, null);

    const rejected = await worker.enqueue('repo_1', 'manual');
    await waitFor(async () => (await f.store.getJob(rejected.id))?.status === 'failed');
    assert.equal((await f.store.getJob(rejected.id))?.phase, 'validating');
    assert.equal(builds, 1);
  } finally {
    await worker.stop();
    await f.close();
  }
});

test('image publication records the previously published image and commit atomically', async () => {
  const f = await fixture();
  const previous = `oci://sha256:${'a'.repeat(64)}`;
  const next = `oci://sha256:${'b'.repeat(64)}`;
  const oldCommit = 'c'.repeat(40);
  const newCommit = 'd'.repeat(40);
  let released: { path: string; retained: string[] } | undefined;
  await f.store.updateRepository('repo_1', { path: previous, commit: oldCommit, status: 'ready' });
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => newCommit,
    build: async () => ({ path: next, commit: newCommit, generation: 'v1' }),
    releaseCandidate: (candidate, retained) => {
      released = { path: candidate.path, retained };
    },
  });
  try {
    const job = await worker.enqueue('repo_1', 'manual');
    await worker.start();
    await waitFor(async () => (await f.store.getJob(job.id))?.status === 'succeeded');
    const record = (await f.store.getRepository('repo_1'))!;
    assert.equal(record.path, next);
    assert.equal(record.commit, newCommit);
    assert.equal(record.previous_image, previous);
    assert.equal(record.previous_commit, oldCommit);
    await waitFor(() => !!released);
    assert.deepEqual(released, { path: next, retained: [next, previous] });
  } finally {
    await worker.stop();
    await f.close();
  }
});

test('worktree migration is not recorded as a previous image and failed image updates retain history', async () => {
  const f = await fixture();
  const next = `oci://sha256:${'b'.repeat(64)}`;
  const nextCommit = 'd'.repeat(40);
  await f.store.updateRepository('repo_1', { path: '/old/worktree', commit: 'a'.repeat(40), status: 'ready' });
  let fail = false;
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => (fail ? 'e'.repeat(40) : nextCommit),
    build: async () => {
      if (fail) throw new Error('test failure');
      return { path: next, commit: nextCommit, generation: 'v1' };
    },
  });
  try {
    const initial = await worker.enqueue('repo_1', 'migration');
    await worker.start();
    await waitFor(async () => (await f.store.getJob(initial.id))?.status === 'succeeded');
    assert.equal((await f.store.getRepository('repo_1'))?.previous_image, null);
    assert.equal((await f.store.getRepository('repo_1'))?.previous_commit, null);
    const older = `oci://sha256:${'f'.repeat(64)}`;
    const olderCommit = '1'.repeat(40);
    await f.store.updateRepository('repo_1', { previous_image: older, previous_commit: olderCommit });
    fail = true;
    const failed = await worker.enqueue('repo_1', 'manual');
    await waitFor(async () => (await f.store.getJob(failed.id))?.status === 'failed');
    const record = (await f.store.getRepository('repo_1'))!;
    assert.equal(record.path, next);
    assert.equal(record.commit, nextCommit);
    assert.equal(record.previous_image, older);
    assert.equal(record.previous_commit, olderCommit);
  } finally {
    await worker.stop();
    await f.close();
  }
});

test('rebuilding the same image does not overwrite the prior version', async () => {
  const f = await fixture();
  const current = `oci://sha256:${'b'.repeat(64)}`;
  const currentCommit = 'c'.repeat(40);
  const previous = `oci://sha256:${'d'.repeat(64)}`;
  const previousCommit = 'e'.repeat(40);
  await f.store.updateRepository('repo_1', {
    path: current,
    commit: currentCommit,
    previous_image: previous,
    previous_commit: previousCommit,
    status: 'ready',
  });
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => currentCommit,
    healthy: async () => false,
    build: async () => ({ path: current, commit: currentCommit, generation: 'v1' }),
  });
  try {
    const job = await worker.enqueue('repo_1', 'manual');
    await worker.start();
    await waitFor(async () => (await f.store.getJob(job.id))?.status === 'succeeded');
    const record = (await f.store.getRepository('repo_1'))!;
    assert.equal(record.previous_image, previous);
    assert.equal(record.previous_commit, previousCommit);
  } finally {
    await worker.stop();
    await f.close();
  }
});

test('a newer branch head during image construction prevents publishing the older image', async () => {
  const f = await fixture();
  await f.store.updateRepository('repo_1', { path: '/old', commit: 'a'.repeat(40), status: 'ready' });
  let heads = 0;
  let allowRetry!: () => void;
  const retryBlocked = new Promise<void>((resolve) => {
    allowRetry = resolve;
  });
  let builds = 0;
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => (++heads === 1 ? 'b'.repeat(40) : 'c'.repeat(40)),
    build: async () => {
      if (++builds > 1) await retryBlocked;
      return {
        path: `oci://sha256:${'d'.repeat(64)}`,
        commit: builds === 1 ? 'b'.repeat(40) : 'c'.repeat(40),
        generation: 'v1',
      };
    },
  });
  try {
    const job = await worker.enqueue('repo_1', 'manual');
    await worker.start();
    await waitFor(async () => (await f.store.getJob(job.id))?.status === 'failed' && builds > 1);
    assert.equal((await f.store.getRepository('repo_1'))?.path, '/old');
    assert.equal((await f.store.getRepository('repo_1'))?.commit, 'a'.repeat(40));
    allowRetry();
    await waitFor(async () => (await f.store.getRepository('repo_1'))?.commit === 'c'.repeat(40));
  } finally {
    allowRetry();
    await worker.stop();
    await f.close();
  }
});

test('revoked clone permission after indexing blocks publication', async () => {
  const f = await fixture();
  let probes = 0;
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    probe: async (request) => {
      assert.equal(request.token, 'secret');
      return ++probes === 1;
    },
    head: async () => 'b'.repeat(40),
    build: async () => ({ path: '/candidate', commit: 'b'.repeat(40), generation: 'v1' }),
  });
  try {
    const job = await worker.enqueue('repo_1', 'initial');
    await worker.start();
    await waitFor(async () => (await f.store.getJob(job.id))?.status === 'failed');
    assert.equal(probes, 2);
    assert.equal((await f.store.getRepository('repo_1'))?.path, null);
    assert.equal((await f.store.getRepository('repo_1'))?.status, 'credential_required');
  } finally {
    await worker.stop();
    await f.close();
  }
});

test('branch deletion prevents in-flight candidate publication and removes it', async () => {
  const f = await fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'codeharbor-worker-'));
  const generation = randomUUID();
  const candidate = join(dataDir, 'repositories', 'repo_1', 'versions', generation, 'worktree');
  await mkdir(candidate, { recursive: true });
  await f.store.updateRepository('repo_1', { path: '/old', commit: 'a'.repeat(40), status: 'ready' });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let building = false;
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    dataDir,
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => 'b'.repeat(40),
    build: async () => {
      building = true;
      await blocked;
      return { path: candidate, commit: 'b'.repeat(40), generation };
    },
  });
  try {
    const job = await worker.enqueue('repo_1', 'push');
    await worker.start();
    await waitFor(() => building);
    await f.store.updateRepository('repo_1', { status: 'branch_deleted' });
    release();
    await waitFor(async () => (await f.store.getJob(job.id))?.status === 'failed');
    await waitFor(async () => (await f.store.getRepository('repo_1'))?.status === 'branch_deleted');
    await worker.stop();
    assert.equal((await f.store.getRepository('repo_1'))?.path, '/old');
    await assert.rejects(access(candidate));
    const recovery = await worker.enqueue('repo_1', 'push');
    assert.equal(recovery.status, 'queued');
    assert.equal((await f.store.getRepository('repo_1'))?.status, 'updating');
  } finally {
    release();
    await worker.stop();
    await f.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('new push after branch deletion reuses queued work and resumes the repository', async () => {
  const f = await fixture();
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => 'a'.repeat(40),
    build: async () => ({ path: '/candidate', commit: 'a'.repeat(40), generation: 'v1' }),
  });
  try {
    const job = await worker.enqueue('repo_1', 'push');
    await f.store.updateRepository('repo_1', { status: 'branch_deleted', error: 'BRANCH_DELETED' });
    assert.equal((await worker.enqueue('repo_1', 'webhook')).id, job.id);
    assert.equal((await f.store.getRepository('repo_1'))?.status, 'pending');
    await worker.start();
    await waitFor(async () => (await f.store.getJob(job.id))?.status === 'succeeded');
    assert.equal((await f.store.getRepository('repo_1'))?.status, 'ready');
  } finally {
    await worker.stop();
    await f.close();
  }
});

test('new PAT version requires explicit authorization before use for synchronization', async () => {
  const f = await fixture();
  let calls = 0;
  const codeup = {
    getRepository: async () => {
      calls++;
      return {
        id: '123',
        name: 'repo',
        path: 'repo',
        accessLevel: 30,
        cloneDownloadRestricted: false,
        httpUrlToRepo: 'https://git.example.com/repo',
      };
    },
  } as unknown as CodeupClient;
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    codeup,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => 'a'.repeat(40),
    build: async () => ({ path: '/candidate', commit: 'a'.repeat(40), generation: 'v1' }),
  });
  try {
    await f.store.updateUserCredential('user', 'user', f.cipher.encrypt('new-secret', 'user'));
    const job = await worker.enqueue('repo_1', 'push');
    await worker.start();
    await waitFor(async () => (await f.store.getJob(job.id))?.status === 'failed');
    assert.equal(calls, 0);
    assert.equal((await f.store.getRepository('repo_1'))?.status, 'credential_required');
    await f.store.updateRepository('repo_1', { sync_credential_version: 2 });
    const retry = await worker.enqueue('repo_1', 'reauthorized');
    await waitFor(async () => (await f.store.getJob(retry.id))?.status === 'succeeded');
    assert.equal(calls, 2);
    assert.equal((await f.store.getRepository('repo_1'))?.status, 'ready');
  } finally {
    await worker.stop();
    await f.close();
  }
});

test('reconciliation applies each repository interval to persisted job history without stacking pending work', async (t) => {
  const f = await fixture();
  const minute = 60_000;
  const start = Math.floor(Date.now() / minute) * minute;
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const worker = new IndexWorker({
    ...f,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 12 * minute,
  });
  const reconcile = async (minutes: number) => {
    now = start + minutes * minute;
    await (worker as unknown as { reconcile(): Promise<void> }).reconcile();
  };
  const history = async (repoId: string) => (await f.store.listJobs(repoId)).map((job) => job.reason);
  try {
    const original = await f.store.getRepository('repo_1');
    assert.ok(original);
    await f.store.createRepository({ ...original, id: 'short_repo', codeup_id: '456', sync_interval_minutes: 5 });
    await f.store.createRepository({ ...original, id: 'busy_repo', codeup_id: '789', sync_interval_minutes: 5 });
    for (const repoId of ['repo_1', 'short_repo', 'busy_repo']) {
      await f.store.createJob({
        id: `${repoId}-previous-job`,
        repo_id: repoId,
        reason: 'initial',
        status: repoId === 'busy_repo' ? 'running' : 'succeeded',
        created_at: repoId === 'busy_repo' ? start - 60 * minute : start + 1,
        error: null,
      });
    }

    await reconcile(4);
    assert.deepEqual(await history('short_repo'), ['initial']);
    await reconcile(5);
    assert.deepEqual(await history('short_repo'), ['initial', 'reconcile']);
    const firstCheck = (await f.store.listJobs('short_repo')).at(-1);
    assert.ok(firstCheck);
    await f.store.updateJob(firstCheck.id, { status: 'succeeded', finished_at: now });
    await reconcile(9);
    assert.deepEqual(await history('short_repo'), ['initial', 'reconcile']);
    await reconcile(10);
    assert.deepEqual(await history('short_repo'), ['initial', 'reconcile', 'reconcile']);
    await reconcile(11);
    assert.deepEqual(await history('repo_1'), ['initial']);
    await reconcile(12);
    assert.deepEqual(await history('repo_1'), ['initial', 'reconcile']);
    assert.deepEqual(await history('short_repo'), ['initial', 'reconcile', 'reconcile']);
    assert.deepEqual(await history('busy_repo'), ['initial']);
  } finally {
    await worker.stop();
    await f.close();
  }
});

test('reconciliation skips repositories awaiting credentials and resumes after explicit authorization', async () => {
  const f = await fixture();
  let builds = 0;
  const worker = new IndexWorker({
    ...f,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => 'a'.repeat(40),
    healthy: async () => true,
    build: async () => {
      builds++;
      return { path: '/candidate', commit: 'a'.repeat(40), generation: 'v1' };
    },
  });
  try {
    const original = (await f.store.getRepository('repo_1'))!;
    await f.store.createRepository({ ...original, id: 'active_repo', codeup_id: '456', status: 'ready' });
    await f.store.createRepository({ ...original, id: 'disabled_repo', codeup_id: '789', status: 'disabled' });
    await f.store.updateUserCredential('user', 'user', f.cipher.encrypt('new-secret', 'user'));
    await f.store.updateRepository('active_repo', { sync_credential_version: 2 });
    await f.store.updateRepository('repo_1', {
      status: 'credential_required',
      error: 'SYNC_AUTHORIZATION_REQUIRED',
      path: '/existing-index',
      commit: 'a'.repeat(40),
    });
    const awaiting = await f.store.getRepository('repo_1');

    // Exercise whole rounds deterministically without relying on wall-clock timers.
    const reconcile = () => (worker as unknown as { reconcile(): Promise<void> }).reconcile();
    await reconcile();
    await reconcile();
    assert.deepEqual(await f.store.getRepository('repo_1'), awaiting);
    assert.deepEqual(await f.store.listJobs('repo_1'), []);
    assert.deepEqual(await f.store.listJobs('disabled_repo'), []);
    assert.equal((await f.store.listJobs('active_repo')).length, 1);
    assert.equal((await f.store.listJobs('active_repo'))[0].reason, 'reconcile');

    // The explicit reauthorization path still works and re-enables later rounds.
    await f.store.updateRepository('repo_1', { sync_credential_version: 2 });
    const authorized = await worker.enqueue('repo_1', 'credential_changed');
    await worker.start();
    await waitFor(async () => (await f.store.getJob(authorized.id))?.status === 'succeeded');
    assert.equal((await f.store.getRepository('repo_1'))?.status, 'ready');
    await worker.stop();
    await reconcile();
    assert.ok((await f.store.listJobs('repo_1')).some((job) => job.reason === 'reconcile'));
    assert.equal(builds, 1); // Only the active repository needed a new index.
  } finally {
    await worker.stop();
    await f.close();
  }
});

test('reconciliation rechecks credentials after reading a stale repository list', async (t) => {
  const f = await fixture();
  const worker = new IndexWorker({
    ...f,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
  });
  try {
    const listRepositories = f.store.listRepositories.bind(f.store);
    t.mock.method(f.store, 'listRepositories', async () => {
      const snapshot = await listRepositories();
      // Simulate PAT rotation after the round's snapshot but before the enqueue transaction.
      await f.store.updateUserCredential('user', 'user', f.cipher.encrypt('new-secret', 'user'));
      await f.store.updateRepository('repo_1', {
        status: 'credential_required',
        error: 'SYNC_AUTHORIZATION_REQUIRED',
      });
      return snapshot;
    });
    await (worker as unknown as { reconcile(): Promise<void> }).reconcile();
    assert.deepEqual(await f.store.listJobs('repo_1'), []);
    assert.equal((await f.store.getRepository('repo_1'))?.status, 'credential_required');
    assert.equal((await f.store.getRepository('repo_1'))?.error, 'SYNC_AUTHORIZATION_REQUIRED');
  } finally {
    await worker.stop();
    await f.close();
  }
});

test('PAT rotation during indexing blocks publication', async () => {
  const f = await fixture();
  let release!: () => void;
  let building = false;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => 'b'.repeat(40),
    build: async () => {
      building = true;
      await blocked;
      return { path: '/candidate', commit: 'b'.repeat(40), generation: 'v1' };
    },
  });
  try {
    const job = await worker.enqueue('repo_1', 'push');
    await worker.start();
    await waitFor(() => building);
    await f.store.updateUserCredential('user', 'user', f.cipher.encrypt('new-secret', 'user'));
    release();
    await waitFor(async () => (await f.store.getJob(job.id))?.status === 'failed');
    assert.equal((await f.store.getRepository('repo_1'))?.path, null);
    assert.equal((await f.store.getRepository('repo_1'))?.status, 'credential_required');
  } finally {
    release();
    await worker.stop();
    await f.close();
  }
});

test('unchanged HEAD rebuilds when the published index is missing', async () => {
  const f = await fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'codeharbor-missing-'));
  const commit = 'a'.repeat(40);
  const missing = join(dataDir, 'repositories', 'repo_1', 'versions', randomUUID(), 'worktree');
  await f.store.updateRepository('repo_1', { path: missing, commit, status: 'ready' });
  let builds = 0;
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    dataDir,
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => commit,
    build: async () => {
      builds++;
      return { path: '/replacement', commit, generation: 'v1' };
    },
  });
  try {
    const job = await worker.enqueue('repo_1', 'reconcile');
    await worker.start();
    await waitFor(async () => (await f.store.getJob(job.id))?.status === 'succeeded');
    assert.equal(builds, 1);
    assert.equal((await f.store.getRepository('repo_1'))?.path, '/replacement');
  } finally {
    await worker.stop();
    await f.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('branch deletion is retained while old work runs and later reconciliation recovers', async () => {
  const f = await fixture();
  let release!: () => void;
  let building = false;
  let missing = false;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commit = 'a'.repeat(40);
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    dataDir: '/unused',
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => {
      if (missing) throw new IndexError('BRANCH_NOT_FOUND', 'Remote branch does not exist');
      return commit;
    },
    build: async () => {
      building = true;
      await blocked;
      return { path: '/candidate', commit, generation: 'v1' };
    },
  });
  try {
    const oldJob = await worker.enqueue('repo_1', 'initial');
    await worker.start();
    await waitFor(() => building);
    await f.store.updateRepository('repo_1', { status: 'branch_deleted' });
    missing = true;
    const check = await worker.enqueue('repo_1', 'reconcile');
    assert.equal((await f.store.getRepository('repo_1'))?.status, 'branch_deleted');
    release();
    await waitFor(async () => (await f.store.getJob(check.id))?.status === 'failed');
    assert.equal((await f.store.getJob(oldJob.id))?.status, 'failed');
    assert.equal((await f.store.getRepository('repo_1'))?.status, 'branch_deleted');
    assert.equal((await f.store.getRepository('repo_1'))?.path, null);
    missing = false;
    const retry = await worker.enqueue('repo_1', 'reconcile');
    await waitFor(async () => (await f.store.getJob(retry.id))?.status === 'succeeded');
    assert.equal((await f.store.getRepository('repo_1'))?.status, 'ready');
    assert.equal((await f.store.getRepository('repo_1'))?.commit, commit);
  } finally {
    release();
    await worker.stop();
    await f.close();
  }
});

test('publishing retains current and previous owned versions after draining queries', async () => {
  const f = await fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'codeharbor-retention-'));
  const root = join(dataDir, 'repositories', 'repo_1', 'versions');
  async function version(owned: boolean): Promise<{ id: string; path: string }> {
    const id = randomUUID();
    const dir = join(root, id);
    await mkdir(join(dir, 'worktree'), { recursive: true });
    if (owned)
      await writeFile(
        join(dir, '.codeharbor-generation.json'),
        JSON.stringify({ version: 1, repositoryId: 'repo_1', generation: id }),
      );
    return { id, path: join(dir, 'worktree') };
  }
  const old = await version(true);
  const previous = await version(true);
  const current = await version(true);
  const unknown = await version(false);
  await f.store.updateRepository('repo_1', { path: previous.path, commit: 'a'.repeat(40), status: 'ready' });
  let validatedUnderExclusive = false;
  const graph = {
    withExclusive: async (fn: (explore: () => Promise<string>) => Promise<void>) => {
      // Real adapter closes the old shared connection before entering the callback.
      await fn(async () => {
        validatedUnderExclusive = true;
        return 'ok';
      });
      await assert.rejects(access(old.path));
      await access(previous.path);
      await access(current.path);
    },
  } as unknown as CodeGraphClient;
  const worker = new IndexWorker({
    ...f,
    store: f.store,
    graph,
    dataDir,
    allowedGitHosts: ['git.example.com'],
    reconcileIntervalMs: 0,
    head: async () => 'b'.repeat(40),
    build: async () => ({ path: current.path, commit: 'b'.repeat(40), generation: current.id }),
  });
  try {
    const job = await worker.enqueue('repo_1', 'push');
    await worker.start();
    await waitFor(async () => (await f.store.getJob(job.id))?.status === 'succeeded');
    await worker.stop();
    assert.equal(validatedUnderExclusive, true);
    assert.equal((await f.store.getRepository('repo_1'))?.path, current.path);
    await assert.rejects(access(old.path));
    await access(previous.path);
    await access(current.path);
    await access(unknown.path);
  } finally {
    await worker.stop();
    await f.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
