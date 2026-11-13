import type { IncomingMessage, ServerResponse } from 'node:http';
import Fastify, { LogController } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';
import { CredentialCipher, createAccessKey, hashAccessKey, constantTimeEqual } from './auth.js';
import { CodeupClient, CodeupError, hasRepositoryRole } from './codeup.js';
import type { KeyRecord, RepositoryRecord } from './store.js';
import { AsyncSqliteStore, type StoreBackend } from './async-store.js';
import { CodeGraphClient, type GraphClient } from './codegraph.js';
import { createMcpHandler, type McpRepository } from './mcp.js';
import { IndexError, verifyPushWebhook } from './indexer.js';
import { checkCloneAccess } from './clone-access.js';
import type { IndexRequest } from './indexer.js';
import { IndexWorker } from './worker.js';
import type { ImageIndexPipeline } from './image-indexer.js';
import { openApiDocument } from './openapi.js';
import { renderJobMetrics } from './job-metrics.js';
import type { InternalMcpBackend, InternalMcpRepository } from './internal-mcp.js';

export interface AppConfig {
  dataDir: string;
  databasePath: string;
  credentialKey: Buffer;
  codeupEndpoint: string;
  organizationId?: string;
  allowedGitHosts: string[];
  allowedHosts: string[];
  allowedOrigins?: string[];
  writeUsers: string[];
  codegraphBin: string;
  reconcileMs?: number;
  /** Monitoring credential loaded by the caller from a protected secret source. */
  metricsToken?: string;
  /** Disable the legacy public MCP endpoint when the dedicated service is enabled. */
  publicMcpDisabled?: boolean;
}

type Principal = KeyRecord;
export type AuditEvent = {
  request_id: string; method: string; route: string; status: number;
  authentication?: 'api_key' | 'yunxiao_pat' | 'bootstrap' | 'webhook';
  subject?: string; key_prefix?: string; repo_id?: string;
  tool?: string; tool_outcome?: 'success' | 'error';
};
class HttpError extends Error { constructor(public status: number, public code: string) { super(code); } }
function fail(status: number, code: string): never { throw new HttpError(status, code); }
function response(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_ARGUMENT');
  return value as Record<string, unknown>;
}
function only(obj: Record<string, unknown>, names: string[]) {
  if (Object.keys(obj).some(key => !names.includes(key))) fail(400, 'INVALID_ARGUMENT');
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(400, 'INVALID_ARGUMENT');
  return value;
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers['content-type'] ?? ''))) fail(415, 'UNSUPPORTED_MEDIA_TYPE');
  const payload = await new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = []; let size = 0; let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += part.length;
      if (size > 64 * 1024) { tooLarge = true; reject(new HttpError(413, 'BODY_TOO_LARGE')); return; }
      parts.push(part);
    });
    req.once('end', () => { if (!tooLarge) resolve(Buffer.concat(parts)); });
    req.once('error', reject);
    req.once('aborted', () => reject(new HttpError(400, 'INVALID_REQUEST')));
  });
  try { return plain(JSON.parse(payload.toString('utf8'))); }
  catch (error) { if (error instanceof HttpError) throw error; return fail(400, 'INVALID_JSON'); }
}
function view(repo: RepositoryRecord): McpRepository {
  return { id: repo.id, name: repo.name, status: repo.status, indexedCommit: repo.commit,
    indexedAt: repo.indexed_at === null ? null : new Date(repo.indexed_at).toISOString(),
    stale: repo.status !== 'ready', projectPath: repo.path };
}
function publicRepo(repo: RepositoryRecord) {
  const v = view(repo);
  return { repo_id: v.id, name: v.name, branch: repo.branch, status: v.status,
    indexed_commit: v.indexedCommit, indexed_at: v.indexedAt, stale: v.stale, error: repo.error };
}
function errorResponse(res: ServerResponse, error: unknown) {
  if (res.headersSent) { res.end(); return; }
  if (error instanceof HttpError) return response(res, error.status, { error: error.code });
  if (error instanceof IndexError) return response(res, ['AUTH_BUSY', 'AUTH_UNAVAILABLE'].includes(error.code) ? 503 : 400, { error: ['AUTH_BUSY', 'AUTH_UNAVAILABLE'].includes(error.code) ? 'AUTHORIZATION_UNAVAILABLE' : 'INVALID_REQUEST' });
  if (error instanceof CodeupError) {
    if (error.kind === 'invalid_credential') return response(res, 401, { error: 'INVALID_CREDENTIAL' });
    if (error.kind === 'forbidden' || error.kind === 'not_found') return response(res, 404, { error: 'NOT_FOUND' });
    return response(res, 503, { error: 'CODEUP_UNAVAILABLE' });
  }
  response(res, 500, { error: 'INTERNAL_ERROR' });
}

