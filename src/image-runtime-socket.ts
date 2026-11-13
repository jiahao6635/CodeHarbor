import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, unlink } from 'node:fs/promises';
import net from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import { IMAGE_PROJECT_PATH, validImageIdentity, type ImageDigest, type ImageQueryBackend } from './image-codegraph.js';
import { ImageRuntimeCancelledError, ImageRuntimeRequestError, ImageRuntimeUncertainError } from './image-runtime-errors.js';
import { queryConcurrency } from './query-concurrency.js';

const maxRequestBytes = 16 * 1024;
const maxResponseBytes = 2 * 1024 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

function validateConfig(path: string, token: string, timeoutMs: number): void {
  if (!isAbsolute(path) || path.includes('\0') || typeof token !== 'string' || Buffer.byteLength(token) < 32 ||
      Buffer.byteLength(token) > 1024 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid image runtime configuration');
}

function equalToken(left: string, right: string): boolean {
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(left), hash(right));
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Limited local protocol: the public process cannot pass Docker parameters or paths. */
export class SocketImageQueryBackend implements ImageQueryBackend {
  constructor(private readonly path: string, private readonly token: string, private readonly timeoutMs = 30_000) {
    validateConfig(path, token, timeoutMs);
  }

  private async request(body: Record<string, unknown>, signal: AbortSignal, cleanupAware = false): Promise<unknown> {
    if (signal.aborted) throw new ImageRuntimeCancelledError();
    const payload = Buffer.from(`${JSON.stringify({ ...body, token: this.token })}\n`);
    if (payload.length > maxRequestBytes) throw new ImageRuntimeRequestError('Image runtime request too large');
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.path });
      let data = Buffer.alloc(0); let done = false; let submitted = false; let cancelled = false;
      let cleanupTimer: NodeJS.Timeout | undefined;
      const finish = (error?: Error, value?: unknown) => {
        if (done) return; done = true; signal.removeEventListener('abort', aborted); if (cleanupTimer) clearTimeout(cleanupTimer); socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      const uncertain = () => cleanupAware && submitted ? new ImageRuntimeUncertainError() : new ImageRuntimeRequestError('Image runtime unavailable');
      const aborted = () => {
        cancelled = true;
        if (!cleanupAware || !submitted) return finish(new ImageRuntimeCancelledError());
        // Keep the connection open until the controller confirms container cleanup.
        socket.write('{"op":"cancel"}\n');
        cleanupTimer = setTimeout(() => finish(new ImageRuntimeUncertainError()), this.timeoutMs);
        cleanupTimer.unref();
      };
      signal.addEventListener('abort', aborted, { once: true });
      socket.once('connect', () => { if (done) return; submitted = true; socket.write(payload); });
      socket.on('data', (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        if (data.length > maxResponseBytes) return finish(uncertain());
        const line = data.indexOf(10);
        if (line < 0) return;
        if (line !== data.length - 1) return finish(uncertain());
        try {
          const response: unknown = JSON.parse(data.subarray(0, line).toString('utf8'));
          if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error();
          const result = response as Record<string, unknown>;
          if (result.ok === false && cleanupAware && exactKeys(result, ['ok', 'cleaned']) && result.cleaned === true) {
            return finish(cancelled ? new ImageRuntimeCancelledError() : new ImageRuntimeRequestError());
          }
          if (result.ok !== true || !exactKeys(result, ['ok', 'result'])) return finish(uncertain());
          if (cancelled) return finish(new ImageRuntimeCancelledError());
          finish(undefined, result.result);
        } catch { finish(uncertain()); }
      });
      socket.once('error', () => finish(uncertain()));
      socket.once('close', () => finish(uncertain()));
    });
  }

  async explore(input: Parameters<ImageQueryBackend['explore']>[0]): Promise<string> {
    if (input.readOnlyRoot !== true || input.projectPath !== IMAGE_PROJECT_PATH || !digestPattern.test(input.digest) || !validImageIdentity(input) ||
        typeof input.query !== 'string' || !input.query.trim() || input.query.length > 2000) throw new ImageRuntimeRequestError('Invalid image runtime request');
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(this.timeoutMs)]);
    const result = await this.request({ op: 'explore', digest: input.digest, repoId: input.repoId, commit: input.commit, query: input.query }, signal, true);
    if (typeof result !== 'string' || Buffer.byteLength(result) > 1024 * 1024) throw new ImageRuntimeRequestError('Invalid image runtime result');
    return result;
  }

  async probe(signal: AbortSignal): Promise<void> {
    await this.request({ op: 'probe' }, AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]));
  }

  async close(): Promise<void> {
    await this.request({ op: 'drain' }, AbortSignal.timeout(this.timeoutMs));
  }
}

/**
 * Serve the controller on a private Unix socket. Callers must secure the parent
 * directory and token file; image authorization happens in the supplied backend.
 */
