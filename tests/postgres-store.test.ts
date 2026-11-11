import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresStore } from '../src/postgres-store.js';
import { Store } from '../src/store.js';
import { DatabaseSync } from 'node:sqlite';

const baseUrl = process.env.CODEHARBOR_TEST_DATABASE_URL;
void test('PostgreSQL exclusive instance lock, offline migration, rollback and lock-session failure', { skip: !baseUrl, timeout: 30000 }, async () => {
  const dbName = `codeharbor_store_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(baseUrl!); url.pathname = `/${dbName}`;
  const appName = `codeharbor_test_${process.pid}`;
  url.searchParams.set('application_name', appName);
  const temp = await mkdtemp(join(tmpdir(), 'codeharbor-pg-test-'));
  const sqlitePath = join(temp, 'old.sqlite');
  const sqlite = new Store(sqlitePath);
  sqlite.createUser({ id: 'u', username: 'tester', credential: 'v1.encrypted', credential_version: 1 });
  sqlite.createKey({ hash: 'hash', prefix: 'prefix', owner: 'u', scope: 'read', repos: ['r'], expires_at: 2000000000000, revoked: 0 });
  const previousImage = `oci://sha256:${'a'.repeat(64)}`; const previousCommit = 'b'.repeat(40);
  sqlite.createRepository({ id:'r', codeup_id:'123', name:'repo', branch:'main', owner:'u', sync_owner:'u', sync_credential_version:1, hook_hash:'hook', path:'/data/r', commit:'abc', previous_image:previousImage, previous_commit:previousCommit, indexed_at:123, status:'ready', error:null });
  sqlite.createJob({ id:'j', repo_id:'r', status:'running', reason:'manual', created_at:123, error:null });
  sqlite.close();
  let store: PostgresStore | undefined;
  let controller: pg.Client | undefined;
  try {
    controller = new pg.Client({ connectionString: baseUrl });
    await controller.connect();
    await controller.query(`CREATE DATABASE "${dbName}"`);
    store = await PostgresStore.open(url.href);
    await assert.rejects(PostgresStore.open(url.href), /Another CodeHarbor instance/);
    await store.importSqlite(sqlitePath);
    assert.equal((await store.getUser('u'))?.credential, 'v1.encrypted');
    assert.deepEqual((await store.getKey('hash'))?.repos, ['r']);
    assert.equal((await store.getRepository('r'))?.commit, 'abc');
    assert.equal((await store.getRepository('r'))?.previous_image, previousImage);
    assert.equal((await store.getRepository('r'))?.previous_commit, previousCommit);
    assert.equal((await store.getJob('j'))?.status, 'queued');
    assert.ok(((await store.getJob('j'))?.queued_at ?? 0) > 123, 'import requeues interrupted jobs with a new queue time');
    const now = Date.now();
    await store.createJob({id:'success', repo_id:'r', status:'succeeded', reason:'manual', created_at:now-2000, finished_at:now-1000, build_duration_ms:1000, error:null});
    await store.createJob({id:'failure', repo_id:'r', status:'failed', reason:'manual', created_at:now-1000, finished_at:now-500, build_duration_ms:5000, error:null});
    await store.createJob({id:'no-build', repo_id:'r', status:'succeeded', reason:'reconcile', created_at:now-1000, finished_at:now-100, error:null});
    const metrics = await store.jobMetrics(now);
    assert.equal(metrics.queued, 1);
    assert.equal(metrics.completed24h, 3);
    assert.equal(metrics.failed24h, 1);
    assert.equal(metrics.builds24h, 2);
    assert.equal(metrics.buildDurationSumMs24h, 6000);
    assert.equal(metrics.buildDurationMaxMs24h, 5000);
    assert.equal(metrics.buildDurationLastMs24h, 5000);
    assert.deepEqual(metrics.buildBuckets24h.slice(0, 2), [1, 2]);
    await assert.rejects(store.importSqlite(sqlitePath), /not empty/);
    await assert.rejects(store.transaction(async tx => {
      await tx.updateUserCredential('u', 'bad', 'bad');
      throw new Error('rollback');
    }), /rollback/);
    assert.equal((await store.getUser('u'))?.username, 'tester');
    await assert.rejects(store.transaction(async tx => {
      await tx.updateRepository('r', {path:'next', commit:'next', previous_image:'bad', previous_commit:'bad'});
      throw new Error('rollback');
    }), /rollback/);
    assert.equal((await store.getRepository('r'))?.previous_image, previousImage);
    assert.equal((await store.getRepository('r'))?.previous_commit, previousCommit);
    await store.transaction(async tx => { await tx.updateUserCredential('u', 'good', 'encrypted'); });
    assert.equal((await store.getUser('u'))?.username, 'good');
    await store.checkHealth();
    const result = await controller.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()', [appName]);
    assert.equal(result.rowCount, 1);
    await controller.query('SELECT pg_terminate_backend($1)', [result.rows[0].pid]);
    await new Promise(resolve => setTimeout(resolve, 50));
    await assert.rejects(store.getUser('u'));
    await assert.rejects(store.createUser({ id:'x', username:'x', credential:'x', credential_version:1 }));
    await store.close(); store = undefined;
    const replacement = await PostgresStore.open(url.href);
    try { assert.equal(await replacement.getUser('x'), undefined); } finally { await replacement.close(); }
  } finally {
    await store?.close();
    if (controller) { await controller.query(`DROP DATABASE IF EXISTS "${dbName}"`); await controller.end(); }
    await rm(temp, { recursive:true, force:true });
  }
});

