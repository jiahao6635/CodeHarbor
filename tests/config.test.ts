import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseUrl, validateDatabaseTls, validateProduction } from '../src/config.js';

test('production requires PostgreSQL with verified TLS and Vault', () => {
  const env = { NODE_ENV: 'production', CODEHARBOR_KEY_PROVIDER: 'vault-transit' };
  const good = 'postgresql://user:password@db.example/codeharbor?sslmode=verify-full';
  assert.doesNotThrow(() => validateProduction(env, good));
  for (const url of [undefined, 'postgresql://host/db', 'postgresql://host/db?sslmode=verify-full&sslmode=disable',
    'postgresql://host/db?sslmode=verify-full&host=%2Ftmp', 'postgresql://host/db?sslmode=require',
    'postgresql://host/db?sslmode=verify-full&sslrootcert=/tmp/x']) {
    assert.throws(() => validateDatabaseTls(env, url));
  }
  assert.throws(() => validateProduction({ ...env, CODEHARBOR_KEY_PROVIDER: 'local' }, good));
  assert.throws(() => validateDatabaseTls({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, good));
  assert.doesNotThrow(() => validateProduction({ NODE_ENV: 'test' }, undefined));
});

test('database URL is read from one protected source without echoing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-config-'));
  try {
    const path = join(dir, 'db-url'); await writeFile(path, 'postgres://test:secret@localhost/db\n');
    assert.equal(await databaseUrl({ CODEHARBOR_DATABASE_URL_FILE: path }), 'postgres://test:secret@localhost/db');
    await assert.rejects(databaseUrl({ CODEHARBOR_DATABASE_URL_FILE: path, DATABASE_URL: 'other' }));
    await assert.rejects(databaseUrl({ CODEHARBOR_DATABASE_URL_FILE: join(dir, 'absent') }), /unavailable/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