export async function serveImageRuntime(options: {
  path: string; token: string; backend: ImageQueryBackend; timeoutMs?: number;
  maxConcurrent?: number;
  /** 0600 by default; 0660 only when the directory/socket group is trusted. */
  socketMode?: 0o600 | 0o660;
}): Promise<{ close(): Promise<void> }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  validateConfig(options.path, options.token, timeoutMs);
  const maxConcurrent = options.maxConcurrent === undefined ? queryConcurrency() : queryConcurrency(String(options.maxConcurrent));
  if (options.socketMode !== undefined && options.socketMode !== 0o600 && options.socketMode !== 0o660) throw new Error('Invalid image runtime socket mode');
  const parent = await lstat(dirname(options.path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0) throw new Error('Unsafe image runtime socket directory');
  let activeQueries = 0; let draining = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let data = Buffer.alloc(0); let handled = false; let active = false; let cancelled = false;
    const abort = new AbortController();
    let cleanupTimeout: NodeJS.Timeout | undefined;
    const cancel = () => {
      abort.abort();
      if (active && !cleanupTimeout) {
        cleanupTimeout = setTimeout(() => socket.destroy(), timeoutMs);
        cleanupTimeout.unref();
      }
    };
    const timeout = setTimeout(() => { cancel(); if (!active) socket.destroy(); }, timeoutMs);
    timeout.unref();
    socket.once('close', () => { clearTimeout(timeout); if (cleanupTimeout) clearTimeout(cleanupTimeout); sockets.delete(socket); abort.abort(); });
    socket.on('error', () => { abort.abort(); });
    const reply = (result: unknown) => { if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: true, result })}\n`); };
    const fail = (cleaned = false) => { if (!socket.destroyed) socket.end(cleaned ? '{"ok":false,"cleaned":true}\n' : '{"ok":false}\n'); };
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > maxRequestBytes) return socket.destroy();
      for (;;) {
        const end = data.indexOf(10);
        if (end < 0) return;
        const line = data.subarray(0, end); data = data.subarray(end + 1);
        if (handled) {
          try {
            const next: unknown = JSON.parse(line.toString('utf8'));
            if (!active || cancelled || !next || typeof next !== 'object' || Array.isArray(next) ||
                !exactKeys(next as Record<string, unknown>, ['op']) || (next as Record<string, unknown>).op !== 'cancel') return socket.destroy();
            cancelled = true; cancel();
          } catch { return socket.destroy(); }
          continue;
        }
        handled = true;
      void (async () => {
        try {
          const parsed: unknown = JSON.parse(line.toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail();
          const request = parsed as Record<string, unknown>;
          if (typeof request.token !== 'string' || !equalToken(request.token, options.token)) return fail();
          if (request.op === 'drain' && exactKeys(request, ['op', 'token'])) {
            if (draining) return fail();
            draining = true;
            try { await options.backend.close(); reply(null); } finally { draining = false; }
            return;
          }
          if (draining) return fail();
          if (request.op === 'probe' && exactKeys(request, ['op', 'token'])) {
            await options.backend.probe(abort.signal); reply(null);
            return;
          }
          if (request.op !== 'explore' || !exactKeys(request, ['op', 'token', 'digest', 'repoId', 'commit', 'query']) ||
              typeof request.digest !== 'string' || !digestPattern.test(request.digest) || typeof request.query !== 'string' ||
              !request.query.trim() || request.query.length > 2000 || typeof request.repoId !== 'string' ||
              typeof request.commit !== 'string' || !validImageIdentity({ repoId: request.repoId, commit: request.commit })) return fail();
          if (activeQueries >= maxConcurrent) return fail(true);
          activeQueries++; active = true;
          try {
            const result = await options.backend.explore({ digest: request.digest as ImageDigest, repoId: request.repoId, commit: request.commit, query: request.query,
              projectPath: IMAGE_PROJECT_PATH, readOnlyRoot: true, signal: abort.signal });
            if (typeof result !== 'string' || Buffer.byteLength(result) > 1024 * 1024) return fail(true);
            reply(result);
          } catch (error) { fail(error instanceof ImageRuntimeRequestError); }
          finally { active = false; activeQueries--; }
        } catch { fail(); }
      })();
      }
    });
  });
  // Keep control/probe capacity even when every query slot is occupied.
  server.maxConnections = maxConcurrent + 16;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.path, () => { server.removeListener('error', reject); resolve(); });
  });
  let identity: Awaited<ReturnType<typeof lstat>>;
  try { await chmod(options.path, options.socketMode ?? 0o600); identity = await lstat(options.path); }
  catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return { async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await options.backend.close();
    try { const current = await lstat(options.path); if (current.isSocket() && current.ino === identity.ino && current.dev === identity.dev) await unlink(options.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } };
}
