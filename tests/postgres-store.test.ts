import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { loadMigrations } from '../src/migrate.js';
import { LOCK_APPLICATION_NAME, openPostgresStore } from '../src/postgres-store.js';
import { BUILD_DURATION_BUCKETS_MS, type StoreBackend } from '../src/store.js';
import { createTestDatabase, openTestStore } from './helpers/postgres.js';

test('PostgreSQL store round-trips records, enforces the instance lock and fails closed when the lock drops', async () => {
  const { store, database, close } = await openTestStore();
  const controller = new pg.Client({ connectionString: database.url });
  let active: StoreBackend | undefined = store;
  try {
    await assert.rejects(openPostgresStore(database.url), /Another CodeHarbor instance/);

    await store.createUser({ id: 'u', username: 'tester', credential: 'v1.encrypted', credential_version: 1 });
    await store.createKey({
      hash: 'hash',
      prefix: 'prefix',
      owner: 'u',
      scope: 'read',
      repos: ['r'],
      expires_at: 2_000_000_000_000,
      revoked: 0,
    });
    await store.createKey({
      hash: 'all',
      prefix: 'all',
      owner: 'u',
      scope: 'write',
      repos: null,
      expires_at: null,
      revoked: 0,
    });
    const previousImage = `oci://sha256:${'a'.repeat(64)}`;
    const previousCommit = 'b'.repeat(40);
    await store.createRepository({
      id: 'r',
      codeup_id: '123',
      name: 'repo',
      branch: 'main',
      owner: 'u',
      sync_owner: 'u',
      sync_credential_version: 1,
      hook_hash: 'hook',
      path: '/data/r',
      commit: 'abc',
      previous_image: previousImage,
      previous_commit: previousCommit,
      indexed_at: 123,
      status: 'ready',
      error: null,
    });
    await store.createRepository({
      id: 'r2',
      codeup_id: '456',
      name: 'repo2',
      branch: 'main',
      owner: 'u',
      sync_owner: 'u',
      sync_credential_version: 1,
      hook_hash: 'hook2',
      path: null,
      commit: null,
      indexed_at: null,
      status: 'pending',
      error: null,
    });
    await store.createJob({ id: 'j', repo_id: 'r', status: 'queued', reason: 'manual', created_at: 123, error: null });

    const user = await store.getUser('u');
    assert.deepEqual(user, { id: 'u', username: 'tester', credential: 'v1.encrypted', credential_version: 1 });
    assert.equal(typeof user?.credential_version, 'number');
    const key = await store.getKey('hash');
    assert.deepEqual(key?.repos, ['r']);
    assert.equal(key?.expires_at, 2_000_000_000_000);
    assert.equal(typeof key?.expires_at, 'number', 'BIGINT columns are parsed to numbers');
    assert.equal((await store.getKey('all'))?.repos, null);
    const repo = await store.getRepository('r');
    assert.equal(repo?.commit, 'abc');
    assert.equal(repo?.previous_image, previousImage);
    assert.equal(repo?.indexed_at, 123);
    assert.equal((await store.getRepository('r2'))?.previous_image, null);
    assert.deepEqual(
      (await store.getRepositoriesByIds(['r2', 'r', 'missing'])).map((row) => row.id),
      ['r', 'r2'],
    );
    assert.deepEqual(await store.getRepositoriesByIds([]), []);
    const job = await store.getJob('j');
    assert.equal(job?.queued_at, 123, 'queued_at defaults to created_at');
    assert.equal(job?.finished_at, null);
    assert.deepEqual(await store.listUsers(), [{ id: 'u', username: 'tester', credential_version: 1 }]);

    const now = Date.now();
    await store.createJob({
      id: 'success',
      repo_id: 'r',
      status: 'succeeded',
      reason: 'manual',
      created_at: now - 2000,
      finished_at: now - 1000,
      build_duration_ms: 1000,
      error: null,
    });
    await store.createJob({
      id: 'failure',
      repo_id: 'r',
      status: 'failed',
      reason: 'manual',
      created_at: now - 1000,
      finished_at: now - 500,
      build_duration_ms: 5000,
      error: null,
    });
    await store.createJob({
      id: 'no-build',
      repo_id: 'r',
      status: 'succeeded',
      reason: 'reconcile',
      created_at: now - 1000,
      finished_at: now - 100,
      error: null,
    });
    const metrics = await store.jobMetrics(now);
    assert.equal(metrics.queued, 1);
    assert.equal(metrics.oldestQueuedAt, 123);
    assert.equal(metrics.completed24h, 3);
    assert.equal(metrics.failed24h, 1);
    assert.equal(metrics.builds24h, 2);
    assert.equal(metrics.buildDurationSumMs24h, 6000);
    assert.equal(metrics.buildDurationMaxMs24h, 5000);
    assert.equal(metrics.buildDurationLastMs24h, 5000);
    assert.equal(metrics.buildBuckets24h.length, BUILD_DURATION_BUCKETS_MS.length);
    assert.deepEqual(metrics.buildBuckets24h.slice(0, 2), [1, 2]);
    const empty = await store.jobMetrics(now - 10 * 86_400_000);
    assert.equal(empty.buildDurationSumMs24h, 0);
    assert.equal(empty.buildDurationMaxMs24h, null);

    const contender = new pg.Client({ connectionString: database.url });
    await contender.connect();
    try {
      await store.transaction(async (tx) => {
        assert.equal((await tx.getRepository('r', { forUpdate: true }))?.id, 'r');
        await assert.rejects(
          contender.query('SELECT id FROM repositories WHERE id = $1 FOR UPDATE NOWAIT', ['r']),
          (error: unknown) => error instanceof pg.DatabaseError && error.code === '55P03',
        );
      });
      assert.equal(
        (await contender.query('SELECT id FROM repositories WHERE id = $1 FOR UPDATE NOWAIT', ['r'])).rowCount,
        1,
      );
    } finally {
      await contender.end();
    }

    await assert.rejects(
      store.transaction(async (tx) => {
        await tx.updateUserCredential('u', 'bad', 'bad');
        throw new Error('rollback');
      }),
      /rollback/,
    );
    assert.equal((await store.getUser('u'))?.username, 'tester');
    await store.transaction(async (tx) => {
      await tx.updateUserCredential('u', 'good', 'encrypted');
      await tx.updateRepository('r', { status: 'updating', error: null });
      await tx.updateJob('j', { status: 'running' });
    });
    assert.equal((await store.getUser('u'))?.credential_version, 2);
    assert.equal((await store.getRepository('r'))?.status, 'updating');
    assert.equal((await store.getJob('j'))?.status, 'running');
    await store.updateRepository('r', {});
    await store.updateJob('j', {});

    await store.upsertAccess({ user_id: 'u', repo_id: 'r', allowed: 1, verified_at: 10 });
    await store.upsertAccess({ user_id: 'u', repo_id: 'r', allowed: 0, verified_at: 20 });
    assert.deepEqual(await store.getAccess('u', 'r'), { user_id: 'u', repo_id: 'r', allowed: 0, verified_at: 20 });
    assert.equal((await store.listStaleAccess(30, 10)).length, 1);
    assert.equal((await store.listStaleAccess(20, 10)).length, 0);

    await store.appendAuditEvents([
      {
        id: 'a1',
        at: 1,
        request_id: 'req',
        method: 'GET',
        route: '/x',
        status: 200,
        authentication: null,
        subject: 'u',
        key_prefix: null,
        repo_id: 'r',
        tool: null,
        tool_outcome: null,
        query_hash: null,
      },
      {
        id: 'a2',
        at: 2,
        request_id: 'req',
        method: 'GET',
        route: '/x',
        status: 404,
        authentication: 'api_key',
        subject: 'v',
        key_prefix: 'p',
        repo_id: null,
        tool: 't',
        tool_outcome: 'error',
        query_hash: 'h',
      },
    ]);
    assert.deepEqual(
      (await store.listAuditEvents({ limit: 10 })).map((row) => row.id),
      ['a2', 'a1'],
    );
    assert.deepEqual(
      (await store.listAuditEvents({ subject: 'u', limit: 10 })).map((row) => row.id),
      ['a1'],
    );
    assert.deepEqual(
      (await store.listAuditEvents({ repo_id: 'r', since: 1, limit: 10 })).map((row) => row.id),
      ['a1'],
    );
    assert.equal(await store.purgeAuditEvents(2), 1);

    await store.checkHealth();
    await controller.connect();
    const sessions = await controller.query(
      'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1',
      [LOCK_APPLICATION_NAME],
    );
    assert.equal(sessions.rowCount, 1, 'exactly one session holds the instance lock');
    await controller.query('SELECT pg_terminate_backend($1)', [sessions.rows[0].pid]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(store.getUser('u'), /lock session is unavailable/);
    await assert.rejects(store.createUser({ id: 'x', username: 'x', credential: 'x', credential_version: 1 }));
    await assert.rejects(store.transaction(async () => {}));
    await store.close();
    active = undefined;
    const replacement = await openPostgresStore(database.url);
    try {
      assert.equal(await replacement.getUser('x'), undefined);
      assert.equal((await replacement.getUser('u'))?.username, 'good');
    } finally {
      await replacement.close();
    }
  } finally {
    await controller.end().catch(() => {});
    await active?.close().catch(() => {});
    await close();
  }
});

test('migrations apply once, record versions, and reject unknown or renamed versions', async () => {
  const database = await createTestDatabase('codeharbor_migrate');
  const client = new pg.Client({ connectionString: database.url });
  const temp = await mkdtemp(join(tmpdir(), 'codeharbor-migrations-'));
  try {
    const bundled = await loadMigrations();
    assert.equal(bundled[0]?.version, 1);
    assert.equal(bundled[0]?.name, 'init');

    const first = await openPostgresStore(database.url);
    await first.close();
    await client.connect();
    const applied = await client.query('SELECT version, name FROM schema_migrations ORDER BY version');
    assert.deepEqual(
      applied.rows.map((row) => [Number(row.version), row.name]),
      bundled.map((m) => [m.version, m.name]),
    );
    const second = await openPostgresStore(database.url);
    await second.close();
    assert.equal((await client.query('SELECT count(*) FROM schema_migrations')).rows[0].count, String(bundled.length));

    await writeFile(join(temp, '0001_init.sql'), bundled[0].sql);
    await writeFile(join(temp, '0002_add_note.sql'), 'ALTER TABLE users ADD COLUMN note TEXT;');
    const upgraded = await openPostgresStore(database.url, { migrationsDir: temp });
    try {
      await upgraded.createUser({ id: 'u', username: 'u', credential: 'c', credential_version: 1 });
    } finally {
      await upgraded.close();
    }
    assert.equal((await client.query('SELECT note FROM users')).rows[0].note, null);
    assert.equal((await client.query('SELECT max(version) FROM schema_migrations')).rows[0].max, 2);

    await assert.rejects(openPostgresStore(database.url), /newer than this build/);

    await writeFile(join(temp, '0002_add_note.sql'), 'SELECT 1;');
    await rm(join(temp, '0002_add_note.sql'));
    await writeFile(join(temp, '0002_renamed.sql'), 'SELECT 1;');
    await assert.rejects(openPostgresStore(database.url, { migrationsDir: temp }), /applied as "add_note"/);

    await writeFile(join(temp, '0002_add_note.sql'), 'SELECT 1;');
    await rm(join(temp, '0002_renamed.sql'));
    await writeFile(join(temp, '0004_gap.sql'), 'SELECT 1;');
    await assert.rejects(loadMigrations(temp), /contiguous/);
    await rm(join(temp, '0004_gap.sql'));
    await writeFile(
      join(temp, '0003_broken.sql'),
      'ALTER TABLE users ADD COLUMN ok TEXT; SELECT * FROM missing_table;',
    );
    await assert.rejects(openPostgresStore(database.url, { migrationsDir: temp }));
    assert.equal(
      (await client.query('SELECT max(version) FROM schema_migrations')).rows[0].max,
      2,
      'failed migration rolls back',
    );
    const columns = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'ok'",
    );
    assert.equal(columns.rowCount, 0);
  } finally {
    await client.end().catch(() => {});
    await rm(temp, { recursive: true, force: true });
    await database.drop();
  }
});
