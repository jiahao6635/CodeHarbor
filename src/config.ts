import { readFile } from 'node:fs/promises';

/** Read connection material without including it in error messages or logs. */
export async function databaseUrl(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (env.CODEHARBOR_DATABASE_URL_FILE && env.DATABASE_URL) throw new Error('Configure only one database URL source');
  if (!env.CODEHARBOR_DATABASE_URL_FILE) return env.DATABASE_URL || undefined;
  try { return (await readFile(env.CODEHARBOR_DATABASE_URL_FILE, 'utf8')).trim() || undefined; }
  catch { throw new Error('Database URL file is unavailable'); }
}

export function validateDatabaseTls(env: NodeJS.ProcessEnv, dbUrl: string | undefined): void {
  if (env.NODE_ENV !== 'production') return;
  if (!dbUrl) throw new Error('PostgreSQL is required in production');
  let url: URL;
  try { url = new URL(dbUrl); } catch { throw new Error('Invalid PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2 ||
      url.searchParams.getAll('sslmode').length !== 1 || url.searchParams.get('sslmode') !== 'verify-full' ||
      [...url.searchParams.keys()].some(name => name !== 'sslmode' && name !== 'application_name') ||
      env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Production PostgreSQL requires verified TLS');
}

export function validateProduction(env: NodeJS.ProcessEnv, dbUrl: string | undefined): void {
  validateDatabaseTls(env, dbUrl);
  if (env.NODE_ENV !== 'production') return;
  if (env.CODEHARBOR_KEY_PROVIDER !== 'vault-transit') throw new Error('Production requires Vault Transit');
}
