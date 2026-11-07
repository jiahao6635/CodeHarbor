import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresStore } from './postgres-store.js';
import { databaseUrl, validateDatabaseTls } from './config.js';

export function parseMigrationArgs(args: string[]): string {
  if (args.length !== 3 || args[0] !== '--source' || !args[1] || args[1].startsWith('-') || args[2] !== '--confirm-source-offline') {
    throw new Error('Usage: node dist/migrate-sqlite.js --source PATH --confirm-source-offline');
  }
  return resolve(args[1]);
}

export async function migrateSqlite(source: string, databaseUrl: string): Promise<void> {
  if (!databaseUrl) throw new Error('Database URL is required');
  const store = await PostgresStore.open(databaseUrl);
  try { await store.importSqlite(source); } finally { await store.close(); }
}

async function main(): Promise<void> {
  const source = parseMigrationArgs(process.argv.slice(2));
  const url = await databaseUrl(process.env);
  if (!url) throw new Error('Database URL is required');
  validateDatabaseTls(process.env, url);
  await migrateSqlite(source, url);
  process.stdout.write('SQLite migration complete. Keep the same master key and index storage.\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error && (/^Usage:/.test(error.message) || error.message === 'Database URL is required' || error.message === 'Production PostgreSQL requires verified TLS' || error.message === 'PostgreSQL destination is not empty' || error.message === 'Another CodeHarbor instance is using this database')
      ? error.message : 'SQLite migration failed; confirm the source and database configuration';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
