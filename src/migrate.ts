import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export type Migration = { version: number; name: string; sql: string };

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export async function loadMigrations(dir = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const match = FILE_NAME.exec(file);
    if (!match) throw new Error(`Invalid migration file name: ${file}`);
    const version = Number(match[1]);
    if (version !== migrations.length + 1)
      throw new Error(`Migration versions must be contiguous from 0001; found ${file}`);
    migrations.push({ version, name: match[2], sql: await readFile(join(dir, file), 'utf8') });
  }
  return migrations;
}

/**
 * Applies pending migrations, one transaction each, and returns the versions applied.
 * The caller must hold the instance advisory lock so two processes never migrate concurrently.
 */
export async function migrate(client: pg.ClientBase, migrations: Migration[]): Promise<number[]> {
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)',
  );
  const rows = (await client.query('SELECT version, name FROM schema_migrations ORDER BY version')).rows as Array<{
    version: number | string;
    name: string;
  }>;
  const applied = new Map(rows.map((row) => [Number(row.version), row.name]));
  const known = new Set(migrations.map((migration) => migration.version));
  for (const version of applied.keys()) {
    if (!known.has(version)) throw new Error(`Database schema version ${version} is newer than this build`);
  }
  const ran: number[] = [];
  for (const migration of migrations) {
    const existing = applied.get(migration.version);
    if (existing !== undefined) {
      if (existing !== migration.name) {
        throw new Error(
          `Migration ${migration.version} was applied as "${existing}" but the build has "${migration.name}"`,
        );
      }
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations(version, name, applied_at) VALUES($1, $2, $3)', [
        migration.version,
        migration.name,
        Date.now(),
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
    ran.push(migration.version);
  }
  return ran;
}
