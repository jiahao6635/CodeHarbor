import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexError, type IndexRequest, validateRequest } from './indexer.js';

const MAX_ADVERTISEMENT_BYTES = 1024 * 1024;
const MAX_PACK_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_CONCURRENT = 2;
const MAX_WAITING = 64;

type Waiter = { grant: () => void; cancel: () => void };

/** Bound cloud probes separately from callers, without caching authorization. */
export class CloneProbeGate {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly maxActive: number,
    private readonly maxWaiting: number,
    private readonly waitMs: number,
  ) {
    if (
      !Number.isSafeInteger(maxActive) ||
      maxActive < 1 ||
      !Number.isSafeInteger(maxWaiting) ||
      maxWaiting < 0 ||
      !Number.isSafeInteger(waitMs) ||
      waitMs < 1
    )
      throw new Error('Invalid clone authorization limit');
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new IndexError('AUTH_UNAVAILABLE', 'Clone authorization unavailable');
    if (this.active < this.maxActive && this.waiters.length === 0) {
      this.active++;
      return this.releaseOnce();
    }
    if (this.waiters.length >= this.maxWaiting) throw new IndexError('AUTH_BUSY', 'Clone authorization is busy');
    return await new Promise<() => void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const remove = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        remove();
        cleanup();
        reject(new IndexError('AUTH_UNAVAILABLE', 'Clone authorization unavailable'));
      };
      const waiter: Waiter = {
        grant: () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(this.releaseOnce());
        },
        cancel: () => {
          if (settled) return;
          settled = true;
          remove();
          cleanup();
          reject(new IndexError('AUTH_BUSY', 'Clone authorization is busy'));
        },
      };
      const timer = setTimeout(waiter.cancel, this.waitMs);
      timer.unref();
      this.waiters.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next.grant();
      else this.active--;
    };
  }
}

const gate = new CloneProbeGate(MAX_CONCURRENT, MAX_WAITING, TIMEOUT_MS);

function packet(text: string): string {
  return (Buffer.byteLength(text) + 4).toString(16).padStart(4, '0') + text;
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error('Missing Git response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > limit) throw new Error('Git response exceeds limit');
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks, size);
}

function readPacket(buffer: Buffer, offset: number): { next: number; data: Buffer | null } {
  if (offset + 4 > buffer.length) throw new Error('Incomplete Git packet');
  const header = buffer.toString('ascii', offset, offset + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('Invalid Git packet');
  const length = parseInt(header, 16);
  if (length === 0) return { next: offset + 4, data: null };
  if (length < 4 || length > 65520 || offset + length > buffer.length) throw new Error('Invalid Git packet length');
  return { next: offset + length, data: buffer.subarray(offset + 4, offset + length) };
}

function advertisedRef(data: Buffer, branch: string): { commit: string; capabilities: Set<string> } {
  let offset = 0;
  const service = readPacket(data, offset);
  offset = service.next;
  if (!['# service=git-upload-pack\n', '# service=git-upload-pack'].includes(service.data?.toString() ?? ''))
    throw new Error('Invalid Git service');
  const separator = readPacket(data, offset);
  offset = separator.next;
  if (separator.data !== null) throw new Error('Invalid Git advertisement');
  let capabilities: Set<string> | undefined;
  let commit: string | undefined;
  let finished = false;
  while (offset < data.length) {
    const line = readPacket(data, offset);
    offset = line.next;
    if (line.data === null) {
      finished = true;
      break;
    }
    let text = line.data.toString('utf8');
    if (!capabilities) {
      const nul = text.indexOf('\0');
      if (nul < 0) throw new Error('Git capabilities unavailable');
      capabilities = new Set(
        text
          .slice(nul + 1)
          .trim()
          .split(' '),
      );
      text = `${text.slice(0, nul)}\n`;
    }
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (.+)\n$/.exec(text);
    if (!match) throw new Error('Invalid Git ref');
    if (match[2] === `refs/heads/${branch}`) {
      if (commit || /^0+$/.test(match[1])) throw new Error('Invalid branch ref');
      commit = match[1];
    }
  }
  if (!finished || offset !== data.length || !capabilities?.has('shallow') || !commit)
    throw new Error('Git branch or shallow capability unavailable');
  if (commit.length === 64 && !capabilities.has('object-format=sha256'))
    throw new Error('Git object format unavailable');
  return { commit, capabilities };
}

function validPackResponse(data: Buffer, commit: string, sideband: boolean): Buffer | null {
  let offset = 0;
  let acknowledged = false;
  while (offset < data.length) {
    const line = readPacket(data, offset);
    offset = line.next;
    if (line.data === null) continue;
    const text = line.data.toString('utf8');
    if (text === 'NAK\n' || /^ACK [0-9a-f]{40,64}(?: (?:continue|common|ready))?\n$/.test(text)) {
      acknowledged = true;
      break;
    }
    if (!/^(?:shallow|unshallow) [0-9a-f]{40,64}\n?$/.test(text)) return null;
  }
  if (!acknowledged) return null;
  let pack: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    let finished = false;
    while (offset < data.length) {
      const line = readPacket(data, offset);
      offset = line.next;
      if (line.data === null) {
        finished = true;
        break;
      }
      if (!line.data.length) return null;
      const band = line.data[0];
      if (band === 1) parts.push(line.data.subarray(1));
      else if (band !== 2) return null;
    }
    if (!finished || offset !== data.length) return null;
    pack = Buffer.concat(parts);
  } else pack = data.subarray(offset);
  const hashBytes = commit.length === 64 ? 32 : 20;
  if (pack.length <= 12 + hashBytes || pack.toString('ascii', 0, 4) !== 'PACK') return null;
  const version = pack.readUInt32BE(4);
  const objects = pack.readUInt32BE(8);
  if ((version !== 2 && version !== 3) || objects === 0 || objects > 100_000) return null;
  const digest = createHash(hashBytes === 32 ? 'sha256' : 'sha1')
    .update(pack.subarray(0, -hashBytes))
    .digest();
  return digest.equals(pack.subarray(-hashBytes)) ? pack : null;
}

