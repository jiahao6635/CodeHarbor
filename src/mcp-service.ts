import { createServer, type Server } from 'node:http';
import net from 'node:net';
import { isAbsolute } from 'node:path';
import { createLogger } from './logger.js';
import { createMcpHandler, type McpRepository } from './mcp.js';

export interface McpServiceBackend {
  authenticate(authorization: string): Promise<boolean>;
  list(authorization: string, signal?: AbortSignal): Promise<McpRepository[]>;
  get(authorization: string, repoId: string, signal?: AbortSignal): Promise<McpRepository | null>;
  explore(
    authorization: string,
    repoId: string,
    query: string,
    signal: AbortSignal,
  ): Promise<{ repository: McpRepository; result: string } | null>;
  probe(signal: AbortSignal): Promise<void>;
}

function repository(value: unknown): McpRepository {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid repository response');
  const row = value as Record<string, unknown>;
  const keys = ['repo_id', 'name', 'status', 'indexed_commit', 'indexed_at', 'stale'];
  if (
    Object.keys(row).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(row, key)) ||
    typeof row.repo_id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(row.repo_id) ||
    typeof row.name !== 'string' ||
    row.name.length > 4096 ||
    typeof row.status !== 'string' ||
    row.status.length > 128 ||
    !(row.indexed_commit === null || typeof row.indexed_commit === 'string') ||
    !(row.indexed_at === null || typeof row.indexed_at === 'string') ||
    typeof row.stale !== 'boolean'
  ) {
    throw new Error('Invalid repository response');
  }
  return {
    id: row.repo_id,
    name: row.name,
    status: row.status,
    indexedCommit: row.indexed_commit as string | null,
    indexedAt: row.indexed_at as string | null,
    stale: row.stale,
    projectPath: null,
  };
}

/** Internal RPC client; each operation forwards the original caller's authorization. */
export class SocketMcpBackend implements McpServiceBackend {
  constructor(
    private readonly path: string,
    private readonly token: string,
    private readonly timeoutMs = 60_000,
  ) {
    if (
      !isAbsolute(path) ||
      path.includes('\0') ||
      typeof token !== 'string' ||
      Buffer.byteLength(token) < 32 ||
      Buffer.byteLength(token) > 1024 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1
    )
      throw new Error('Invalid internal MCP configuration');
  }

  private async request(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (combined.aborted) throw new Error('MCP backend request cancelled');
    const payload = Buffer.from(`${JSON.stringify({ token: this.token, ...body })}\n`);
    if (payload.length > 16 * 1024) throw new Error('MCP backend request too large');
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.path });
      let data = Buffer.alloc(0);
      let done = false;
      const finish = (error?: Error, value?: unknown) => {
        if (done) return;
        done = true;
        combined.removeEventListener('abort', aborted);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      const aborted = () => finish(new Error('MCP backend request cancelled'));
      combined.addEventListener('abort', aborted, { once: true });
      socket.once('connect', () => socket.write(payload));
      socket.on('data', (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        if (data.length > 2 * 1024 * 1024) return finish(new Error('MCP backend response too large'));
        const end = data.indexOf(10);
        if (end < 0) return;
        if (end !== data.length - 1) return finish(new Error('Invalid MCP backend response'));
        try {
          const response: unknown = JSON.parse(data.subarray(0, end).toString('utf8'));
          if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error();
          const row = response as Record<string, unknown>;
          if (row.ok !== true || Object.keys(row).length !== 2 || !Object.hasOwn(row, 'result')) throw new Error();
          finish(undefined, row.result);
        } catch {
          finish(new Error('MCP backend unavailable'));
        }
      });
      socket.once('error', () => finish(new Error('MCP backend unavailable')));
      socket.once('close', () => finish(new Error('MCP backend connection closed')));
    });
  }

  async authenticate(authorization: string): Promise<boolean> {
    const result = await this.request({ op: 'authenticate', authorization });
    if (typeof result !== 'boolean') throw new Error('Invalid authentication response');
    return result;
  }
  async list(authorization: string, signal?: AbortSignal): Promise<McpRepository[]> {
    const result = await this.request({ op: 'list', authorization }, signal);
    if (!Array.isArray(result)) throw new Error('Invalid repository list');
    return result.map(repository);
  }
  async get(authorization: string, repoId: string, signal?: AbortSignal): Promise<McpRepository | null> {
    const result = await this.request({ op: 'get', authorization, repoId }, signal);
    return result === null ? null : repository(result);
  }
  async explore(
    authorization: string,
    repoId: string,
    query: string,
    signal: AbortSignal,
  ): Promise<{ repository: McpRepository; result: string } | null> {
    const response = await this.request({ op: 'explore', authorization, repoId, query }, signal);
    if (response === null) return null;
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid query response');
    const row = response as Record<string, unknown>;
    if (
      Object.keys(row).length !== 2 ||
      !Object.hasOwn(row, 'repository') ||
      typeof row.result !== 'string' ||
      Buffer.byteLength(row.result) > 1024 * 1024
    )
      throw new Error('Invalid query response');
    return { repository: repository(row.repository), result: row.result };
  }
  async probe(signal: AbortSignal): Promise<void> {
    if ((await this.request({ op: 'probe' }, signal)) !== true) throw new Error('MCP backend unavailable');
  }
}

