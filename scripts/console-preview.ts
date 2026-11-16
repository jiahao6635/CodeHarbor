// Preview server for the console: a mock Codeup, the test PostgreSQL and seeded data. Development only.
//
//   npm run test:db:up && npm run build:web && npx tsx scripts/console-preview.ts
//
// Prints an admin key and a read key to sign in with. Nothing here talks to a real Yunxiao.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CredentialCipher, createAccessKey } from '../src/auth.js';
import { CodeupError } from '../src/codeup.js';
import { type AppConfig, createApp } from '../src/server.js';
import type { RepositoryRecord } from '../src/store.js';
import { openTestStore } from '../tests/helpers/postgres.js';

const PORT = Number(process.env.PORT ?? '8099');
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
  cloneDownloadRestricted: false,
  httpUrlToRepo: `https://codeup.example/sigmob/repo-${1000 + index}.git`,
}));

const userFor = (token: string) => {
  const user = users[token as keyof typeof users];
  if (!user) throw new CodeupError('invalid_credential', 401);
  return user;
};
const codeup = {
  async getUser(token: string) {
    return userFor(token);
  },
  async listRepositories(token: string, page: number, size: number) {
    userFor(token);
    const start = (page - 1) * size;
    return {
      repositories: codeupRepos.slice(start, start + size),
      nextPage: start + size < codeupRepos.length ? page + 1 : null,
    };
  },
  async getRepository(token: string, id: string) {
    userFor(token);
    const repo = codeupRepos.find((candidate) => candidate.id === id);
    if (!repo) throw new CodeupError('not_found', 404);
    return repo;
  },
};

const db = await openTestStore();
const { store } = db;
const dataDir = mkdtempSync(join(tmpdir(), 'codeharbor-preview-'));
const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
let app: ReturnType<typeof createApp>;
const worker = {
  start() {},
  async stop() {},
  kick() {},
  async enqueue(repoId: string, reason: string) {
    const job = {
      id: randomUUID(),
      repo_id: repoId,
      status: 'queued' as const,
      reason,
      created_at: Date.now(),
      error: null,
    };
    await store.createJob(job);
    await store.updateRepository(repoId, { status: 'updating', error: null });
    // Pretend the build finishes shortly so polling in the console is visible.
    setTimeout(async () => {
      const repo = await store.getRepository(repoId);
      if (!repo) return;
      const commit = randomBytes(20).toString('hex');
      await store.updateJob(job.id, {
        status: 'succeeded',
        finished_at: Date.now(),
        build_duration_ms: 4200 + Math.floor(Math.random() * 20_000),
      });
      await store.updateRepository(repoId, {
        status: 'ready',
        commit,
        path: `/index/${repoId}/${commit}`,
        indexed_at: Date.now(),
        error: null,
      });
    }, 12_000);
    return job;
  },
};

const config: AppConfig = {
  dataDir,
  credentialKey: randomBytes(32),
  codeupEndpoint: 'https://codeup.example',
  organizationId: 'org',
  allowedGitHosts: ['codeup.example'],
  allowedHosts,
  writeUsers: ['alice'],
  codegraphBin: 'codegraph',
  uiDir: fileURLToPath(new URL('../web/dist', import.meta.url)),
  uiMcpUrl: 'https://mcp.internal.example/mcp',
  publicMcpDisabled: true,
};
app = createApp(config, {
  store,
  codeup: codeup as never,
  graph: { async withQuery() {}, async probe() {}, async close() {} } as never,
  worker: worker as never,
  probe: async () => true,
});

// ---- Seed ------------------------------------------------------------------------------------
const seed = async () => {
  const cipher = new CredentialCipher(config.credentialKey);
  const encrypt = (pat: string, id: string) => cipher.encrypt(pat, id);
  await store.createUser({
    id: 'alice',
    username: 'alice',
    credential: encrypt('alice-pat', 'alice'),
    credential_version: 2,
  });
  await store.createUser({ id: 'bob', username: 'bob', credential: encrypt('bob-pat', 'bob'), credential_version: 1 });
  const admin = createAccessKey();
  await store.createKey({
    ...admin,
    owner: 'alice',
    scope: 'write',
    repos: null,
    expires_at: Date.now() + 30 * 86_400_000,
    revoked: 0,
  });
  const reader = createAccessKey();
  await store.createKey({
    ...reader,
    owner: 'alice',
    scope: 'read',
    repos: null,
    expires_at: Date.now() + 7 * 86_400_000,
    revoked: 0,
  });
  const bobKey = createAccessKey();
  await store.createKey({
    ...bobKey,
    owner: 'bob',
    scope: 'read',
    repos: null,
    expires_at: Date.now() + 86_400_000,
    revoked: 0,
  });
  const revoked = createAccessKey();
  await store.createKey({
    ...revoked,
    owner: 'alice',
    scope: 'read',
    repos: ['x'],
    expires_at: Date.now() + 86_400_000,
    revoked: 1,
  });

  const now = Date.now();
  const statuses: Array<[string, Partial<RepositoryRecord>]> = [
    ['1000', { status: 'ready', commit: randomBytes(20).toString('hex'), indexed_at: now - 3_600_000 }],
    ['1001', { status: 'indexing' }],
    ['1002', { status: 'updating', commit: randomBytes(20).toString('hex'), indexed_at: now - 86_400_000 }],
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
    ['1006', { status: 'pending' }],
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
        reason: 'webhook',
        created_at: now - 7_200_000,
        queued_at: now - 7_200_000,
        finished_at: now - 7_000_000,
        build_duration_ms: null,
        error: 'INDEX_FAILED',
      });
    }
    if (patch.status === 'indexing' || patch.status === 'updating') {
      await store.createJob({
        id: randomUUID(),
        repo_id: id,
        status: 'running',
        reason: 'manual',
        created_at: now - 60_000,
        queued_at: now - 60_000,
        error: null,
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
      key_prefix: index % 2 ? admin.prefix : bobKey.prefix,
      repo_id: ids[index % ids.length] ?? null,
      tool: index % 3 === 0 ? 'codegraph_explore' : null,
      tool_outcome: index % 3 === 0 ? (index % 9 === 0 ? 'error' : 'success') : null,
      query_hash: index % 3 === 0 ? randomBytes(32).toString('hex') : null,
    })),
  );
  return { admin: admin.token, reader: reader.token, bob: bobKey.token };
};

const tokens = await seed();
await app.listen({ port: PORT, host: '127.0.0.1' });
process.stdout.write(
  `\nConsole preview: http://127.0.0.1:${PORT}/ui/\n  admin key (alice, write): ${tokens.admin}\n  read key  (alice, read):  ${tokens.reader}\n  read key  (bob, read):    ${tokens.bob}\n  onboarding PATs: alice-pat (write allowed), bob-pat\n\n`,
);
const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
