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

test('production supports both explicit PostgreSQL SSL modes and requires Vault', () => {
  const env = {
    NODE_ENV: 'production',
    CODEHARBOR_KEY_PROVIDER: 'vault-transit',
    CODEHARBOR_INDEX_BACKEND: 'image',
  };
  const encrypted = 'postgresql://user:password@db.example/codeharbor?sslmode=verify-full';
  const plaintext = 'postgresql://db.internal/codeharbor?sslmode=disable';
  for (const url of [encrypted, plaintext, 'postgresql://other.internal:5433/db?sslmode=disable']) {
    assert.doesNotThrow(() => validateProduction(env, url));
    assert.throws(() => validateDatabaseTls({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, url));
  }
  for (const url of [
    'postgresql://host/db',
    'postgresql://host/db?sslmode=verify-full&sslmode=disable',
    'postgresql://host/db?sslmode=verify-full&host=%2Ftmp',
    'postgresql://host/db?sslmode=require',
    'postgresql://host/db?sslmode=prefer',
    'postgresql://host/db?sslmode=verify-full&sslrootcert=/tmp/x',
    `${plaintext}&sslmode=disable`,
    `${plaintext}&host=other.internal`,
  ]) {
    assert.throws(() => validateDatabaseTls(env, url));
  }
  assert.throws(() => validateProduction({ ...env, CODEHARBOR_KEY_PROVIDER: 'local' }, encrypted));
  assert.throws(() => validateProduction({ ...env, CODEHARBOR_INDEX_BACKEND: 'filesystem' }, encrypted), /image index/);
  assert.throws(
    () => validateProduction({ NODE_ENV: 'production', CODEHARBOR_KEY_PROVIDER: 'vault-transit' }, encrypted),
    {
      message: 'Production requires the bounded image index backend',
    },
  );
  assert.doesNotThrow(() => validateProduction({ NODE_ENV: 'test' }, 'postgresql://host/db'));
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
