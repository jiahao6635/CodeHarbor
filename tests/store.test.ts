import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { BUILD_DURATION_BUCKETS_MS, Store } from '../src/store.js';

test('store persists encrypted credentials, scoped keys, repositories and jobs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codeharbor-store-'));
  const path = join(dir, 'state.sqlite');
  try {
    let store = new Store(path);
    store.createUser({ id: 'user-1', username: 'alice', credential: 'encrypted', credential_version: 1 });
    store.createKey({ hash: 'hash', prefix: 'ch_123', owner: 'user-1', scope: 'read', repos: ['repo-1'], expires_at: null, revoked: 0 });
    store.createRepository({ id: 'repo-1', codeup_id: '123', name: 'app', branch: 'main', owner: 'user-1', sync_owner: 'user-1', sync_credential_version: 1, hook_hash: 'hook', path: null, commit: null, indexed_at: null, status: 'pending', error: null });
    store.createJob({ id: 'job-1', repo_id: 'repo-1', status: 'queued', reason: 'initial', created_at: 42, error: null });
    store.close();

    store = new Store(path);
    assert.equal(store.getUser('user-1')?.credential, 'encrypted');
    assert.deepEqual(store.getKey('hash')?.repos, ['repo-1']);
    assert.equal(store.getRepositoryByCodeupId('123')?.id, 'repo-1');
    assert.equal(store.listPendingJobs().length, 1);
    store.updateRepository('repo-1', { commit: 'abc', status: 'ready' });
    const previousImage = `oci://sha256:${'a'.repeat(64)}`;
    const previousCommit = 'b'.repeat(40);
    store.updateRepository('repo-1', { previous_image:previousImage, previous_commit:previousCommit });
    assert.throws(() => store.transaction(() => {
      store.updateRepository('repo-1', { path:'new', commit:'new', previous_image:'invalid', previous_commit:'invalid' });
      throw new Error('rollback');
    }));
    assert.equal(store.getRepository('repo-1')?.previous_image, previousImage);
    assert.equal(store.getRepository('repo-1')?.previous_commit, previousCommit);
    store.updateJob('job-1', { status: 'succeeded' });
    assert.equal(store.getRepository('repo-1')?.commit, 'abc');
    assert.equal(store.listPendingJobs().length, 0);
    store.updateUserCredential('user-1', 'alice', 'new-encrypted');
    assert.equal(store.getUser('user-1')?.credential_version, 2);
    store.revokeUserKeys('user-1');
    assert.equal(store.getKey('hash')?.revoked, 1);
    store.close();
    store = new Store(path);
    assert.equal(store.getRepository('repo-1')?.previous_image, previousImage);
    assert.equal(store.getRepository('repo-1')?.previous_commit, previousCommit);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transactions roll back all writes on error', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(() => store.transaction(() => {
      store.createUser({ id: 'u', username: 'alice', credential: 'encrypted', credential_version: 1 });
      throw new Error('failure');
    }));
    assert.equal(store.getUser('u'), undefined);
  } finally {
    store.close();
  }
});

test('migration keeps old repository sync credentials unauthorized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codeharbor-migration-'));
  const path = join(dir, 'state.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE repositories (
        id TEXT PRIMARY KEY, codeup_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        branch TEXT NOT NULL, owner TEXT NOT NULL, sync_owner TEXT NOT NULL,
        hook_hash TEXT NOT NULL, path TEXT, commit_sha TEXT, indexed_at INTEGER,
        status TEXT NOT NULL, error TEXT
      );
      INSERT INTO repositories VALUES ('old', '1', 'repo', 'main', 'user', 'user', 'hash', NULL, NULL, NULL, 'pending', NULL);
    `);
    db.close();
    const store = new Store(path);
    assert.equal(store.getRepository('old')?.sync_credential_version, 0);
    assert.equal(store.getRepository('old')?.previous_image, null);
    assert.equal(store.getRepository('old')?.previous_commit, null);
    store.close();
    const reopened = new Store(path);
    assert.equal(reopened.getRepository('old')?.sync_credential_version, 0);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queue metrics count completed jobs and actual builds within the last 24 hours', () => {
  const store = new Store(':memory:');
  const now = 1_700_000_000_000;
  try {
    store.createUser({id:'u', username:'user', credential:'encrypted', credential_version:1});
    store.createRepository({id:'r', codeup_id:'123', name:'repo', branch:'main', owner:'u', sync_owner:'u', sync_credential_version:1, hook_hash:'hash', path:null, commit:null, indexed_at:null, status:'pending', error:null});
    const add = (id: string, status: 'queued' | 'running' | 'succeeded' | 'failed', created: number, finished: number | null, duration: number | null) => {
      store.createJob({id, repo_id:'r', status, reason:'test', created_at:created, error:null});
      store.updateJob(id, {finished_at:finished, build_duration_ms:duration});
    };
    add('q1', 'queued', now - 100_000, null, null);
    store.updateJob('q1', {queued_at:now - 30_000});
    add('q2', 'queued', now - 50_000, null, null);
    store.updateJob('q2', {queued_at:null}); // Legacy rows fall back to created_at.
    add('ok', 'succeeded', now - 1000, now - 500, 1000);
    add('failed', 'failed', now - 1000, now - 400, 5000);
    add('noop', 'succeeded', now - 1000, now - 300, null);
    add('early-failure', 'failed', now - 1000, now - 200, null);
    add('old', 'failed', now - 90_000_000, now - 86_400_001, 99);
    add('legacy', 'failed', now - 1000, null, 99);
    add('future', 'succeeded', now, now + 1, 99);
    add('running', 'running', now - 1000, now - 100, 99);
    const metrics = store.jobMetrics(now);
    assert.deepEqual(metrics, {
      queued:2, oldestQueuedAt:now - 50_000, completed24h:4, succeeded24h:2, failed24h:2,
      builds24h:2, buildDurationSumMs24h:6000, buildDurationMaxMs24h:5000,
      buildDurationLastMs24h:5000, buildBuckets24h:BUILD_DURATION_BUCKETS_MS.map(bound => bound < 5000 ? 1 : 2),
    });
    assert.throws(() => store.jobMetrics(-1));
  } finally { store.close(); }
});

test('legacy job migration leaves completed timestamps unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codeharbor-jobs-migration-'));
  const path = join(dir, 'state.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, error TEXT);
      INSERT INTO jobs VALUES ('done', 'r', 'failed', 'test', 100, NULL);
      INSERT INTO jobs VALUES ('queued', 'r', 'queued', 'test', 200, NULL);`);
    db.close();
    const store = new Store(path);
    try {
      const metrics = store.jobMetrics(1000);
      assert.equal(metrics.completed24h, 0);
      assert.equal(metrics.oldestQueuedAt, 200);
      assert.equal(metrics.buildDurationMaxMs24h, null);
      assert.equal(metrics.buildDurationLastMs24h, null);
      assert.equal(store.getJob('done')?.finished_at, null);
    } finally { store.close(); }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
