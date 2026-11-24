// Loopback-only console preview with fake Feishu and Codeup and a temporary local test database.
//
//   npm run test:db:up && npm run build:web && npx tsx scripts/console-preview.ts
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request as forwardRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyRequest } from 'fastify';
import { CredentialCipher, createAccessKey } from '../src/auth.js';
import type { GraphClient } from '../src/codegraph.js';
import { type CodeupClient, CodeupError } from '../src/codeup.js';
import type { IndexRequest } from '../src/indexer.js';
import { type AppConfig, createApp } from '../src/server.js';
import type { RepositoryRecord } from '../src/store.js';
import { IndexWorker } from '../src/worker.js';
import { openTestStore } from '../tests/helpers/postgres.js';

if (process.env.NODE_ENV === 'production' || process.env.CODEHARBOR_TEST_DATABASE_URL) {
  throw new Error('Console preview requires development mode and the default local test PostgreSQL');
}

const PORT = Number(process.env.PORT ?? '8099');
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid preview port');
const origin = `http://127.0.0.1:${PORT}`;
const uiDir = fileURLToPath(new URL('../web/dist', import.meta.url));
if (!existsSync(join(uiDir, 'index.html'))) throw new Error('Build the console with npm run build:web first');
const tenantKey = 'console-preview';
const feishuAppId = 'cli_console_preview';
const feishuAppSecret = 'local-preview-only';
const callbackUrl = new URL('/api/v1/auth/feishu/callback', origin);
const previewMembers = {
  alice: { open_id: 'ou_preview_alice', tenant_key: tenantKey, name: 'Alice Chen' },
  bob: { open_id: 'ou_preview_bob', tenant_key: tenantKey, name: 'Bob Li' },
} as const;
const previewCodes = new Map<string, { member: keyof typeof previewMembers; challenge: string; expiresAt: number }>();
const codeChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const oauthValue = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const memberName = (value: unknown): value is keyof typeof previewMembers =>
  typeof value === 'string' && Object.hasOwn(previewMembers, value);

const feishuFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.href === 'https://open.feishu.cn/open-apis/authen/v2/oauth/token' && typeof init?.body === 'string') {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const { code, code_verifier: verifier } = body;
    const issued = oauthValue(code) ? previewCodes.get(code) : undefined;
    if (oauthValue(code)) previewCodes.delete(code);
    if (
      !issued ||
      !oauthValue(verifier) ||
      issued.challenge !== codeChallenge(verifier) ||
      issued.expiresAt <= Date.now() ||
      new Headers(init.headers).get('content-type') !== 'application/json; charset=utf-8' ||
      body.grant_type !== 'authorization_code' ||
      body.client_id !== feishuAppId ||
      body.client_secret !== feishuAppSecret ||
      body.redirect_uri !== callbackUrl.href
    ) {
      return Response.json({ code: 1 }, { status: 400 });
    }
    return Response.json({ code: 0, access_token: issued.member });
  }
  if (url.href === 'https://open.feishu.cn/open-apis/authen/v1/user_info') {
    const member = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '');
    if (memberName(member)) return Response.json({ code: 0, data: previewMembers[member] });
  }
  return Response.json({ code: 1 }, { status: 404 });
};

const users = {
  'alice-pat': { id: 'alice', username: 'alice', name: 'Alice Chen' },
  'bob-pat': { id: 'bob', username: 'bob', name: 'Bob Li' },
} as const;
const codeupRepos = Array.from({ length: 23 }, (_, index) => ({
  id: String(1000 + index),
  name:
    ['payment-gateway', 'ad-sdk-android', 'tobid-console', 'data-pipeline', 'infra-terraform'][index % 5] +
    (index >= 5 ? `-${index}` : ''),
  path: `sigmob/${['payment-gateway', 'ad-sdk-android', 'tobid-console', 'data-pipeline', 'infra-terraform'][index % 5]}${index >= 5 ? `-${index}` : ''}`,
  accessLevel: index % 3 === 0 ? 40 : 30,
  defaultBranch: index % 4 === 0 ? 'develop' : 'main',
  cloneDownloadRestricted: false,
  httpUrlToRepo: `https://codeup.example/sigmob/repo-${1000 + index}.git`,
}));

