import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CredentialCipher } from '../src/auth.js';
import { loadMasterKey, VaultTransitMasterKey } from '../src/master-key.js';
import { writeVaultWrappedKey } from '../src/vault-key.js';

test('Vault Transit wraps existing key with authenticated purpose and preserves v1 credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-vault-test-'));
  const tokenFile = join(dir, 'token');
  const wrappedFile = join(dir, 'wrapped');
  await writeFile(tokenFile, 'test-vault-token\n');
  const vaultKey = randomBytes(32);
  const master = randomBytes(32);
  const expectedAAD = Buffer.from('codeharbor:credential-master-key:v1').toString('base64');
  const operations: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal((init?.headers as Record<string, string> | undefined)?.['x-vault-token'], 'test-vault-token');
    assert.equal((init?.headers as Record<string, string> | undefined)?.['x-vault-namespace'], 'company/team');
    assert.equal(init?.redirect, 'error');
    const request = JSON.parse(String(init?.body));
    assert.equal(request.associated_data, expectedAAD);
    const action = String(input).split('/').at(-2);
    operations.push(action!);
    if (action === 'encrypt') {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', vaultKey, iv);
      cipher.setAAD(Buffer.from(request.associated_data, 'base64'));
      const raw = Buffer.concat([
        iv,
        cipher.update(Buffer.from(request.plaintext, 'base64')),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return Response.json({ data: { ciphertext: `vault:v1:${raw.toString('base64')}` } });
    }
    const raw = Buffer.from(request.ciphertext.split(':')[2], 'base64');
    const decipher = createDecipheriv('aes-256-gcm', vaultKey, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(request.associated_data, 'base64'));
    decipher.setAuthTag(raw.subarray(-16));
    const plain = Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]);
    return Response.json({ data: { plaintext: plain.toString('base64') } });
  };
  const env = {
    CODEHARBOR_KEY_PROVIDER: 'vault-transit',
    CODEHARBOR_MASTER_KEY: master.toString('base64'),
    CODEHARBOR_VAULT_ADDR: 'https://vault.example',
    CODEHARBOR_VAULT_TRANSIT_KEY: 'codeharbor',
    CODEHARBOR_VAULT_TOKEN_FILE: tokenFile,
    CODEHARBOR_VAULT_WRAPPED_KEY_FILE: wrappedFile,
    CODEHARBOR_VAULT_NAMESPACE: 'company/team',
  };
  try {
    const before = new CredentialCipher(master).encrypt('sensitive-pat', 'user-1');
    await writeVaultWrappedKey(env, 'existing', fetcher);
    assert.match(await readFile(wrappedFile, 'utf8'), /^vault:v1:/);
    const unwrapped = await loadMasterKey(env, fetcher);
    assert.deepEqual(unwrapped, master);
    assert.equal(new CredentialCipher(unwrapped).decrypt(before, 'user-1'), 'sensitive-pat');
    assert.throws(() => new CredentialCipher(unwrapped).decrypt(before, 'user-2'));
    assert.deepEqual(operations, ['encrypt', 'decrypt']);
    await assert.rejects(writeVaultWrappedKey(env, 'existing', fetcher));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Vault configuration requires HTTPS and never falls back when Vault fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-vault-test-'));
  const tokenFile = join(dir, 'token');
  const wrappedFile = join(dir, 'wrapped');
  await writeFile(tokenFile, 'private-token');
  await writeFile(wrappedFile, 'vault:v1:Zm9v');
  const env = {
    CODEHARBOR_KEY_PROVIDER: 'vault-transit',
    CODEHARBOR_MASTER_KEY: randomBytes(32).toString('base64'),
    CODEHARBOR_VAULT_ADDR: 'https://vault.example',
    CODEHARBOR_VAULT_TRANSIT_KEY: 'codeharbor',
    CODEHARBOR_VAULT_TOKEN_FILE: tokenFile,
    CODEHARBOR_VAULT_WRAPPED_KEY_FILE: wrappedFile,
  };
  try {
    assert.throws(
      () => new VaultTransitMasterKey({ address: 'http://vault.example', mount: 'transit', keyName: 'key', tokenFile }),
    );
    assert.throws(
      () =>
        new VaultTransitMasterKey({
          address: 'https://user:password@vault.example',
          mount: 'transit',
          keyName: 'key',
          tokenFile,
        }),
    );
    assert.throws(
      () =>
        new VaultTransitMasterKey({ address: 'https://vault.example', mount: '../transit', keyName: 'key', tokenFile }),
    );
    await assert.rejects(
      loadMasterKey(env, async () => new Response('private-token', { status: 403 })),
      /Vault Transit request failed/,
    );
    await assert.rejects(
      loadMasterKey(env, async () => Response.json({ data: { plaintext: 'invalid' } })),
      /invalid master key/,
    );
    await assert.rejects(
      loadMasterKey({ ...env, CODEHARBOR_VAULT_WRAPPED_KEY_FILE: join(dir, 'missing') }),
      /unavailable/,
    );
    assert.deepEqual(
      await loadMasterKey({ CODEHARBOR_MASTER_KEY: env.CODEHARBOR_MASTER_KEY }),
      Buffer.from(env.CODEHARBOR_MASTER_KEY, 'base64'),
    );
    await assert.rejects(
      loadMasterKey({ CODEHARBOR_KEY_PROVIDER: 'unknown', CODEHARBOR_MASTER_KEY: env.CODEHARBOR_MASTER_KEY }),
      /Unknown/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
