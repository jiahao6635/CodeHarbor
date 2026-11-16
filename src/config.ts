import { readFile } from 'node:fs/promises';

/** Read connection material without including it in error messages or logs. */
export async function databaseUrl(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.CODEHARBOR_DATABASE_URL_FILE && env.DATABASE_URL) throw new Error('Configure only one database URL source');
  let url: string | undefined;
  if (env.CODEHARBOR_DATABASE_URL_FILE) {
    try {
      url = (await readFile(env.CODEHARBOR_DATABASE_URL_FILE, 'utf8')).trim() || undefined;
    } catch {
      throw new Error('Database URL file is unavailable');
    }
  } else {
    url = env.DATABASE_URL || undefined;
  }
  if (!url) throw new Error('PostgreSQL is required: set DATABASE_URL or CODEHARBOR_DATABASE_URL_FILE');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname.length < 2) {
    throw new Error('Invalid PostgreSQL URL');
  }
  return url;
}

export function indexBackend(env: NodeJS.ProcessEnv): 'filesystem' | 'image' {
  const backend = env.CODEHARBOR_INDEX_BACKEND ?? 'filesystem';
  if (backend !== 'filesystem' && backend !== 'image') throw new Error('Invalid index backend');
  return backend;
}

export function validateDatabaseTls(env: NodeJS.ProcessEnv, dbUrl: string): void {
  if (env.NODE_ENV !== 'production') return;
  const url = new URL(dbUrl);
  if (
    url.searchParams.getAll('sslmode').length !== 1 ||
    url.searchParams.get('sslmode') !== 'verify-full' ||
    [...url.searchParams.keys()].some((name) => name !== 'sslmode' && name !== 'application_name') ||
    env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  ) {
    throw new Error('Production PostgreSQL requires verified TLS');
  }
}

export function validateProduction(env: NodeJS.ProcessEnv, dbUrl: string): void {
  validateDatabaseTls(env, dbUrl);
  if (env.NODE_ENV !== 'production') return;
  if (env.CODEHARBOR_KEY_PROVIDER !== 'vault-transit') throw new Error('Production requires Vault Transit');
}
