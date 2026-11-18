import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, unlink } from 'node:fs/promises';
import net from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import { type CodeGraphToolCall, validCodeGraphToolCall } from './codegraph-tools.js';

export interface InternalMcpRepository {
  repo_id: string;
  name: string;
  status: string;
  indexed_commit: string | null;
  indexed_at: string | null;
  stale: boolean;
}
export interface InternalMcpBackend {
  callTool?(
    authorization: string,
    repoId: string,
    call: CodeGraphToolCall,
    signal: AbortSignal,
  ): Promise<{ repository: InternalMcpRepository; result: unknown } | null>;
  probe(signal: AbortSignal): Promise<true>;
  authenticate(authorization: string): Promise<boolean>;
  list(authorization: string, signal: AbortSignal): Promise<InternalMcpRepository[]>;
  get(authorization: string, repoId: string, signal: AbortSignal): Promise<InternalMcpRepository | null>;
  explore(
    authorization: string,
    repoId: string,
    query: string,
    signal: AbortSignal,
  ): Promise<{ repository: InternalMcpRepository; result: unknown } | null>;
}

const MAX_REQUEST = 16 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const repoIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const bearerPattern = /^Bearer ch_[A-Za-z0-9_-]{43}$/;

function equalToken(left: string, right: string): boolean {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(left), hash(right));
}
function keysMatch(body: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(body).length === keys.length && keys.every((key) => Object.hasOwn(body, key));
}

/** The caller must hold the platform's exclusive instance lock and own the socket directory. */
async function removeStaleSocket(path: string, uid: number): Promise<void> {
  let previous: Awaited<ReturnType<typeof lstat>>;
  try {
    previous = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!previous.isSocket() || previous.isSymbolicLink() || previous.uid !== uid)
    throw new Error('Unsafe internal MCP socket');
  const stale = await new Promise<boolean>((resolve, reject) => {
    const connection = net.createConnection({ path });
    connection.setTimeout(1_000);
    connection.once('connect', () => {
      connection.destroy();
      reject(new Error('Internal MCP socket is active'));
    });
    connection.once('timeout', () => {
      connection.destroy();
      reject(new Error('Internal MCP socket probe timed out'));
    });
    connection.once('error', (error: NodeJS.ErrnoException) => {
      connection.destroy();
      if (error.code === 'ECONNREFUSED') resolve(true);
      else if (error.code === 'ENOENT') resolve(false);
      else reject(new Error('Internal MCP socket probe failed'));
    });
  });
  if (!stale) return;
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    !current.isSocket() ||
    current.isSymbolicLink() ||
    current.uid !== uid ||
    current.dev !== previous.dev ||
    current.ino !== previous.ino
  )
    throw new Error('Internal MCP socket changed during recovery');
  await unlink(path);
}

/** Restricted local IPC; the service token and user credential are both required. */
export async function createInternalMcpHandler(options: {
  path: string;
  token: string;
  backend: InternalMcpBackend;
  timeoutMs?: number;
  socketMode?: 0o600 | 0o660;
}): Promise<{ close(): Promise<void> }> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (
    !isAbsolute(options.path) ||
    options.path.includes('\0') ||
    typeof options.token !== 'string' ||
    Buffer.byteLength(options.token) < 32 ||
    Buffer.byteLength(options.token) > 1024 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    (options.socketMode !== undefined && options.socketMode !== 0o600 && options.socketMode !== 0o660)
  ) {
    throw new Error('Invalid internal MCP configuration');
  }
  const parent = await lstat(dirname(options.path));
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0 ||
    parent.uid !== uid
  )
    throw new Error('Unsafe internal MCP socket directory');
  await removeStaleSocket(options.path, uid);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let data = Buffer.alloc(0);
    let handled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      socket.destroy();
    }, timeoutMs);
    timer.unref();
    socket.once('close', () => {
      clearTimeout(timer);
      sockets.delete(socket);
      controller.abort();
    });
    socket.on('error', () => controller.abort());
    const reply = (value: unknown) => {
      if (socket.destroyed || controller.signal.aborted) return;
      let output: string;
      try {
        output = `${JSON.stringify(value)}\n`;
      } catch {
        output = '{"ok":false}\n';
      }
      if (Buffer.byteLength(output) > MAX_RESPONSE) output = '{"ok":false}\n';
      socket.end(output);
    };
    socket.on('data', (chunk: Buffer) => {
      if (handled) return socket.destroy();
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_REQUEST) return socket.destroy();
      const end = data.indexOf(10);
      if (end < 0) return;
      handled = true;
      if (end !== data.length - 1) return socket.destroy();
      void (async () => {
        try {
          const parsed: unknown = JSON.parse(data.subarray(0, end).toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reply({ ok: false });
          const body = parsed as Record<string, unknown>;
          if (typeof body.token !== 'string' || body.token.length > 1024 || !equalToken(body.token, options.token))
            return reply({ ok: false });
          if (body.op === 'probe' && keysMatch(body, ['op', 'token'])) {
            return reply({ ok: true, result: await options.backend.probe(controller.signal) });
          }
          if (typeof body.authorization !== 'string' || !bearerPattern.test(body.authorization))
            return reply({ ok: false });
          const authorization = body.authorization;
          let result: unknown;
          if (body.op === 'authenticate' && keysMatch(body, ['op', 'token', 'authorization'])) {
            result = await options.backend.authenticate(authorization);
          } else if (body.op === 'list' && keysMatch(body, ['op', 'token', 'authorization'])) {
            result = await options.backend.list(authorization, controller.signal);
          } else if (
            (body.op === 'get' || body.op === 'explore' || body.op === 'call_tool') &&
            typeof body.repoId === 'string' &&
            repoIdPattern.test(body.repoId)
          ) {
            if (body.op === 'get' && keysMatch(body, ['op', 'token', 'authorization', 'repoId'])) {
              result = await options.backend.get(authorization, body.repoId, controller.signal);
            } else if (
              body.op === 'explore' &&
              keysMatch(body, ['op', 'token', 'authorization', 'repoId', 'query']) &&
              typeof body.query === 'string' &&
              body.query.trim() &&
              body.query.length <= 2000
            ) {
              result = await options.backend.explore(authorization, body.repoId, body.query, controller.signal);
            } else if (
              body.op === 'call_tool' &&
              keysMatch(body, ['op', 'token', 'authorization', 'repoId', 'call']) &&
              validCodeGraphToolCall(body.call) &&
              options.backend.callTool
            ) {
              result = await options.backend.callTool(authorization, body.repoId, body.call, controller.signal);
            } else return reply({ ok: false });
          } else return reply({ ok: false });
          reply({ ok: true, result });
        } catch {
          reply({ ok: false });
        }
      })();
    });
  });
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.path, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  let identity: Awaited<ReturnType<typeof lstat>>;
  try {
    await chmod(options.path, options.socketMode ?? 0o600);
    identity = await lstat(options.path);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      try {
        const current = await lstat(options.path);
        if (current.isSocket() && current.ino === identity.ino && current.dev === identity.dev)
          await unlink(options.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}
