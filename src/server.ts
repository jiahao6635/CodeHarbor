import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { CredentialCipher, createAccessKey, hashAccessKey, constantTimeEqual } from './auth.js';
import { CodeupClient, CodeupError, hasRepositoryRole } from './codeup.js';
import { Store, type KeyRecord, type RepositoryRecord } from './store.js';
import { CodeGraphClient } from './codegraph.js';
import { createMcpHandler, type McpRepository } from './mcp.js';
import { IndexError, verifyPushWebhook } from './indexer.js';
import { IndexWorker } from './worker.js';

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
}

type Principal = KeyRecord;
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
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) fail(415, 'UNSUPPORTED_MEDIA_TYPE');
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > 64 * 1024) fail(413, 'BODY_TOO_LARGE');
    parts.push(part);
  }
  try { return plain(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
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
  if (error instanceof IndexError) return response(res, 400, { error: 'INVALID_REQUEST' });
  if (error instanceof CodeupError) {
    if (error.kind === 'invalid_credential') return response(res, 401, { error: 'INVALID_CREDENTIAL' });
    if (error.kind === 'forbidden' || error.kind === 'not_found') return response(res, 404, { error: 'NOT_FOUND' });
    return response(res, 503, { error: 'CODEUP_UNAVAILABLE' });
  }
  response(res, 500, { error: 'INTERNAL_ERROR' });
}

/** One instance only: SQLite and the worker are not a distributed coordination system. */
export function createApp(config: AppConfig, deps: { codeup?: CodeupClient; graph?: CodeGraphClient; worker?: IndexWorker } = {}) {
  const store = new Store(config.databasePath);
  const cipher = new CredentialCipher(config.credentialKey);
  const codeup = deps.codeup ?? new CodeupClient({ endpoint: config.codeupEndpoint, organizationId: config.organizationId });
  const graph = deps.graph ?? new CodeGraphClient(config.codegraphBin, config.dataDir);
  const worker = deps.worker ?? new IndexWorker({ store, codeup, cipher, graph, dataDir: config.dataDir, allowedGitHosts: config.allowedGitHosts, codegraphBin: config.codegraphBin, reconcileIntervalMs: config.reconcileMs });
  const sessions = new Map<string, { userId: string; expires: number }>();
  const attempts = new Map<string, { count: number; until: number }>();

  function bearer(req: IncomingMessage): string | null {
    const match = /^Bearer (ch_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
    return match?.[1] ?? null;
  }
  async function authenticate(req: IncomingMessage): Promise<Principal | null> {
    const token = bearer(req);
    if (!token) return null;
    const key = store.getKey(hashAccessKey(token));
    if (!key || key.revoked || (key.expires_at !== null && key.expires_at <= Date.now()) || !store.getUser(key.owner)) return null;
    return key;
  }
  function requireWrite(key: Principal) { if (key.scope !== 'write' || !config.writeUsers.includes(key.owner)) fail(403, 'FORBIDDEN'); }
  function keyAllows(key: Principal, repo: RepositoryRecord) { return key.repos === null || key.repos.includes(repo.id); }
  async function authorize(key: Principal, repo: RepositoryRecord): Promise<boolean> {
    if (!keyAllows(key, repo)) return false;
    const user = store.getUser(key.owner);
    if (!user) return false;
    try {
      const permitted = hasRepositoryRole(await codeup.getRepository(cipher.decrypt(user.credential, user.id), repo.codeup_id));
      const currentUser = store.getUser(user.id); const currentKey = store.getKey(key.hash);
      return permitted && currentUser?.credential_version === user.credential_version && !!currentKey && !currentKey.revoked && (currentKey.expires_at === null || currentKey.expires_at > Date.now());
    }
    catch (error) {
      if (error instanceof CodeupError && error.kind === 'invalid_credential' && store.getUser(user.id)?.credential_version === user.credential_version) store.revokeUserKeys(user.id);
      if (error instanceof CodeupError && ['forbidden', 'not_found', 'invalid_credential'].includes(error.kind)) return false;
      throw error;
    }
  }
  async function visible(key: Principal, id: string): Promise<RepositoryRecord> {
    const repo = store.getRepository(id);
    if (!repo || repo.status === 'disabled' || !(await authorize(key, repo))) fail(404, 'NOT_FOUND');
    return repo;
  }
  async function listVisible(key: Principal): Promise<RepositoryRecord[]> {
    const result: RepositoryRecord[] = [];
    for (const repo of store.listRepositories()) {
      if (repo.status !== 'disabled' && await authorize(key, repo)) result.push(repo);
    }
    return result;
  }
  const mcp = createMcpHandler<Principal>({
    authenticate, allowedHosts: config.allowedHosts, allowedOrigins: config.allowedOrigins,
    listRepositories: async key => (await listVisible(key)).map(view),
    getRepository: async (key, id) => { try { return view(await visible(key, id)); } catch (e) { if (e instanceof HttpError && e.status === 404) return null; throw e; } },
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
        try { await graph.probe(); } catch { return response(res, 503, { status: 'unavailable' }); }
        return response(res, 200, { status: 'ok' });
      }
      if (url.pathname === '/mcp') return await mcp(req, res);
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
        const existing = store.getUser(user.id); const encrypted = cipher.encrypt(pat, user.id);
        store.transaction(() => {
          if (existing) {
            store.updateUserCredential(user.id, user.username, encrypted);
            for (const repo of store.listRepositories()) {
              if (repo.sync_owner === user.id && repo.status !== 'disabled' && repo.status !== 'branch_deleted') {
                store.updateRepository(repo.id, { status: 'credential_required', error: 'SYNC_AUTHORIZATION_REQUIRED' });
              }
            }
          }
          else store.createUser({ id: user.id, username: user.username, credential: encrypted, credential_version: 1 });
        });
        for (const [hash, session] of sessions) if (session.expires <= now || session.userId === user.id) sessions.delete(hash);
        const bootstrap = createAccessKey(); sessions.set(bootstrap.hash, { userId: user.id, expires: now + 300_000 });
        return response(res, 200, { bootstrap_token: bootstrap.token, expires_in: 300, user: { id: user.id, name: user.name } });
      }
      if (url.pathname === '/api/v1/auth/bootstrap/keys' && method === 'POST') {
        const token = bearer(req); const hash = token ? hashAccessKey(token) : ''; const session = sessions.get(hash);
        if (!session || session.expires <= Date.now()) fail(401, 'UNAUTHENTICATED');
        const input = await body(req); only(input, ['scope', 'expires_in']);
        const scope = input.scope === 'read' || input.scope === 'write' ? input.scope : fail(400, 'INVALID_ARGUMENT');
        if (scope === 'write' && !config.writeUsers.includes(session.userId)) fail(403, 'FORBIDDEN');
        const seconds = input.expires_in === undefined ? 30 * 86400 : Number(input.expires_in);
        if (!Number.isInteger(seconds) || seconds < 60 || seconds > 90 * 86400) fail(400, 'INVALID_ARGUMENT');
        sessions.delete(hash);
        const key = createAccessKey();
        store.createKey({ ...key, owner: session.userId, scope, repos: null, expires_at: Date.now() + seconds * 1000, revoked: 0 });
        return response(res, 201, { token: key.token, prefix: key.prefix, scope, expires_in: seconds });
      }
      const hook = /^\/api\/v1\/hooks\/codeup\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (hook && method === 'POST') {
        const repo = store.getRepository(hook[1]); const token = req.headers['x-codeup-token'];
        if (!repo || typeof token !== 'string' || !constantTimeEqual(hashAccessKey(token), repo.hook_hash)) fail(404, 'NOT_FOUND');
        const input = await body(req);
        const event = typeof req.headers['codeup-event'] === 'string' ? req.headers['codeup-event'] : undefined;
        const outcome = verifyPushWebhook({ token, expectedToken: token, event, body: input, codeupRepositoryId: repo.codeup_id, branch: repo.branch });
        if (outcome === 'enqueue') worker.enqueue(repo.id, 'webhook');
        if (outcome === 'branch_deleted') store.updateRepository(repo.id, { status: 'branch_deleted', error: 'BRANCH_DELETED' });
        return response(res, 202, { accepted: true });
      }
      const key = await authenticate(req); if (!key) fail(401, 'UNAUTHENTICATED');
      if (url.pathname === '/api/v1/me' && method === 'GET') {
        const user = store.getUser(key.owner)!;
        return response(res, 200, { id: user.id, username: user.username, key_scope: key.scope });
      }
      if (url.pathname === '/api/v1/codeup/repositories' && method === 'GET') {
        if (key.repos !== null) fail(403, 'FORBIDDEN');
        const user = store.getUser(key.owner)!;
        const page = Number(url.searchParams.get('page') ?? '1');
        if (!Number.isInteger(page) || page < 1) fail(400, 'INVALID_ARGUMENT');
        let result;
        try { result = await codeup.listRepositories(cipher.decrypt(user.credential, user.id), page, 100); }
        catch (error) { if (error instanceof CodeupError && error.kind === 'invalid_credential' && store.getUser(user.id)?.credential_version === user.credential_version) store.revokeUserKeys(user.id); throw error; }
        if (store.getUser(user.id)?.credential_version !== user.credential_version || store.getKey(key.hash)?.revoked !== 0) fail(401, 'UNAUTHENTICATED');
        return response(res, 200, { repositories: result.repositories.map(({ id, name, path, accessLevel }) => ({ id, name, path, access_level: accessLevel })), next_page: result.nextPage });
      }
      if (url.pathname === '/api/v1/repositories' && method === 'GET') return response(res, 200, { repositories: (await listVisible(key)).map(publicRepo) });
      if (url.pathname === '/api/v1/repositories' && method === 'POST') {
        requireWrite(key);
        const input = await body(req); only(input, ['codeup_repository_id', 'branch', 'authorize_automatic_sync']);
        const codeupId = text(String(input.codeup_repository_id ?? ''), 30);
        if (!/^\d+$/.test(codeupId) || input.authorize_automatic_sync !== true) fail(400, 'INVALID_ARGUMENT');
        const branch = text(input.branch ?? 'main', 255);
        if (branch.startsWith('-') || branch.includes('..') || branch.includes('\\') || branch.includes('@{') || /[ ~^:?*\[]/.test(branch)) fail(400, 'INVALID_ARGUMENT');
        const user = store.getUser(key.owner)!; const pat = cipher.decrypt(user.credential, user.id);
        const remote = await codeup.getRepository(pat, codeupId);
        if (!hasRepositoryRole(remote) || !remote.httpUrlToRepo) fail(404, 'NOT_FOUND');
        const exists = store.getRepositoryByCodeupId(codeupId);
        if (exists) { if (!(await authorize(key, exists))) fail(404, 'NOT_FOUND'); return response(res, 200, { repository: publicRepo(exists) }); }
        if (key.repos !== null) fail(403, 'FORBIDDEN');
        const id = randomUUID(); const hookToken = createAccessKey();
        const repo: RepositoryRecord = { id, codeup_id: codeupId, name: remote.name, branch, owner: user.id, sync_owner: user.id, sync_credential_version: user.credential_version, hook_hash: hookToken.hash, path: null, commit: null, indexed_at: null, status: 'pending', error: null };
        const jobId = randomUUID();
        store.transaction(() => { store.createRepository(repo); store.createJob({ id: jobId, repo_id: id, status: 'queued', reason: 'initial', created_at: Date.now(), error: null }); });
        worker.kick();
        return response(res, 202, { repository: publicRepo(repo), job_id: jobId, webhook_token: hookToken.token, webhook_path: `/api/v1/hooks/codeup/${id}` });
      }
      const repoRoute = /^\/api\/v1\/repositories\/([A-Za-z0-9_-]+)(?:\/(sync|sync-credential))?$/.exec(url.pathname);
      if (repoRoute) {
        const repo = await visible(key, repoRoute[1]);
        if (!repoRoute[2] && method === 'GET') return response(res, 200, publicRepo(repo));
        if (repoRoute[2] === 'sync' && method === 'POST') { requireWrite(key); const job = worker.enqueue(repo.id, 'manual'); return response(res, 202, { job_id: job.id }); }
        if (repoRoute[2] === 'sync-credential' && method === 'PUT') {
          requireWrite(key);
          if (repo.owner !== key.owner && repo.sync_owner !== key.owner) fail(404, 'NOT_FOUND');
          const input = await body(req); only(input, ['authorize_automatic_sync']);
          if (input.authorize_automatic_sync !== true) fail(400, 'INVALID_ARGUMENT');
          const user = store.getUser(key.owner)!;
          store.updateRepository(repo.id, { sync_owner: user.id, sync_credential_version: user.credential_version });
          const job = worker.enqueue(repo.id, 'credential_changed');
          return response(res, 202, { job_id: job.id });
        }
      }
      const jobRoute = /^\/api\/v1\/jobs\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (jobRoute && method === 'GET') {
        const job = store.getJob(jobRoute[1]); if (!job) fail(404, 'NOT_FOUND');
        await visible(key, job.repo_id); return response(res, 200, job);
      }
      if (url.pathname === '/api/v1/api-keys' && method === 'GET') {
        const keys = key.repos === null ? store.listKeys(key.owner) : [key];
        return response(res, 200, { keys: keys.map(k => ({ prefix: k.prefix, scope: k.scope, repos: k.repos, expires_at: k.expires_at, revoked: !!k.revoked })) });
      }
      if (url.pathname === '/api/v1/api-keys' && method === 'POST') {
        requireWrite(key); const input = await body(req); only(input, ['scope', 'repos', 'expires_in']);
        const scope = input.scope === 'read' || input.scope === 'write' ? input.scope : fail(400, 'INVALID_ARGUMENT');
        const repos = input.repos === null || input.repos === undefined ? null : input.repos;
        if (repos !== null && (!Array.isArray(repos) || repos.length > 100 || !repos.every(r => typeof r === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(r)))) fail(400, 'INVALID_ARGUMENT');
        if (key.repos !== null && (repos === null || (repos as string[]).some(id => !key.repos!.includes(id)))) fail(403, 'FORBIDDEN');
        const seconds = Number(input.expires_in ?? 30 * 86400);
        if (!Number.isInteger(seconds) || seconds < 60 || seconds > 90 * 86400) fail(400, 'INVALID_ARGUMENT');
        const expiry = Date.now() + seconds * 1000;
        if (key.expires_at !== null && expiry > key.expires_at) fail(403, 'FORBIDDEN');
        const next = createAccessKey();
        store.createKey({ ...next, owner: key.owner, scope, repos: repos as string[] | null, expires_at: expiry, revoked: 0 });
        return response(res, 201, { token: next.token, prefix: next.prefix, scope, repos, expires_at: expiry });
      }
      const keyRoute = /^\/api\/v1\/api-keys\/(ch_[A-Za-z0-9_-]{8})$/.exec(url.pathname);
      if (keyRoute && method === 'DELETE') {
        requireWrite(key); const target = store.listKeys(key.owner).find(k => k.prefix === keyRoute[1]);
        if (!target || (key.repos !== null && target.hash !== key.hash)) fail(404, 'NOT_FOUND');
        store.revokeKey(target.hash); return response(res, 200, { revoked: true });
      }
      fail(404, 'NOT_FOUND');
    } catch (error) { errorResponse(res, error); }
  }
  const server = createServer((req, res) => { void handle(req, res); });
  return {
    server, store, worker,
    start() { worker.start(); },
    async close() { await worker.stop(); await graph.close(); await new Promise<void>((resolve, reject) => { if (!server.listening) return resolve(); server.close(e => e ? reject(e) : resolve()); }); store.close(); },
  };
}
