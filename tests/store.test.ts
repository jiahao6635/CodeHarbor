import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';

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
