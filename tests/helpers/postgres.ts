import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openPostgresStore, type PostgresStoreOptions } from '../../src/postgres-store.js';
import type { StoreBackend } from '../../src/store.js';

/** Matches deploy/compose.test.yaml; override with CODEHARBOR_TEST_DATABASE_URL. */
export const TEST_DATABASE_URL =
  process.env.CODEHARBOR_TEST_DATABASE_URL ?? 'postgres://codeharbor_test:codeharbor_test@127.0.0.1:54329/postgres';

export type TestDatabase = { url: string; drop(): Promise<void> };

export async function createTestDatabase(prefix = 'codeharbor_test'): Promise<TestDatabase> {
  const name = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 5_000 });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(`Test PostgreSQL is unreachable at ${TEST_DATABASE_URL}; run "npm run test:db:up"`, {
      cause: error,
    });
  }
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return {
    url: url.href,
    async drop() {
      const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}

export type TestStore = { store: StoreBackend; database: TestDatabase; close(): Promise<void> };

/** Fresh database with migrations applied; close() releases the store and drops the database. */
export async function openTestStore(options: PostgresStoreOptions = {}): Promise<TestStore> {
  const database = await createTestDatabase();
  let store: StoreBackend;
  try {
    store = await openPostgresStore(database.url, options);
  } catch (error) {
    await database.drop().catch(() => {});
    throw error;
  }
  let closed = false;
  return {
    store,
    database,
    async close() {
      if (closed) return;
      closed = true;
      await store.close().catch(() => {});
      await database.drop();
    },
  };
}