/** One instance only: the worker does not provide distributed coordination. */
export function createApp(config: AppConfig, deps: { codeup?: CodeupClient; graph?: GraphClient; worker?: IndexWorker; imagePipeline?: ImageIndexPipeline; store?: StoreBackend; audit?: (event: AuditEvent) => void; probe?: (request: IndexRequest, signal?: AbortSignal) => Promise<boolean> } = {}) {
  if (config.metricsToken !== undefined && (config.metricsToken.length < 32 || /[^\x21-\x7e]/.test(config.metricsToken))) throw new Error('Invalid metrics token');
  const store = deps.store ?? new AsyncSqliteStore(config.databasePath);
  const cipher = new CredentialCipher(config.credentialKey);
  const codeup = deps.codeup ?? new CodeupClient({ endpoint: config.codeupEndpoint, organizationId: config.organizationId });
  const graph = deps.graph ?? new CodeGraphClient(config.codegraphBin, config.dataDir);
  const worker = deps.worker ?? new IndexWorker({ store, codeup, cipher, graph, dataDir: config.dataDir, allowedGitHosts: config.allowedGitHosts, codegraphBin: config.codegraphBin, reconcileIntervalMs: config.reconcileMs,
    ...(deps.imagePipeline ? { build: (request: IndexRequest) => deps.imagePipeline!.build(request), healthy: (request: IndexRequest, reference: string, commit: string) => deps.imagePipeline!.healthy(request, reference, commit), releaseCandidate: (candidate: { path: string }) => deps.imagePipeline!.release(candidate.path) } : {}) });
  const sessions = new Map<string, { userId: string; expires: number }>();
  const attempts = new Map<string, { count: number; until: number }>();
  const actors = new WeakMap<IncomingMessage, Pick<AuditEvent, 'subject' | 'key_prefix' | 'authentication' | 'repo_id' | 'tool' | 'tool_outcome'>>();
  const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
  const counts = new Map<string, { method: string; status: number; count: number; seconds: number; buckets: number[] }>();
  function observe(method: string, status: number, seconds: number) {
    const normalized = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'OTHER';
    const code = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
    const id = `${normalized}:${code}`;
    const row = counts.get(id) ?? { method: normalized, status: code, count: 0, seconds: 0, buckets: buckets.map(() => 0) };
    row.count++; row.seconds += seconds; buckets.forEach((limit, index) => { if (seconds <= limit) row.buckets[index]++; }); counts.set(id, row);
  }
  function renderMetrics(): string {
    const output = ['# HELP codeharbor_http_requests_total HTTP requests.', '# TYPE codeharbor_http_requests_total counter',
      '# HELP codeharbor_http_request_duration_seconds HTTP request duration.', '# TYPE codeharbor_http_request_duration_seconds histogram'];
    for (const row of counts.values()) {
      const labels = `method="${row.method}",status="${row.status}"`;
      output.push(`codeharbor_http_requests_total{${labels}} ${row.count}`);
      buckets.forEach((limit, index) => output.push(`codeharbor_http_request_duration_seconds_bucket{${labels},le="${limit}"} ${row.buckets[index]}`));
      output.push(`codeharbor_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${row.count}`,
        `codeharbor_http_request_duration_seconds_sum{${labels}} ${row.seconds}`,
        `codeharbor_http_request_duration_seconds_count{${labels}} ${row.count}`);
    }
    return `${output.join('\n')}\n`;
  }
  // Serialize authorization changes after request bodies have been read. Never hold this lock while waiting for a client.
  let mutations: Promise<void> = Promise.resolve();
  async function mutate<T>(fn: () => Promise<T>): Promise<T> {
    const previous = mutations; let release!: () => void;
    mutations = new Promise<void>(resolve => { release = resolve; });
    await previous; try { return await fn(); } finally { release(); }
  }

  function bearer(authorization: string): string | null {
    const match = /^Bearer (ch_[A-Za-z0-9_-]{43})$/.exec(authorization);
    return match?.[1] ?? null;
  }
  async function authenticateBearer(authorization: string): Promise<Principal | null> {
    const token = bearer(authorization);
    if (!token) return null;
    const key = await store.getKey(hashAccessKey(token));
    if (!key || key.revoked || (key.expires_at !== null && key.expires_at <= Date.now()) || !(await store.getUser(key.owner))) return null;
    return key;
  }
  async function authenticate(req: IncomingMessage): Promise<Principal | null> {
    const key = await authenticateBearer(req.headers.authorization ?? '');
    if (!key) return null;
    actors.set(req, { ...actors.get(req), subject: key.owner, key_prefix: key.prefix, authentication: 'api_key' });
    return key;
  }
  function requireWrite(key: Principal) { if (key.scope !== 'write' || !config.writeUsers.includes(key.owner)) fail(403, 'FORBIDDEN'); }
  function keyAllows(key: Principal, repo: RepositoryRecord) {
    return key.repos === null ? key.scope === 'write' && config.writeUsers.includes(key.owner) : key.repos.includes(repo.id);
  }
  async function authorize(key: Principal, repo: RepositoryRecord, signal?: AbortSignal): Promise<RepositoryRecord | null> {
    if (!keyAllows(key, repo)) return null;
    return await mutate(async () => {
      if (signal?.aborted) throw new Error('Request cancelled');
      const currentKey = await store.getKey(key.hash);
      const latest = await store.getRepository(repo.id);
      return !!currentKey && !currentKey.revoked && currentKey.owner === key.owner && !!(await store.getUser(key.owner)) &&
        (currentKey.expires_at === null || currentKey.expires_at > Date.now()) && !!latest && latest.status !== 'disabled' &&
        keyAllows(currentKey, latest) && latest.codeup_id === repo.codeup_id && latest.branch === repo.branch &&
        latest.path === repo.path && latest.commit === repo.commit ? latest : null;
    });
  }
  async function visible(key: Principal, id: string, signal?: AbortSignal): Promise<RepositoryRecord> {
    const repo = await store.getRepository(id);
    if (!repo || repo.status === 'disabled') fail(404, 'NOT_FOUND');
    const authorized = await authorize(key, repo, signal);
    if (!authorized) fail(404, 'NOT_FOUND');
    return authorized;
  }
  async function listVisible(key: Principal, signal?: AbortSignal): Promise<RepositoryRecord[]> {
    const initial = await store.getUser(key.owner);
    if (!initial) fail(401, 'UNAUTHENTICATED');
    const result: RepositoryRecord[] = [];
    for (const repo of await store.listRepositories()) {
      if (signal?.aborted) throw new Error('Request cancelled');
      if (repo.status !== 'disabled') { const authorized = await authorize(key, repo, signal); if (authorized) result.push(authorized); }
    }
    return await mutate(async () => {
      const currentUser = await store.getUser(key.owner); const currentKey = await store.getKey(key.hash);
      if (!currentUser || !currentKey || currentKey.owner !== key.owner || currentKey.revoked ||
          (currentKey.expires_at !== null && currentKey.expires_at <= Date.now())) fail(401, 'UNAUTHENTICATED');
      return result;
    });
  }
  async function queryVisible(key: Principal, id: string, signal?: AbortSignal): Promise<RepositoryRecord> {
    if (key.repos === null) fail(404, 'NOT_FOUND');
    return await visible(key, id, signal);
  }
  async function queryList(key: Principal, signal?: AbortSignal): Promise<RepositoryRecord[]> {
    return key.repos === null ? [] : await listVisible(key, signal);
  }
  const internalRepository = (repo: RepositoryRecord): InternalMcpRepository => {
    const item = view(repo);
    return { repo_id: item.id, name: item.name, status: item.status, indexed_commit: item.indexedCommit,
      indexed_at: item.indexedAt, stale: item.stale };
  };
  async function internalPrincipal(authorization: string): Promise<Principal> {
    const key = await authenticateBearer(authorization);
    if (!key) throw new Error('Authentication required');
    return key;
  }
  function auditInternalTool(tool: 'list_repositories' | 'get_repository_status' | 'codegraph_explore', outcome: 'success' | 'error', principal?: Principal, repoId?: string) {
    const event: AuditEvent = { request_id: randomUUID(), method: 'POST', route: '/mcp', status: outcome === 'success' ? 200 : 400,
      tool, tool_outcome: outcome, ...(principal ? { subject: principal.owner, key_prefix: principal.prefix, authentication: 'api_key' as const } : {}),
      ...(principal && repoId && /^[A-Za-z0-9_-]{1,128}$/.test(repoId) ? { repo_id: repoId } : {}) };
    fastify.log.info(event, 'audit');
    try { deps.audit?.(event); } catch { /* Audit observers cannot alter a response. */ }
  }
  const internalMcp: InternalMcpBackend = {
    async probe(signal) {
      await store.checkHealth(); await graph.probe(signal);
      if (signal.aborted) throw new Error('Request cancelled');
      return true;
    },
    async authenticate(authorization) { return !!(await authenticateBearer(authorization)); },
    async list(authorization, signal) {
      let principal: Principal | undefined; let outcome: 'success' | 'error' = 'error';
      try {
        principal = await internalPrincipal(authorization);
        const repositories = await queryList(principal, signal);
        if (signal.aborted || !(await authenticateBearer(authorization))) throw new Error('Authentication required');
        outcome = 'success';
        return repositories.map(internalRepository);
      } finally { auditInternalTool('list_repositories', outcome, principal); }
    },
    async get(authorization, repoId, signal) {
      let principal: Principal | undefined; let outcome: 'success' | 'error' = 'error';
      try {
        principal = await internalPrincipal(authorization);
        const repo = await queryVisible(principal, repoId, signal);
        if (signal.aborted || !(await authenticateBearer(authorization))) throw new Error('Authentication required');
        outcome = 'success';
        return internalRepository(repo);
      } catch (error) { if (error instanceof HttpError && error.status === 404) return null; throw error; }
      finally { auditInternalTool('get_repository_status', outcome, principal, repoId); }
    },
    async explore(authorization, repoId, query, signal) {
      let principal: Principal | undefined;
      const auditOutcome: { value: 'success' | 'error' } = { value: 'error' };
      try {
        return await graph.withQuery(async explore => {
          if (signal.aborted) throw new Error('Request cancelled');
          principal = await internalPrincipal(authorization);
          let repo: RepositoryRecord;
          try { repo = await queryVisible(principal, repoId, signal); }
          catch (error) { if (error instanceof HttpError && error.status === 404) return null; throw error; }
          if (!repo.path || !repo.commit) return null;
          const result = await explore(repo.path, query, signal, { repoId: repo.id, commit: repo.commit });
          if (signal.aborted) throw new Error('Request cancelled');
          const confirmed = await internalPrincipal(authorization);
          let current: RepositoryRecord;
          try { current = await queryVisible(confirmed, repoId, signal); }
          catch (error) { if (error instanceof HttpError && error.status === 404) return null; throw error; }
          if (signal.aborted || current.path !== repo.path || current.commit !== repo.commit) return null;
          auditOutcome.value = 'success';
          return { repository: internalRepository(repo), result };
        }, signal);
      } finally {
        auditInternalTool('codegraph_explore', auditOutcome.value, principal, repoId);
      }
    },
  };
  const mcp = createMcpHandler<Principal>({
    authenticate, allowedHosts: config.allowedHosts, allowedOrigins: config.allowedOrigins,
    listRepositories: async (key, signal) => (await queryList(key, signal)).map(view),
    getRepository: async (key, id, signal) => { try { return view(await queryVisible(key, id, signal)); } catch (e) { if (e instanceof HttpError && e.status === 404) return null; throw e; } },
    onToolResult: (req, event) => actors.set(req, { ...actors.get(req), tool: event.tool, tool_outcome: event.outcome,
      ...(event.repo_id ? { repo_id: event.repo_id } : {}) }),
    codegraph: graph,
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const requestId = randomUUID(); res.setHeader('x-request-id', requestId);
    try {
      if (!req.headers.host || !config.allowedHosts.includes(req.headers.host) || (req.headers.origin && !config.allowedOrigins?.includes(req.headers.origin))) fail(403, 'FORBIDDEN');
      const url = new URL(req.url ?? '/', 'http://local');
      const method = req.method ?? '';
      if (url.pathname === '/health/live' && method === 'GET') return response(res, 200, { status: 'ok' });
      if (url.pathname === '/health/ready' && method === 'GET') {
        try { await store.checkHealth(); await graph.probe(); } catch { return response(res, 503, { status: 'unavailable' }); }
        return response(res, 200, { status: 'ok' });
      }
      if (url.pathname === '/metrics' && method === 'GET') {
        if (!config.metricsToken) fail(404, 'NOT_FOUND');
        if (!constantTimeEqual(req.headers.authorization ?? '', `Bearer ${config.metricsToken}`)) fail(401, 'UNAUTHENTICATED');
        const now = Date.now();
        let jobMetrics;
        try { jobMetrics = await store.jobMetrics(now); } catch { fail(503, 'METRICS_UNAVAILABLE'); }
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(renderMetrics() + renderJobMetrics(jobMetrics, now));
      }
      if (url.pathname === '/mcp') {
        if (config.publicMcpDisabled) fail(404, 'NOT_FOUND');
        return await mcp(req, res);
      }
      if (url.pathname === '/api/v1/auth/yunxiao/bind' && method === 'POST') {
        const ip = req.socket.remoteAddress ?? 'unknown';
        const now = Date.now(); const old = attempts.get(ip);
        if (attempts.size > 10000) attempts.clear();
        const slot = old && old.until > now ? old : { count: 0, until: now + 60_000 };
        if (++slot.count > 10) fail(429, 'RATE_LIMITED'); attempts.set(ip, slot);
        const input = await body(req); only(input, ['pat']); const pat = text(input.pat, 4096);
        const user = await codeup.getUser(pat);
        // Check the configured Codeup organization and required repository-list scope.
        await codeup.listRepositories(pat, 1, 1);
        actors.set(req, { subject: user.id, authentication: 'yunxiao_pat' });
        const encrypted = cipher.encrypt(pat, user.id);
        return await mutate(async () => {
          await store.transaction(async tx => {
            const existing = await tx.getUser(user.id);
            if (existing) {
              await tx.updateUserCredential(user.id, user.username, encrypted);
              for (const repo of await tx.listRepositories()) {
                if (repo.sync_owner === user.id && repo.status !== 'disabled' && repo.status !== 'branch_deleted') {
                  await tx.updateRepository(repo.id, { status: 'credential_required', error: 'SYNC_AUTHORIZATION_REQUIRED' });
                }
              }
            } else await tx.createUser({ id: user.id, username: user.username, credential: encrypted, credential_version: 1 });
          });
          const now = Date.now();
          for (const [hash, session] of sessions) if (session.expires <= now || session.userId === user.id) sessions.delete(hash);
          const bootstrap = createAccessKey(); sessions.set(bootstrap.hash, { userId: user.id, expires: now + 300_000 });
          return response(res, 200, { bootstrap_token: bootstrap.token, expires_in: 300, user: { id: user.id, name: user.name } });
        });
      }
      if (url.pathname === '/api/v1/auth/bootstrap/keys' && method === 'POST') {
        const token = bearer(req.headers.authorization ?? ''); const hash = token ? hashAccessKey(token) : ''; const session = sessions.get(hash);
        if (!session || session.expires <= Date.now()) fail(401, 'UNAUTHENTICATED');
        actors.set(req, { subject: session.userId, authentication: 'bootstrap' });
        const input = await body(req); only(input, ['scope', 'expires_in']);
        const scope = input.scope === 'read' || input.scope === 'write' ? input.scope : fail(400, 'INVALID_ARGUMENT');
        if (scope === 'write' && !config.writeUsers.includes(session.userId)) fail(403, 'FORBIDDEN');
        const seconds = input.expires_in === undefined ? 30 * 86400 : Number(input.expires_in);
        if (!Number.isInteger(seconds) || seconds < 60 || seconds > 90 * 86400) fail(400, 'INVALID_ARGUMENT');
        return await mutate(async () => {
          if (sessions.get(hash) !== session || session.expires <= Date.now() || !sessions.delete(hash)) fail(401, 'UNAUTHENTICATED');
          const key = createAccessKey();
          await store.createKey({ ...key, owner: session.userId, scope, repos: null, expires_at: Date.now() + seconds * 1000, revoked: 0 });
          return response(res, 201, { token: key.token, prefix: key.prefix, scope, expires_in: seconds });
        });
      }
      const hook = /^\/api\/v1\/hooks\/codeup\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (hook && method === 'POST') {
        const repo = await store.getRepository(hook[1]); const token = req.headers['x-codeup-token'];
        if (!repo || typeof token !== 'string' || !constantTimeEqual(hashAccessKey(token), repo.hook_hash)) fail(404, 'NOT_FOUND');
        actors.set(req, { repo_id: repo.id, authentication: 'webhook' });
        const input = await body(req);
        const event = typeof req.headers['codeup-event'] === 'string' ? req.headers['codeup-event'] : undefined;
        const outcome = verifyPushWebhook({ token, expectedToken: token, event, body: input, codeupRepositoryId: repo.codeup_id, branch: repo.branch });
        return await mutate(async () => {
          const current = await store.getRepository(repo.id);
          if (!current || !constantTimeEqual(hashAccessKey(token), current.hook_hash)) fail(404, 'NOT_FOUND');
          if (outcome === 'enqueue') await worker.enqueue(repo.id, 'webhook');
          if (outcome === 'branch_deleted') await store.updateRepository(repo.id, { status: 'branch_deleted', error: 'BRANCH_DELETED' });
          return response(res, 202, { accepted: true });
        });
      }
      const key = await authenticate(req); if (!key) fail(401, 'UNAUTHENTICATED');
      const activeKey: Principal = key;
      const credentialVersion = (await store.getUser(key.owner))!.credential_version;
      async function assertActiveWrite() {
        const current = await store.getKey(activeKey.hash);
        if (!current || current.revoked || (current.expires_at !== null && current.expires_at <= Date.now()) ||
            (await store.getUser(activeKey.owner))?.credential_version !== credentialVersion) fail(401, 'UNAUTHENTICATED');
        requireWrite(current);
      }
      if (url.pathname === '/api/v1/me' && method === 'GET') {
        const user = (await store.getUser(key.owner))!;
        return response(res, 200, { id: user.id, username: user.username, key_scope: key.scope });
      }
      if (url.pathname === '/api/v1/codeup/repositories' && method === 'GET') {
        if (key.repos !== null) fail(403, 'FORBIDDEN');
        const user = (await store.getUser(key.owner))!;
        const page = Number(url.searchParams.get('page') ?? '1');
        if (!Number.isInteger(page) || page < 1) fail(400, 'INVALID_ARGUMENT');
        const result = await codeup.listRepositories(cipher.decrypt(user.credential, user.id), page, 100);
        return await mutate(async () => {
          const currentKey = await store.getKey(key.hash);
          if ((await store.getUser(user.id))?.credential_version !== user.credential_version || !currentKey || currentKey.revoked ||
              (currentKey.expires_at !== null && currentKey.expires_at <= Date.now())) fail(401, 'UNAUTHENTICATED');
          return response(res, 200, { repositories: result.repositories.map(({ id, name, path, accessLevel }) => ({ id, name, path, access_level: accessLevel })), next_page: result.nextPage });
        });
      }
      if (url.pathname === '/api/v1/repositories' && method === 'GET') return response(res, 200, { repositories: (await listVisible(key)).map(publicRepo) });
      if (url.pathname === '/api/v1/repositories' && method === 'POST') {
        requireWrite(key);
        const input = await body(req); only(input, ['codeup_repository_id', 'branch', 'authorize_automatic_sync']);
        await assertActiveWrite();
        const codeupId = text(String(input.codeup_repository_id ?? ''), 30);
        if (!/^\d+$/.test(codeupId) || input.authorize_automatic_sync !== true) fail(400, 'INVALID_ARGUMENT');
        const branch = text(input.branch ?? 'main', 255);
        if (branch.startsWith('-') || branch.includes('..') || branch.includes('\\') || branch.includes('@{') || /[ ~^:?*\[]/.test(branch)) fail(400, 'INVALID_ARGUMENT');
        const user = (await store.getUser(key.owner))!; const pat = cipher.decrypt(user.credential, user.id);
        const remote = await codeup.getRepository(pat, codeupId);
        if (!hasRepositoryRole(remote) || !remote.httpUrlToRepo || !(await (deps.probe ?? checkCloneAccess)({
          dataDir: config.dataDir, repositoryId: codeupId, branch: remote.defaultBranch ?? branch, cloneUrl: remote.httpUrlToRepo,
          allowedGitHosts: config.allowedGitHosts, gitUsername: user.username, token: pat,
        }))) fail(404, 'NOT_FOUND');
        return await mutate(async () => {
          await assertActiveWrite();
          const exists = await store.getRepositoryByCodeupId(codeupId);
          if (exists) {
            if (!keyAllows(key, exists) || exists.status === 'disabled') fail(404, 'NOT_FOUND');
            return response(res, 200, { repository: publicRepo(exists) });
          }
          if (key.repos !== null) fail(403, 'FORBIDDEN');
          const id = randomUUID(); const hookToken = createAccessKey();
          const repo: RepositoryRecord = { id, codeup_id: codeupId, name: remote.name, branch, owner: user.id, sync_owner: user.id, sync_credential_version: user.credential_version, hook_hash: hookToken.hash, path: null, commit: null, indexed_at: null, status: 'pending', error: null };
          const jobId = randomUUID();
          await store.transaction(async tx => { await tx.createRepository(repo); await tx.createJob({ id: jobId, repo_id: id, status: 'queued', reason: 'initial', created_at: Date.now(), error: null }); });
          actors.set(req, { ...actors.get(req), repo_id: id });
          worker.kick();
          return response(res, 202, { repository: publicRepo(repo), job_id: jobId, webhook_token: hookToken.token, webhook_path: `/api/v1/hooks/codeup/${id}` });
        });
      }
      const repoRoute = /^\/api\/v1\/repositories\/([A-Za-z0-9_-]+)(?:\/(sync|sync-credential))?$/.exec(url.pathname);
      if (repoRoute) {
        const repo = await visible(key, repoRoute[1]);
        actors.set(req, { ...actors.get(req), repo_id: repo.id });
        if (!repoRoute[2] && method === 'GET') return response(res, 200, publicRepo(repo));
        if (repoRoute[2] === 'sync' && method === 'POST') return await mutate(async () => { await assertActiveWrite(); const job = await worker.enqueue(repo.id, 'manual'); return response(res, 202, { job_id: job.id }); });
        if (repoRoute[2] === 'sync-credential' && method === 'PUT') {
          requireWrite(key);
          if (repo.owner !== key.owner && repo.sync_owner !== key.owner) fail(404, 'NOT_FOUND');
          const input = await body(req); only(input, ['authorize_automatic_sync']);
          if (input.authorize_automatic_sync !== true) fail(400, 'INVALID_ARGUMENT');
          return await mutate(async () => {
            await assertActiveWrite();
            const latest = await store.getRepository(repo.id);
            if (!latest || (latest.owner !== key.owner && latest.sync_owner !== key.owner)) fail(404, 'NOT_FOUND');
            const user = (await store.getUser(key.owner))!;
            await store.updateRepository(repo.id, { sync_owner: user.id, sync_credential_version: user.credential_version });
            const job = await worker.enqueue(repo.id, 'credential_changed');
            return response(res, 202, { job_id: job.id });
          });
        }
      }
      const jobRoute = /^\/api\/v1\/jobs\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (jobRoute && method === 'GET') {
        const job = await store.getJob(jobRoute[1]); if (!job) fail(404, 'NOT_FOUND');
        await visible(key, job.repo_id); return response(res, 200, job);
      }
      if (url.pathname === '/api/v1/api-keys' && method === 'GET') {
        const keys = key.repos === null ? await store.listKeys(key.owner) : [key];
        return response(res, 200, { keys: keys.map(k => ({ prefix: k.prefix, scope: k.scope, repos: k.repos, expires_at: k.expires_at, revoked: !!k.revoked })) });
      }
      if (url.pathname === '/api/v1/api-keys' && method === 'POST') {
        requireWrite(key); const input = await body(req); only(input, ['scope', 'repos', 'expires_in']);
        await assertActiveWrite();
        const scope = input.scope === 'read' || input.scope === 'write' ? input.scope : fail(400, 'INVALID_ARGUMENT');
        const repos = input.repos === null || input.repos === undefined ? null : input.repos;
        if (repos !== null && (!Array.isArray(repos) || repos.length > 100 || !repos.every(r => typeof r === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(r)))) fail(400, 'INVALID_ARGUMENT');
        if (scope === 'read' && repos === null) fail(400, 'REPOSITORY_SCOPE_REQUIRED');
        if (key.repos !== null && (repos === null || (repos as string[]).some(id => !key.repos!.includes(id)))) fail(403, 'FORBIDDEN');
        const seconds = Number(input.expires_in ?? 30 * 86400);
        if (!Number.isInteger(seconds) || seconds < 60 || seconds > 90 * 86400) fail(400, 'INVALID_ARGUMENT');
        const expiry = Date.now() + seconds * 1000;
        if (key.expires_at !== null && expiry > key.expires_at) fail(403, 'FORBIDDEN');
        return await mutate(async () => {
          await assertActiveWrite();
          const next = createAccessKey();
          await store.createKey({ ...next, owner: key.owner, scope, repos: repos as string[] | null, expires_at: expiry, revoked: 0 });
          return response(res, 201, { token: next.token, prefix: next.prefix, scope, repos, expires_at: expiry });
        });
      }
      const keyRoute = /^\/api\/v1\/api-keys\/(ch_[A-Za-z0-9_-]{8})$/.exec(url.pathname);
      if (keyRoute && method === 'DELETE') {
        return await mutate(async () => {
          await assertActiveWrite(); const target = (await store.listKeys(key.owner)).find(k => k.prefix === keyRoute[1]);
          if (!target || (key.repos !== null && target.hash !== key.hash)) fail(404, 'NOT_FOUND');
          await store.revokeKey(target.hash); return response(res, 200, { revoked: true });
        });
      }
      fail(404, 'NOT_FOUND');
    } catch (error) { errorResponse(res, error); }
  }
  const fastify = Fastify({ logger: true, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 64 * 1024, requestTimeout: 30_000 });
  fastify.addHook('onRequest', async (request, reply) => {
    const started = process.hrtime.bigint();
    const route = !request.routeOptions.url || request.routeOptions.url === '/*' ? '<unmatched>' : request.routeOptions.url;
    reply.raw.once('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      observe(request.method, reply.raw.statusCode, seconds);
      fastify.log.info({ request_id: reply.raw.getHeader('x-request-id'), method: request.method,
        route, status: reply.raw.statusCode, duration_ms: seconds * 1000 }, 'http_request');
      if (route === '/mcp' || route.startsWith('/api/v1/')) {
        const event: AuditEvent = { request_id: String(reply.raw.getHeader('x-request-id') ?? ''), method: request.method,
          route, status: reply.raw.statusCode, ...actors.get(request.raw) };
        fastify.log.info(event, 'audit');
        try { deps.audit?.(event); } catch { /* An observer must not affect the response. */ }
      }
    });
    // Documentation uses Fastify's normal response lifecycle; all other routes
    // retain the original raw stream needed for MCP and early authentication.
    const docsRoute = request.routeOptions.url === '/openapi.json' ||
      request.routeOptions.url === '/docs' || request.routeOptions.url?.startsWith('/docs/');
    if (docsRoute) {
      reply.header('x-request-id', randomUUID());
      reply.header('x-content-type-options', 'nosniff');
      if (!request.raw.headers.host || !config.allowedHosts.includes(request.raw.headers.host) ||
          (request.raw.headers.origin && !config.allowedOrigins?.includes(request.raw.headers.origin))) {
        reply.code(403).header('cache-control', 'no-store').send({ error: 'FORBIDDEN' });
      }
      return;
    }
    // MCP needs the original HTTP stream, and authorization must be captured before a slow body arrives.
    reply.hijack();
    await handle(request.raw, reply.raw);
  });
  const appOpenApiDocument = config.publicMcpDisabled
    ? { ...openApiDocument, paths: Object.fromEntries(Object.entries(openApiDocument.paths).filter(([path]) => path !== '/mcp')) }
    : openApiDocument;
  fastify.register(swagger, { mode: 'static', specification: { document: appOpenApiDocument } });
  fastify.register(swaggerUi, { routePrefix: '/docs', staticCSP: true,
    uiConfig: { docExpansion: 'list', persistAuthorization: false, validatorUrl: null } });
  fastify.get('/openapi.json', async (_request, reply) => {
    return reply.header('cache-control', 'no-store').send(appOpenApiDocument);
  });
  const paths = ['/health/live', '/health/ready', '/metrics', '/mcp', '/api/v1/auth/yunxiao/bind',
    '/api/v1/auth/bootstrap/keys', '/api/v1/hooks/codeup/:id', '/api/v1/me',
    '/api/v1/codeup/repositories', '/api/v1/repositories', '/api/v1/repositories/:id',
    '/api/v1/repositories/:id/sync', '/api/v1/repositories/:id/sync-credential',
    '/api/v1/jobs/:id', '/api/v1/api-keys', '/api/v1/api-keys/:id', '/', '/*'];
  for (const path of paths) fastify.all(path, async () => {});
  return {
    server: fastify.server, store, worker, internalMcp,
    listen(options: { port: number; host: string }) { return fastify.listen(options); },
    start() { return worker.start(); },
    async close() { await fastify.close(); await worker.stop(); await graph.close(); await store.close(); },
  };
}