/** The HTTP surface has no platform management endpoints or direct database access. */
export type McpHttpAccessEvent = {
  event: 'http_request';
  method: string;
  route: string;
  status: number;
  duration_ms: number;
};
const defaultLog = createLogger({ name: 'codeharbor-mcp' });

export function createMcpService(options: {
  backend: McpServiceBackend;
  allowedHosts: string[];
  allowedOrigins?: string[];
  log?: (event: McpHttpAccessEvent) => void;
}): {
  server: Server;
  listen(options: { port: number; host: string }): Promise<void>;
  close(): Promise<void>;
} {
  if (!options.allowedHosts.length) throw new Error('MCP allowed hosts are required');
  const handler = createMcpHandler<string>({
    allowedHosts: options.allowedHosts,
    allowedOrigins: options.allowedOrigins,
    async authenticate(req) {
      const authorization = req.headers.authorization;
      if (!authorization || !/^Bearer ch_[A-Za-z0-9_-]{43}$/.test(authorization)) return null;
      return (await options.backend.authenticate(authorization)) ? authorization : null;
    },
    listRepositories: (auth, signal) => options.backend.list(auth, signal),
    getRepository: (auth, id, signal) => options.backend.get(auth, id, signal),
    remoteExplore: (auth, id, query, signal) => options.backend.explore(auth, id, query, signal),
  });
  const server = createServer((req, res) => {
    const started = performance.now();
    const method = ['GET', 'POST', 'HEAD', 'OPTIONS'].includes(req.method ?? '') ? req.method! : 'OTHER';
    let route = '<other>';
    let logged = false;
    const log = () => {
      if (logged) return;
      logged = true;
      const event: McpHttpAccessEvent = {
        event: 'http_request',
        method,
        route,
        status: res.writableFinished ? res.statusCode : 0,
        duration_ms: Math.max(0, performance.now() - started),
      };
      try {
        if (options.log) options.log(event);
        else defaultLog.info(event, 'http_request');
      } catch {
        /* Logging cannot change a response. */
      }
    };
    res.once('finish', log);
    res.once('close', log);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    if (
      !req.headers.host ||
      !options.allowedHosts.includes(req.headers.host) ||
      (req.headers.origin && !options.allowedOrigins?.includes(req.headers.origin))
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://local').pathname;
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (pathname === '/mcp' || pathname === '/health/live' || pathname === '/health/ready') route = pathname;
    if (pathname === '/mcp') {
      void handler(req, res).catch(() => {
        // A disconnected client or an unexpected protocol failure must not
        // become an unhandled rejection that terminates the listener.
        if (res.destroyed || res.writableEnded) return;
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end('{"jsonrpc":"2.0","error":{"code":-32000,"message":"Internal error"},"id":null}');
          } else res.destroy();
        } catch {
          res.destroy();
        }
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.method === 'GET' && pathname === '/health/ready') {
      void options.backend
        .probe(AbortSignal.timeout(5_000))
        .then(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"status":"ok"}');
        })
        .catch(() => {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end('{"status":"unavailable"}');
        });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return {
    server,
    listen: ({ port, host }) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      }),
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
