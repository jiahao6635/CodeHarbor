import { readFile } from 'node:fs/promises';
import type { FeishuConfig } from './browser-auth.js';

export async function feishuConfig(env: NodeJS.ProcessEnv): Promise<FeishuConfig | undefined> {
  const origin = env.CODEHARBOR_PUBLIC_ORIGIN;
  const appId = env.CODEHARBOR_FEISHU_APP_ID;
  const secretFile = env.CODEHARBOR_FEISHU_APP_SECRET_FILE;
  const tenantKey = env.CODEHARBOR_FEISHU_TENANT_KEY;
  const superAdminOpenId = env.CODEHARBOR_FEISHU_SUPER_ADMIN_OPEN_ID;
  const production = env.NODE_ENV === 'production';
  if (!production && !origin && !appId && !secretFile && !tenantKey && !superAdminOpenId) return undefined;
  if (!origin || !appId || !secretFile || !tenantKey || !superAdminOpenId) {
    throw new Error('Incomplete CodeHarbor Feishu login configuration');
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('Invalid CODEHARBOR_PUBLIC_ORIGIN');
  }
  const devLoopback = !production && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(devLoopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid CODEHARBOR_PUBLIC_ORIGIN');
  }
  if (
    !/^cli_[A-Za-z0-9_-]{1,128}$/.test(appId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(tenantKey) ||
    !/^ou_[A-Za-z0-9_-]{1,128}$/.test(superAdminOpenId)
  ) {
    throw new Error('Invalid Feishu application, tenant or bootstrap administrator identifier');
  }
  let appSecret: string;
  try {
    appSecret = (await readFile(secretFile, 'utf8')).trim();
  } catch {
    throw new Error('Feishu App Secret file is unavailable');
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: secrets must be single printable values
  if (!appSecret || appSecret.length > 4096 || /[\x00-\x20\x7f]/.test(appSecret)) {
    throw new Error('Invalid Feishu App Secret file');
  }
  return { origin: url.origin, appId, appSecret, tenantKey, superAdminOpenId };
}

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
  const sslModes = url.searchParams.getAll('sslmode');
  const sslMode = sslModes[0];
  const plaintextAllowed =
    sslMode === 'disable' && url.port !== '' && url.host === env.CODEHARBOR_POSTGRES_PLAINTEXT_ENDPOINT;
  if (
    sslModes.length !== 1 ||
    (sslMode !== 'verify-full' && !plaintextAllowed) ||
    [...url.searchParams.keys()].some((name) => name !== 'sslmode' && name !== 'application_name') ||
    env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  ) {
    throw new Error('Production PostgreSQL requires verified TLS or an explicitly configured plaintext endpoint');
  }
}

export function validateProduction(env: NodeJS.ProcessEnv, dbUrl: string): void {
  validateDatabaseTls(env, dbUrl);
  if (env.NODE_ENV !== 'production') return;
  if (env.CODEHARBOR_KEY_PROVIDER !== 'vault-transit') throw new Error('Production requires Vault Transit');
  if (indexBackend(env) !== 'image') throw new Error('Production requires the bounded image index backend');
}