const userFor = (token: string) => {
  const user = users[token as keyof typeof users];
  if (!user) throw new CodeupError('invalid_credential', 401);
  return user;
};
const visibleRepos = (token: string) =>
  userFor(token).id === 'alice' ? codeupRepos : codeupRepos.filter((_repo, index) => index % 3 === 1);
const remoteFor = (token: string, id: string) => {
  const repo = visibleRepos(token).find((candidate) => candidate.id === id);
  if (!repo) throw new CodeupError('not_found', 404);
  return repo;
};
const branchesFor = (token: string, id: string) => {
  const { defaultBranch } = remoteFor(token, id);
  return [
    'main',
    'develop',
    'release/2026.11',
    ...Array.from({ length: 35 }, (_, i) => `feature/preview-${String(i + 1).padStart(2, '0')}`),
  ].map((name) => ({ name, is_default: name === defaultBranch }));
};
const codeup = {
  async getUser(token: string) {
    return userFor(token);
  },
  async listRepositories(token: string, page: number, size: number) {
    const repositories = visibleRepos(token);
    const start = (page - 1) * size;
    return {
      repositories: repositories.slice(start, start + size),
      nextPage: start + size < repositories.length ? page + 1 : null,
    };
  },
  async getRepository(token: string, id: string) {
    return remoteFor(token, id);
  },
  async listBranches(token: string, id: string, page: number, search = '') {
    const branches = branchesFor(token, id).filter(({ name }) => name.toLowerCase().includes(search.toLowerCase()));
    const start = (page - 1) * 30;
    return { branches: branches.slice(start, start + 30), nextPage: start + 30 < branches.length ? page + 1 : null };
  },
  async getBranch(token: string, id: string, name: string) {
    const branch = branchesFor(token, id).find((candidate) => candidate.name === name);
    if (!branch) throw new CodeupError('not_found', 404);
    return branch;
  },
} as CodeupClient;

const db = await openTestStore();
const { store } = db;
const dataDir = mkdtempSync(join(tmpdir(), 'codeharbor-preview-'));
const config: AppConfig = {
  dataDir,
  credentialKey: randomBytes(32),
  codeupEndpoint: 'https://codeup.example',
  organizationId: 'org',
  allowedGitHosts: ['codeup.example'],
  allowedHosts: [new URL(origin).host],
  writeUsers: [],
  feishu: {
    origin,
    appId: feishuAppId,
    appSecret: feishuAppSecret,
    tenantKey,
    superAdminOpenId: previewMembers.alice.open_id,
  },
  codegraphBin: 'codegraph',
  uiDir,
  uiMcpUrl: 'https://mcp.internal.example/mcp',
  publicMcpDisabled: true,
};
const abortBuild = new AbortController();
const pause = () => wait(5_500, undefined, { signal: abortBuild.signal });
const head = async (request: IndexRequest) =>
  createHash('sha1').update(request.cloneUrl).update(request.branch).digest('hex');
const graph: GraphClient = {
  withQuery: (fn) => fn(async () => 'Preview index'),
  async withExclusive(fn) {
    await pause();
    return fn(async () => 'Preview index');
  },
  async probe() {},
  async close() {},
};
const cipher = new CredentialCipher(config.credentialKey);
const probe = async () => true;
const worker = new IndexWorker({
  store,
  codeup,
  graph,
  cipher,
  dataDir,
  allowedGitHosts: config.allowedGitHosts,
  reconcileIntervalMs: 0,
  probe,
  head,
  healthy: async () => true,
  async build(request) {
    for (const phase of ['cloning', 'indexing', 'packaging'] as const) {
      await request.onProgress?.(phase);
      await pause();
    }
    const commit = await head(request);
    const digest = createHash('sha256').update(commit).digest('hex');
    return { path: `oci://sha256:${digest}`, commit, generation: randomUUID() };
  },
});
const app = createApp(config, { store, codeup, feishuFetch, graph, worker, probe });
const preview = Fastify();

