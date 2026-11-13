import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, unlink } from 'node:fs/promises';
import net from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import { validImageIdentity, type ImageDigest } from './image-codegraph.js';

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const maxMessageBytes = 4096;

function validateConfig(path: string, token: string, timeoutMs: number): void {
  if (!isAbsolute(path) || path.includes('\0') || typeof token !== 'string' ||
      Buffer.byteLength(token) < 32 || Buffer.byteLength(token) > 1024 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid image authorizer configuration');
}

function equalToken(left: string, right: string): boolean {
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(left), hash(right));
}

function validRequest(digest: string, repoId: string, commit: string): boolean {
  return typeof digest === 'string' && digestPattern.test(digest) && validImageIdentity({ repoId, commit });
}

/** A failed, invalid or timed-out authorization never authorizes an image. */
export class SocketImageAuthorizer {
  constructor(private readonly path: string, private readonly token: string, private readonly timeoutMs = 30_000) {
    validateConfig(path, token, timeoutMs);
  }

  async authorize(digest: string, repoId: string, commit: string, signal?: AbortSignal): Promise<boolean> {
    if (!validRequest(digest, repoId, commit)) return false;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (combined.aborted) return false;
    const payload = Buffer.from(`${JSON.stringify({ token: this.token, digest, repoId, commit })}\n`);
    if (payload.length > maxMessageBytes) return false;
    return await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ path: this.path });
      let data = Buffer.alloc(0); let complete = false;
      const finish = (value: boolean) => {
        if (complete) return; complete = true;
        combined.removeEventListener('abort', abort); socket.destroy(); resolve(value);
      };
      const abort = () => finish(false);
      combined.addEventListener('abort', abort, { once: true });
      socket.once('connect', () => socket.write(payload));
      socket.on('data', (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        if (data.length > maxMessageBytes) return finish(false);
        const end = data.indexOf(10);
        if (end < 0) return;
        if (end !== data.length - 1) return finish(false);
        try {
          const value: unknown = JSON.parse(data.subarray(0, end).toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value) ||
              Object.keys(value).length !== 1 || !Object.hasOwn(value, 'allowed')) return finish(false);
          finish((value as { allowed?: unknown }).allowed === true);
        } catch { finish(false); }
      });
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
    });
  }
}

/** The callback checks committed metadata or an explicitly tracked candidate. */
export async function serveImageAuthorizer(options: {
  path: string;
  token: string;
  authorize: (digest: ImageDigest, repoId: string, commit: string, signal: AbortSignal) => Promise<boolean>;
  timeoutMs?: number;
  socketMode?: 0o600 | 0o660;
}): Promise<{ close(): Promise<void> }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  validateConfig(options.path, options.token, timeoutMs);
  if (typeof options.authorize !== 'function' ||
      (options.socketMode !== undefined && options.socketMode !== 0o600 && options.socketMode !== 0o660)) {
    throw new Error('Invalid image authorizer configuration');
  }
  const parent = await lstat(dirname(options.path));
  const uid = process.getuid?.();
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0 ||
      (uid !== undefined && parent.uid !== uid)) throw new Error('Unsafe image authorizer socket directory');

  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    let input = Buffer.alloc(0); let handled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); socket.destroy(); }, timeoutMs);
    timer.unref();
    socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); controller.abort(); });
    socket.on('error', () => controller.abort());
    const reply = (allowed: boolean) => { if (!socket.destroyed) socket.end(`${JSON.stringify({ allowed })}\n`); };
    socket.on('data', (chunk: Buffer) => {
      if (handled) return socket.destroy();
      input = Buffer.concat([input, chunk]);
      if (input.length > maxMessageBytes) return socket.destroy();
      const end = input.indexOf(10);
      if (end < 0) return;
      handled = true;
      if (end !== input.length - 1) return socket.destroy();
      void (async () => {
        try {
          const value: unknown = JSON.parse(input.subarray(0, end).toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) return reply(false);
          const body = value as Record<string, unknown>;
          const keys = ['token', 'digest', 'repoId', 'commit'];
          if (Object.keys(body).length !== keys.length || !keys.every(key => Object.hasOwn(body, key)) ||
              typeof body.token !== 'string' || !equalToken(body.token, options.token) ||
              typeof body.digest !== 'string' || typeof body.repoId !== 'string' || typeof body.commit !== 'string' ||
              !validRequest(body.digest, body.repoId, body.commit)) return reply(false);
          const allowed = await options.authorize(body.digest as ImageDigest, body.repoId, body.commit, controller.signal);
          reply(!controller.signal.aborted && allowed === true);
        } catch { reply(false); }
      })();
    });
  });
  // The query controller supports up to 32 simultaneous queries; retain room for control traffic.
  server.maxConnections = 48;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.path, () => { server.removeListener('error', reject); resolve(); });
  });
  let identity: Awaited<ReturnType<typeof lstat>>;
  try { await chmod(options.path, options.socketMode ?? 0o600); identity = await lstat(options.path); }
  catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  return { async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    try {
      const current = await lstat(options.path);
      if (current.isSocket() && current.ino === identity.ino && current.dev === identity.dev) await unlink(options.path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } };
}
