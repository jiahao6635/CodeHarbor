import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { databaseUrl, feishuConfig, indexBackend, validateDatabaseTls, validateProduction } from '../src/config.js';

test('Feishu production needs a secure canonical origin and a mount-backed app secret', async () => {
  assert.equal(await feishuConfig({ NODE_ENV: 'test' }), undefined);
  await assert.rejects(feishuConfig({ NODE_ENV: 'production' }), /Incomplete/);
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-feishu-config-'));
  const secretPath = join(dir, 'feishu-secret');
  try {
    await writeFile(secretPath, 'fixture-app-secret\n', { mode: 0o600 });
    const env = {
      NODE_ENV: 'production',
      CODEHARBOR_PUBLIC_ORIGIN: 'https://codeharbor.example/',
      CODEHARBOR_FEISHU_APP_ID: 'cli_test',
      CODEHARBOR_FEISHU_APP_SECRET_FILE: secretPath,
      CODEHARBOR_FEISHU_TENANT_KEY: 'testtenant',
      CODEHARBOR_FEISHU_SUPER_ADMIN_OPEN_ID: 'ou_admin',
    };
    const configured = await feishuConfig(env);
    assert.equal(configured?.origin, 'https://codeharbor.example');
    assert.equal(configured?.appSecret, 'fixture-app-secret');
    await assert.rejects(feishuConfig({ ...env, CODEHARBOR_PUBLIC_ORIGIN: 'http://localhost:8080' }), /ORIGIN/);
    await assert.rejects(feishuConfig({ ...env, CODEHARBOR_PUBLIC_ORIGIN: 'https://codeharbor.example/ui' }), /ORIGIN/);
    assert.equal(
      (await feishuConfig({ ...env, NODE_ENV: 'test', CODEHARBOR_PUBLIC_ORIGIN: 'http://localhost:8080' }))?.origin,
      'http://localhost:8080',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('index backend accepts only known values', () => {
  assert.equal(indexBackend({}), 'filesystem');
  assert.equal(indexBackend({ CODEHARBOR_INDEX_BACKEND: 'image' }), 'image');
  assert.throws(() => indexBackend({ CODEHARBOR_INDEX_BACKEND: 'unknown' }), /backend/);
});

test('production requires PostgreSQL with verified TLS and Vault', () => {
  const env = {
    NODE_ENV: 'production',
    CODEHARBOR_KEY_PROVIDER: 'vault-transit',
    CODEHARBOR_INDEX_BACKEND: 'image',
  };
  const good = 'postgresql://user:password@db.example/codeharbor?sslmode=verify-full';
  assert.doesNotThrow(() => validateProduction(env, good));
  for (const url of [
    'postgresql://host/db',
    'postgresql://host/db?sslmode=verify-full&sslmode=disable',
    'postgresql://host/db?sslmode=verify-full&host=%2Ftmp',
    'postgresql://host/db?sslmode=require',
    'postgresql://host/db?sslmode=verify-full&sslrootcert=/tmp/x',
  ]) {
    assert.throws(() => validateDatabaseTls(env, url));
  }
  assert.throws(() => validateProduction({ ...env, CODEHARBOR_KEY_PROVIDER: 'local' }, good));
  assert.throws(() => validateProduction({ ...env, CODEHARBOR_INDEX_BACKEND: 'filesystem' }, good), /image index/);
  assert.throws(() => validateProduction({ NODE_ENV: 'production', CODEHARBOR_KEY_PROVIDER: 'vault-transit' }, good), {
    message: 'Production requires the bounded image index backend',
  });
  assert.throws(() => validateDatabaseTls({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, good));
  assert.doesNotThrow(() => validateProduction({ NODE_ENV: 'test' }, 'postgresql://host/db'));
});

test('production plaintext PostgreSQL is opt-in for one exact endpoint', () => {
  const env = { NODE_ENV: 'production' };
  const optIn = { ...env, CODEHARBOR_POSTGRES_PLAINTEXT_ENDPOINT: 'db.internal:5432' };
  const url = 'postgresql://db.internal:5432/codeharbor?sslmode=disable';
  assert.throws(() => validateDatabaseTls(env, url), /verified TLS/);
  assert.doesNotThrow(() => validateDatabaseTls(optIn, url));
  assert.doesNotThrow(() => validateDatabaseTls(optIn, 'postgresql://db.example/codeharbor?sslmode=verify-full'));
  for (const invalid of [
    url.replace('db.internal', 'other.internal'),
    url.replace(':5432', ':5433'),
    url.replace(':5432', ''),
    url.replace('sslmode=disable', 'sslmode=prefer'),
    `${url}&sslmode=disable`,
    `${url}&host=other.internal`,
  ]) {
    assert.throws(() => validateDatabaseTls(optIn, invalid), /verified TLS/);
  }
  assert.throws(() => validateDatabaseTls({ ...optIn, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, url), /verified TLS/);
});

test('database URL is read from one protected source without echoing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-config-'));
  try {
    const path = join(dir, 'db-url');
    await writeFile(path, 'postgres://test:secret@localhost/db\n');
    assert.equal(await databaseUrl({ CODEHARBOR_DATABASE_URL_FILE: path }), 'postgres://test:secret@localhost/db');
    await assert.rejects(databaseUrl({ CODEHARBOR_DATABASE_URL_FILE: path, DATABASE_URL: 'other' }));
    await assert.rejects(databaseUrl({ CODEHARBOR_DATABASE_URL_FILE: join(dir, 'absent') }), /unavailable/);
    await assert.rejects(databaseUrl({}), /PostgreSQL is required/);
    await assert.rejects(databaseUrl({ DATABASE_URL: 'sqlite:///tmp/db' }), /Invalid PostgreSQL URL/);
    await assert.rejects(databaseUrl({ DATABASE_URL: 'not a url' }), /Invalid PostgreSQL URL/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