void test('PostgreSQL schema upgrades and imports SQLite repositories without image fields', { skip: !baseUrl, timeout: 30000 }, async () => {
  const dbName = `codeharbor_old_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(baseUrl!); url.pathname = `/${dbName}`;
  const temp = await mkdtemp(join(tmpdir(), 'codeharbor-old-image-fields-'));
  const sqlitePath = join(temp, 'old.sqlite');
  const sqlite = new Store(sqlitePath);
  sqlite.createUser({id:'u', username:'tester', credential:'encrypted', credential_version:1});
  sqlite.createRepository({id:'r', codeup_id:'123', name:'repo', branch:'main', owner:'u', sync_owner:'u', sync_credential_version:1, hook_hash:'hook', path:'/old', commit:'abc', indexed_at:123, status:'ready', error:null});
  sqlite.createJob({id:'old-job', repo_id:'r', status:'succeeded', reason:'manual', created_at:123, error:null});
  sqlite.close();
  const old = new DatabaseSync(sqlitePath);
  old.exec('ALTER TABLE repositories DROP COLUMN previous_image; ALTER TABLE repositories DROP COLUMN previous_commit; DROP INDEX jobs_finished_idx; ALTER TABLE jobs DROP COLUMN queued_at; ALTER TABLE jobs DROP COLUMN finished_at; ALTER TABLE jobs DROP COLUMN build_duration_ms');
  old.close();
  const controller = new pg.Client({connectionString:baseUrl});
  let legacy: pg.Client | undefined; let store: PostgresStore | undefined;
  let created = false;
  try {
    await controller.connect(); await controller.query(`CREATE DATABASE "${dbName}"`); created = true;
    legacy = new pg.Client({connectionString:url.href}); await legacy.connect();
    await legacy.query(`CREATE TABLE repositories(id TEXT PRIMARY KEY,codeup_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,branch TEXT NOT NULL,owner TEXT NOT NULL,sync_owner TEXT NOT NULL,sync_credential_version INTEGER NOT NULL,hook_hash TEXT NOT NULL,path TEXT,commit_sha TEXT,indexed_at BIGINT,status TEXT NOT NULL,error TEXT)`);
    await legacy.query(`CREATE TABLE jobs(id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')), reason TEXT NOT NULL, created_at BIGINT NOT NULL, error TEXT)`);
    await legacy.query(`INSERT INTO repositories(id,codeup_id,name,branch,owner,sync_owner,sync_credential_version,hook_hash,status) VALUES ('legacy','legacy','legacy','main','u','u',1,'hook','ready')`);
    await legacy.query(`INSERT INTO jobs(id,repo_id,status,reason,created_at) VALUES ('legacy-queued','legacy','queued','manual',100), ('legacy-completed','legacy','succeeded','manual',200)`);
    await legacy.end(); legacy = undefined;
    store = await PostgresStore.open(url.href);
    const oldMetrics = await store.jobMetrics(1000);
    assert.equal(oldMetrics.queued, 1);
    assert.equal(oldMetrics.oldestQueuedAt, 100);
    assert.equal(oldMetrics.completed24h, 0);
    assert.equal((await store.getJob('legacy-completed'))?.finished_at, null);
    await store.deleteRepository('legacy');
    await store.importSqlite(sqlitePath);
    const repo = await store.getRepository('r');
    assert.equal(repo?.path, '/old'); assert.equal(repo?.commit, 'abc');
    assert.equal(repo?.previous_image, null); assert.equal(repo?.previous_commit, null);
    assert.equal((await store.getJob('old-job'))?.finished_at, null);
    assert.equal((await store.jobMetrics(Date.now())).completed24h, 0);
    const image = `oci://sha256:${'a'.repeat(64)}`; const commit = 'b'.repeat(40);
    await store.updateRepository('r', {previous_image:image, previous_commit:commit});
    assert.equal((await store.getRepositoryByCodeupId('123'))?.previous_image, image);
    await store.close(); store = undefined;
    store = await PostgresStore.open(url.href);
    assert.equal((await store.getRepository('r'))?.previous_commit, commit);
  } finally {
    await legacy?.end().catch(() => {}); await store?.close();
    if (created) await controller.query(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => {});
    await controller.end().catch(() => {}); await rm(temp, {recursive:true, force:true});
  }
});
