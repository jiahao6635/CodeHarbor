import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresStore } from '../src/postgres-store.js';
import { Store } from '../src/store.js';

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
  sqlite.createRepository({ id:'r', codeup_id:'123', name:'repo', branch:'main', owner:'u', sync_owner:'u', sync_credential_version:1, hook_hash:'hook', path:'/data/r', commit:'abc', indexed_at:123, status:'ready', error:null });
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
    assert.equal((await store.getJob('j'))?.status, 'queued');
    await assert.rejects(store.importSqlite(sqlitePath), /not empty/);
    await assert.rejects(store.transaction(async tx => {
      await tx.updateUserCredential('u', 'bad', 'bad');
      throw new Error('rollback');
    }), /rollback/);
    assert.equal((await store.getUser('u'))?.username, 'tester');
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