// Rewrite only OAuth start at the development proxy; the app uses its normal login routes and cookies.
preview.addHook('onRequest', (request, reply, done) => {
  if (request.headers.host !== config.allowedHosts[0]) return void reply.code(403).send('Invalid preview host');
  const path = request.url.split('?')[0];
  if (path === '/__preview/feishu' || path === '/__preview/feishu/confirm') return done();
  const backend = app.server.address();
  if (!backend || typeof backend === 'string') return void reply.code(503).send('Preview unavailable');
  reply.hijack();
  const forwarded = forwardRequest(
    {
      hostname: '127.0.0.1',
      port: backend.port,
      path: request.url,
      method: request.method,
      headers: request.headers,
    },
    (response) => {
      const { location } = response.headers;
      if (path === '/api/v1/auth/feishu/start' && location) {
        response.headers.location = `/__preview/feishu${new URL(location).search}`;
      }
      reply.raw.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(reply.raw);
    },
  );
  forwarded.on('error', () => {
    if (!reply.raw.headersSent) reply.raw.writeHead(502);
    reply.raw.end();
  });
  reply.raw.once('close', () => forwarded.destroy());
  request.raw.pipe(forwarded);
});
preview.get<{ Querystring: { state?: string; code_challenge?: string } }>(
  '/__preview/feishu',
  async (request, reply) => {
    const { state, code_challenge: challenge } = request.query;
    if (!oauthValue(state) || !oauthValue(challenge)) return reply.code(400).send('Invalid preview OAuth request');
    return reply
      .header('referrer-policy', 'no-referrer')
      .type('text/html; charset=utf-8')
      .send(`<!doctype html>
      <html lang="zh-CN"><meta charset="utf-8"><title>CodeHarbor 本地飞书预览</title>
      <body><main><h1>选择飞书预览账号</h1><p>本页面使用本地模拟账号。</p>
      <form method="post" action="/__preview/feishu/confirm">
        <input type="hidden" name="state" value="${state}">
        <input type="hidden" name="challenge" value="${challenge}">
        <button name="member" value="alice">Alice Chen（超级管理员）</button>
        <button name="member" value="bob">Bob Li（成员）</button>
      </form></main></body></html>`);
  },
);
preview.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  async (_request: FastifyRequest, body: string) => new URLSearchParams(body),
);
preview.post<{ Body: URLSearchParams }>('/__preview/feishu/confirm', async (request, reply) => {
  const state = request.body?.get('state');
  const challenge = request.body?.get('challenge');
  const member = request.body?.get('member');
  if (!oauthValue(state) || !oauthValue(challenge) || !memberName(member)) {
    return reply.code(400).send('Invalid preview authorization');
  }
  const now = Date.now();
  for (const [code, { expiresAt }] of previewCodes) {
    if (expiresAt <= now) previewCodes.delete(code);
  }
  const code = randomBytes(32).toString('base64url');
  previewCodes.set(code, { member, challenge, expiresAt: now + 5 * 60_000 });
  return reply
    .header('referrer-policy', 'no-referrer')
    .redirect(`${callbackUrl.pathname}?${new URLSearchParams({ code, state })}`, 303);
});