async function runGit(args: string[], cwd: string, input: Buffer | undefined, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Git probe timed out'));
      return;
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    };
    // Bound file and address-space use for malformed or highly compressed packs on Linux.
    const command = process.platform === 'linux' ? '/bin/sh' : 'git';
    const commandArgs =
      process.platform === 'linux'
        ? ['-c', 'ulimit -v 262144 && ulimit -f 65536 && exec git "$@"', 'codeharbor-auth', ...args]
        : args;
    const child = spawn(command, commandArgs, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const stop = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    signal.addEventListener('abort', stop, { once: true });
    child.stdin.on('error', () => {});
    child.on('error', () => {
      signal.removeEventListener('abort', stop);
      reject(new Error('Git probe could not start'));
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', stop);
      if (code === 0 && !signal.aborted) resolve();
      else reject(new Error('Git pack validation failed'));
    });
    child.stdin.end(input);
  });
}

async function verifyPack(pack: Buffer, commit: string, signal: AbortSignal): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'codeharbor-auth-'));
  try {
    await runGit(
      ['init', '--bare', ...(commit.length === 64 ? ['--object-format=sha256'] : [])],
      home,
      undefined,
      signal,
    );
    await runGit(['index-pack', '--stdin', '--threads=1', `--max-input-size=${MAX_PACK_BYTES}`], home, pack, signal);
    await runGit(['cat-file', '-e', `${commit}^{commit}`], home, undefined, signal);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Prove this identity can receive a complete bounded Git upload-pack response. */
export async function checkCloneAccess(request: IndexRequest, signal?: AbortSignal): Promise<boolean> {
  const release = await gate.acquire(signal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    if (combined.aborted) throw new Error('Clone authorization cancelled');
    const origin = new URL(validateRequest(request));
    if (request.gitUsername.includes(':')) return false;
    const auth = `Basic ${Buffer.from(`${request.gitUsername}:${request.token}`).toString('base64')}`;
    const base = origin.pathname.replace(/\/$/, '');
    const advertisement = new URL(origin);
    advertisement.pathname = `${base}/info/refs`;
    advertisement.search = '?service=git-upload-pack';
    const response = await fetch(advertisement, {
      redirect: 'error',
      signal: combined,
      headers: { authorization: auth },
    });
    if (combined.aborted) throw new Error('Clone authorization cancelled');
    if ([401, 403, 404].includes(response.status)) return false;
    if (
      !response.ok ||
      response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !==
        'application/x-git-upload-pack-advertisement'
    )
      throw new Error('Git advertisement unavailable');
    const { commit, capabilities } = advertisedRef(
      await readBounded(response, MAX_ADVERTISEMENT_BYTES),
      request.branch,
    );
    const sideband = capabilities.has('side-band-64k') || capabilities.has('side-band');
    const selected = [
      capabilities.has('side-band-64k') ? 'side-band-64k' : capabilities.has('side-band') ? 'side-band' : '',
      capabilities.has('filter') ? 'filter' : '',
      commit.length === 64 ? 'object-format=sha256' : '',
    ].filter(Boolean);
    const body =
      packet(`want ${commit}${selected.length ? ` ${selected.join(' ')}` : ''}\n`) +
      packet('deepen 1\n') +
      (capabilities.has('filter') ? packet('filter blob:none\n') : '') +
      '0000' +
      packet('done\n');
    const upload = new URL(origin);
    upload.pathname = `${base}/git-upload-pack`;
    const result = await fetch(upload, {
      method: 'POST',
      redirect: 'error',
      signal: combined,
      headers: {
        authorization: auth,
        'content-type': 'application/x-git-upload-pack-request',
        accept: 'application/x-git-upload-pack-result',
      },
      body,
    });
    if (combined.aborted) throw new Error('Clone authorization cancelled');
    if ([401, 403, 404].includes(result.status)) return false;
    if (
      !result.ok ||
      result.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !==
        'application/x-git-upload-pack-result'
    )
      throw new Error('Git pack unavailable');
    const pack = validPackResponse(await readBounded(result, MAX_PACK_BYTES), commit, sideband);
    if (!pack) throw new Error('Invalid Git pack');
    await verifyPack(pack, commit, combined);
    if (combined.aborted) throw new Error('Clone authorization cancelled');
    return true;
  } catch {
    throw new IndexError('AUTH_UNAVAILABLE', 'Clone authorization unavailable');
  } finally {
    clearTimeout(timer);
    controller.abort();
    release();
  }
}
