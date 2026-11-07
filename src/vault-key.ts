import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMasterKey, vaultTransitOptions, VaultTransitMasterKey } from './master-key.js';

/** Create an encrypted key file without overwriting an existing deployment. */
export async function writeVaultWrappedKey(env: NodeJS.ProcessEnv, mode: 'new' | 'existing', fetchImpl?: typeof fetch): Promise<void> {
  const destination = env.CODEHARBOR_VAULT_WRAPPED_KEY_FILE;
  if (!destination) throw new Error('CODEHARBOR_VAULT_WRAPPED_KEY_FILE is required');
  let key: Buffer;
  if (mode === 'existing') {
    if (!env.CODEHARBOR_MASTER_KEY) throw new Error('CODEHARBOR_MASTER_KEY is required to wrap the existing key');
    key = parseMasterKey(env.CODEHARBOR_MASTER_KEY);
  } else {
    key = randomBytes(32);
  }
  try {
    const wrapped = await new VaultTransitMasterKey({ ...vaultTransitOptions(env), fetch: fetchImpl }).wrap(key);
    await writeFile(destination, `${wrapped}\n`, { flag: 'wx', mode: 0o600 });
  } finally {
    key.fill(0);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if ((mode !== '--new' && mode !== '--wrap-existing') || process.argv.length !== 3) {
    process.stderr.write('Usage: node dist/vault-key.js --new|--wrap-existing\n');
    process.exitCode = 1;
  } else {
    writeVaultWrappedKey(process.env, mode === '--new' ? 'new' : 'existing')
      .then(() => { process.stdout.write('Wrapped master key file created.\n'); })
      .catch(() => { process.stderr.write('Failed to create wrapped master key file.\n'); process.exitCode = 1; });
  }
}