const seed = async () => {
  const encrypt = (pat: string, id: string) => cipher.encrypt(pat, id);
  await store.createUser({
    id: 'alice',
    username: 'alice',
    credential: encrypt('alice-pat', 'alice'),
    credential_version: 2,
  });
  await store.createUser({ id: 'bob', username: 'bob', credential: encrypt('bob-pat', 'bob'), credential_version: 1 });
  await store.upsertFeishuAccount({
    id: 'preview-alice',
    feishu_tenant_key: tenantKey,
    feishu_open_id: previewMembers.alice.open_id,
    name: previewMembers.alice.name,
    role: 'super_admin',
  });
  await store.linkCodeupAccount('preview-alice', 'alice');
  const now = Date.now();
  const statuses: Array<[string, Partial<RepositoryRecord>]> = [
    ['1000', { status: 'ready', commit: randomBytes(20).toString('hex'), indexed_at: now - 3_600_000 }],
    ['1001', { status: 'ready', commit: randomBytes(20).toString('hex'), indexed_at: now - 7_200_000 }],
    ['1002', { status: 'ready', commit: randomBytes(20).toString('hex'), indexed_at: now - 86_400_000 }],
    [
      '1003',
      {
        status: 'failed',
        error: 'INDEX_FAILED',
        commit: randomBytes(20).toString('hex'),
        indexed_at: now - 2 * 86_400_000,
      },
    ],
    [
      '1004',
      {
        status: 'credential_required',
        error: 'SYNC_AUTHORIZATION_REQUIRED',
        commit: randomBytes(20).toString('hex'),
        indexed_at: now - 5 * 86_400_000,
      },
    ],
    [
      '1005',
      {
        status: 'branch_deleted',
        error: 'BRANCH_DELETED',
        commit: randomBytes(20).toString('hex'),
        indexed_at: now - 9 * 86_400_000,
      },
    ],
    [
      '1007',
      {
        status: 'disabled',
        error: 'DISABLED_BY_ADMIN',
        commit: randomBytes(20).toString('hex'),
        indexed_at: now - 20 * 86_400_000,
      },
    ],
  ];
  const ids: string[] = [];
  for (const [codeupId, patch] of statuses) {
    const id = randomUUID();
    ids.push(id);
    const remote = codeupRepos.find((candidate) => candidate.id === codeupId);
    if (!remote) throw new Error(`missing seed repo ${codeupId}`);
    await store.createRepository({
      id,
      codeup_id: codeupId,
      name: remote.name,
      branch: codeupId === '1002' ? 'release/2026.11' : 'main',
      owner: 'alice',
      sync_owner: 'alice',
      sync_credential_version: codeupId === '1004' ? 1 : 2,
      hook_hash: createAccessKey().hash,
      path: patch.commit ? `/index/${id}` : null,
      commit: null,
      indexed_at: null,
      status: 'pending',
      error: null,
      ...patch,
    });
    await store.createJob({
      id: randomUUID(),
      repo_id: id,
      status: 'succeeded',
      phase: 'complete',
      reason: 'initial',
      created_at: now - 10 * 86_400_000,
      queued_at: now - 10 * 86_400_000,
      finished_at: now - 10 * 86_400_000 + 95_000,
      build_duration_ms: 93_000,
      error: null,
    });
    if (patch.status === 'failed') {
      await store.createJob({
        id: randomUUID(),
        repo_id: id,
        status: 'failed',
        phase: 'indexing',
        reason: 'webhook',
        created_at: now - 7_200_000,
        queued_at: now - 7_200_000,
        finished_at: now - 7_000_000,
        build_duration_ms: null,
        error: 'INDEX_FAILED',
      });
    }
    await store.upsertAccess({ user_id: 'alice', repo_id: id, allowed: 1, verified_at: now });
  }
  const scoped = createAccessKey();
  await store.createKey({
    ...scoped,
    owner: 'alice',
    scope: 'read',
    repos: ids.slice(0, 2),
    expires_at: Date.now() + 3 * 86_400_000,
    revoked: 0,
  });
  const legacy = createAccessKey();
  await store.createKey({
    ...legacy,
    owner: 'alice',
    scope: 'read',
    repos: ids.slice(0, 1),
    expires_at: Date.now() + 7 * 86_400_000,
    revoked: 0,
    legacy_pending: true,
  });
  const bobKey = createAccessKey();
  await store.createKey({
    ...bobKey,
    owner: 'bob',
    scope: 'read',
    repos: ids.slice(1, 2),
    expires_at: Date.now() + 86_400_000,
    revoked: 1,
  });

  await store.appendAuditEvents(
    Array.from({ length: 40 }, (_, index) => ({
      id: randomUUID(),
      at: now - index * 600_000,
      request_id: randomUUID(),
      method: index % 4 === 0 ? 'POST' : 'GET',
      route: index % 3 === 0 ? '/mcp' : index % 3 === 1 ? '/api/v1/repositories/:id' : '/api/v1/me',
      status: index % 7 === 0 ? 404 : index % 11 === 0 ? 500 : 200,
      authentication: 'api_key',
      subject: index % 2 ? 'alice' : 'bob',
      key_prefix: index % 2 ? scoped.prefix : bobKey.prefix,
      repo_id: ids[index % ids.length] ?? null,
      tool: index % 3 === 0 ? 'codegraph_explore' : null,
      tool_outcome: index % 3 === 0 ? (index % 9 === 0 ? 'error' : 'success') : null,
      query_hash: index % 3 === 0 ? randomBytes(32).toString('hex') : null,
    })),
  );
};

const shutdown = async () => {
  abortBuild.abort();
  try {
    await preview.close();
    await app.close();
  } finally {
    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
};
try {
  await seed();
  await app.start();
  await app.listen({ port: 0, host: '127.0.0.1' });
  await preview.listen({ port: PORT, host: '127.0.0.1' });
  process.stdout.write(
    `\nConsole preview: ${origin}/ui/\nSign in with fake Feishu as Alice (super admin) or Bob (member, bind with bob-pat).\n\n`,
  );
} catch (error) {
  await shutdown();
  throw error;
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
