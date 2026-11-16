import { readFile } from 'node:fs/promises';

/** The Vault Transit key wraps the existing AES key, preserving v1 PAT ciphertexts. */
export type VaultTransitOptions = {
  address: string;
  mount: string;
  keyName: string;
  tokenFile: string;
  namespace?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const associatedData = Buffer.from('codeharbor:credential-master-key:v1').toString('base64');

export function parseMasterKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Credential master key must be base64 encoded');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new Error('Credential master key must be 32 bytes');
  }
  return key;
}

function segment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === '.' || value === '..') {
    throw new Error('Invalid Vault Transit mount or key name');
  }
  return value;
}

export class VaultTransitMasterKey {
  private readonly origin: string;
  private readonly path: string;
  private readonly options: VaultTransitOptions;

  constructor(options: VaultTransitOptions) {
    let address: URL;
    try {
      address = new URL(options.address);
    } catch {
      throw new Error('Invalid Vault address');
    }
    if (
      address.protocol !== 'https:' ||
      address.username ||
      address.password ||
      address.search ||
      address.hash ||
      address.pathname !== '/'
    ) {
      throw new Error('Vault address must be an HTTPS origin');
    }
    if (!options.tokenFile || options.tokenFile.includes('\0')) throw new Error('Vault token file is required');
    if (options.namespace && /[\r\n\0]/.test(options.namespace)) throw new Error('Invalid Vault namespace');
    this.origin = address.origin;
    this.path = `/v1/${segment(options.mount)}`;
    this.options = { ...options, keyName: segment(options.keyName) };
  }

  private async request(
    operation: 'encrypt' | 'decrypt',
    payload: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    let token: string;
    try {
      token = (await readFile(this.options.tokenFile, 'utf8')).trim();
    } catch {
      throw new Error('Vault token is unavailable');
    }
    if (!token || token.length > 16_384 || /[\r\n\0]/.test(token)) throw new Error('Vault token is unavailable');
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        `${this.origin}${this.path}/${operation}/${this.options.keyName}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-vault-token': token,
            ...(this.options.namespace ? { 'x-vault-namespace': this.options.namespace } : {}),
          },
          body: JSON.stringify({ ...payload, associated_data: associatedData }),
          redirect: 'error',
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        },
      );
    } catch {
      throw new Error('Vault Transit request failed');
    }
    if (!response.ok) throw new Error('Vault Transit request failed');
    let result: unknown;
    try {
      const output = await response.text();
      if (Buffer.byteLength(output) > 16_384) throw new Error();
      result = JSON.parse(output);
    } catch {
      throw new Error('Vault Transit returned an invalid response');
    }
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      !('data' in result) ||
      !result.data ||
      typeof result.data !== 'object' ||
      Array.isArray(result.data)
    ) {
      throw new Error('Vault Transit returned an invalid response');
    }
    return result.data as Record<string, unknown>;
  }

  async wrap(key: Buffer): Promise<string> {
    if (key.length !== 32) throw new Error('Credential master key must be 32 bytes');
    const data = await this.request('encrypt', { plaintext: key.toString('base64') });
    if (typeof data.ciphertext !== 'string' || !/^vault:v[1-9][0-9]*:[A-Za-z0-9+/]+={0,2}$/.test(data.ciphertext)) {
      throw new Error('Vault Transit returned an invalid response');
    }
    return data.ciphertext;
  }

  async unwrap(wrapped: string): Promise<Buffer> {
    if (wrapped.length > 16_384 || !/^vault:v[1-9][0-9]*:[A-Za-z0-9+/]+={0,2}$/.test(wrapped))
      throw new Error('Invalid wrapped master key');
    const data = await this.request('decrypt', { ciphertext: wrapped });
    if (typeof data.plaintext !== 'string') throw new Error('Vault Transit returned an invalid response');
    try {
      return parseMasterKey(data.plaintext);
    } catch {
      throw new Error('Vault Transit returned an invalid master key');
    }
  }
}

export function vaultTransitOptions(env: NodeJS.ProcessEnv): VaultTransitOptions {
  const address = env.CODEHARBOR_VAULT_ADDR;
  const keyName = env.CODEHARBOR_VAULT_TRANSIT_KEY;
  const tokenFile = env.CODEHARBOR_VAULT_TOKEN_FILE;
  if (!address || !keyName || !tokenFile)
    throw new Error('Vault address, Transit key name and token file are required');
  return {
    address,
    keyName,
    tokenFile,
    mount: env.CODEHARBOR_VAULT_TRANSIT_MOUNT ?? 'transit',
    namespace: env.CODEHARBOR_VAULT_NAMESPACE || undefined,
  };
}

/** Fail closed: a configured Vault provider never falls back to a local key. */
export async function loadMasterKey(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Promise<Buffer> {
  const provider = env.CODEHARBOR_KEY_PROVIDER ?? 'local';
  if (provider === 'local') {
    if (!env.CODEHARBOR_MASTER_KEY) throw new Error('CODEHARBOR_MASTER_KEY is required');
    return parseMasterKey(env.CODEHARBOR_MASTER_KEY);
  }
  if (provider !== 'vault-transit') throw new Error('Unknown credential key provider');
  if (!env.CODEHARBOR_VAULT_WRAPPED_KEY_FILE) throw new Error('Vault wrapped key file is required');
  let wrapped: string;
  try {
    wrapped = (await readFile(env.CODEHARBOR_VAULT_WRAPPED_KEY_FILE, 'utf8')).trim();
  } catch {
    throw new Error('Vault wrapped key file is unavailable');
  }
  return new VaultTransitMasterKey({ ...vaultTransitOptions(env), fetch: fetchImpl }).unwrap(wrapped);
}
