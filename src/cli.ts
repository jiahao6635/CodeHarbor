import { emitKeypressEvents } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type BindOptions = { url: string; scope: 'read' | 'write' };

export function parseBindOptions(args: string[]): BindOptions {
  if (args[0] !== 'bind') throw new Error('Usage: codeharbor bind --url URL [--scope read|write]');
  let url: string | undefined;
  let scope: string = 'read';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--url' && url === undefined && args[i + 1] && !args[i + 1].startsWith('--')) url = args[++i];
    else if (args[i] === '--scope' && args[i + 1] && !args[i + 1].startsWith('--')) scope = args[++i];
    else throw new Error('Usage: codeharbor bind --url URL [--scope read|write]');
  }
  if (!url || (scope !== 'read' && scope !== 'write')) throw new Error('Usage: codeharbor bind --url URL [--scope read|write]');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Invalid CodeHarbor URL'); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('CodeHarbor URL must be an origin without credentials, path, query or fragment');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) throw new Error('CodeHarbor URL must use HTTPS (HTTP is allowed only for loopback)');
  return { url: parsed.origin, scope };
}

/** Read with terminal echo disabled. Never accepts secrets as arguments or environment variables. */
export async function readSecret(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stderr.isTTY) throw new Error('An interactive terminal is required to enter the PAT');
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  process.stderr.write('云效个人访问令牌（输入不可见）：');
  try {
    return await new Promise<string>((resolveSecret, reject) => {
      let value = '';
      const onKey = (characters: string | undefined, key: { name?: string; ctrl?: boolean }) => {
        if (key.ctrl && key.name === 'c') return finish(new Error('Cancelled'));
        if (key.ctrl && key.name === 'd') return finish(new Error('Cancelled'));
        if (key.name === 'return' || key.name === 'enter') return finish(undefined, value);
        if (key.name === 'backspace') { value = Array.from(value).slice(0, -1).join(''); return; }
        if (characters && !key.ctrl && !/[\x00-\x1f\x7f]/.test(characters) && value.length + characters.length <= 4096) value += characters;
      };
      const onEnd = () => finish(new Error('Cancelled'));
      const finish = (error?: Error, result?: string) => {
        input.off('keypress', onKey);
        input.off('end', onEnd);
        if (error) reject(error); else resolveSecret(result ?? '');
      };
      input.on('keypress', onKey);
      input.once('end', onEnd);
    });
  } finally {
    input.setRawMode(Boolean(wasRaw));
    input.pause();
    process.stderr.write('\n');
  }
}

async function jsonRequest(fetcher: typeof fetch, url: URL, data: unknown, token?: string): Promise<Record<string, unknown>> {
  const res = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(data),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error('CodeHarbor rejected the request');
  const body = await res.text();
  if (Buffer.byteLength(body) > 16 * 1024) throw new Error('Invalid CodeHarbor response');
  let result: unknown;
  try { result = JSON.parse(body); } catch { throw new Error('Invalid CodeHarbor response'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid CodeHarbor response');
  return result as Record<string, unknown>;
}

export async function bind(options: BindOptions, pat: string, fetcher: typeof fetch = fetch): Promise<string> {
  // Repeat validation for programmatic callers so the PAT cannot be sent to an unsafe endpoint.
  const valid = parseBindOptions(['bind', '--url', options.url, '--scope', options.scope]);
  if (!pat || pat.length > 4096 || /[\r\n]/.test(pat)) throw new Error('Invalid PAT');
  const first = await jsonRequest(fetcher, new URL('/api/v1/auth/yunxiao/bind', valid.url), { pat });
  if (typeof first.bootstrap_token !== 'string' || !/^ch_[A-Za-z0-9_-]{43}$/.test(first.bootstrap_token)) throw new Error('Invalid CodeHarbor response');
  const second = await jsonRequest(fetcher, new URL('/api/v1/auth/bootstrap/keys', valid.url), { scope: valid.scope }, first.bootstrap_token);
  if (typeof second.token !== 'string' || !/^ch_[A-Za-z0-9_-]{43}$/.test(second.token)) throw new Error('Invalid CodeHarbor response');
  return second.token;
}

async function main(): Promise<void> {
  const options = parseBindOptions(process.argv.slice(2));
  const pat = await readSecret();
  const token = await bind(options, pat);
  process.stdout.write(`CodeHarbor API Key（只显示一次，请安全保存）：\n${token}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    // Upstream error messages may contain request details or credentials.
    const safe = error instanceof Error && /^(Usage:|CodeHarbor URL must|Invalid CodeHarbor URL|An interactive terminal|Cancelled|Invalid PAT|Invalid CodeHarbor response|CodeHarbor rejected)/.test(error.message)
      ? error.message : '绑定失败：无法安全连接到 CodeHarbor';
    process.stderr.write(`${safe}\n`);
    process.exitCode = 1;
  });
}
