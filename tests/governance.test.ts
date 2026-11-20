import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuditWriter } from '../src/audit-writer.js';
import { CredentialCipher, createAccessKey, hashAccessKey } from '../src/auth.js';
import { CodeupError } from '../src/codeup.js';
import { RateLimiter } from '../src/rate-limit.js';
import { type AuditEvent, createApp } from '../src/server.js';
import { openTestStore } from './helpers/postgres.js';

type Response = { status: number; body: any };
function call(
  base: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = httpRequest(
      url,
      {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function mcpCall(base: string, token: string, name: string, args: Record<string, unknown>) {
  const response = await call(
    base,
    'POST',
    '/mcp',
    token,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accept: 'application/json, text/event-stream' },
  );
  return { status: response.status, result: response.body?.result };
}

test('self-scoped read keys follow live Codeup permissions and administrators govern repositories and keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codeharbor-governance-'));
  const key = randomBytes(32);
  const cipher = new CredentialCipher(key);
  const allowedHosts: string[] = [];
  const audit: AuditEvent[] = [];
  const permitted: Record<string, Set<string>> = {
    'alice-pat': new Set(['11', '22']),
    'bob-pat': new Set(['11']),
    'bob-pat-2': new Set(['11']),
    'bob-pat-3': new Set(['11']),
  };
  const revoked = new Set<string>();
  let permissionChecks = 0;
  let beforePermissionCheck: ((token: string, id: string) => Promise<void>) | undefined;
  const codeup = {
    async getUser(token: string) {
      if (token === 'alice-pat') return { id: 'alice', username: 'alice', name: 'Alice' };
      if (token === 'bob-pat' || token === 'bob-pat-2' || token === 'bob-pat-3') {
        return { id: 'bob', username: 'bob', name: 'Bob' };
      }
      throw new CodeupError('invalid_credential', 401);
    },
    async listRepositories() {
      return { repositories: [], nextPage: null };
    },
    async getRepository(token: string, id: string) {
      permissionChecks++;
      await beforePermissionCheck?.(token, id);
      if (revoked.has(token)) throw new CodeupError('invalid_credential', 401);
      if (!permitted[token]?.has(id)) throw new CodeupError('not_found', 404);
      return {
        id,
        name: `repo-${id}`,
        path: `repo-${id}`,
        accessLevel: 30,
        cloneDownloadRestricted: true,
        httpUrlToRepo: `https://git.example/${id}.git`,
      };
    },
  };
  const graph = {
    async withQuery(fn: (explore: (...a: any[]) => Promise<unknown>) => Promise<unknown>) {
      return fn(async () => 'matching code');
    },
    async probe() {},
    async close() {},
  };
  const enqueued: string[] = [];
  const worker = {
    start() {},
    async stop() {},
    kick() {},
    async enqueue(repoId: string, reason: string) {
      enqueued.push(`${repoId}:${reason}`);
      return { id: 'job', repo_id: repoId, status: 'queued', reason, created_at: Date.now(), error: null };
    },
  };
  const db = await openTestStore();
  const app = createApp(
    {
      dataDir: dir,
      credentialKey: key,
      codeupEndpoint: 'https://devops.example',
      allowedGitHosts: ['git.example'],
      allowedHosts,
      writeUsers: ['alice'],
      codegraphBin: 'codegraph',
      accessTtlMs: 60_000,
      docsEnabled: false,
      authFailureRatePerMinute: 6,
    },
    {
      store: db.store,
      codeup: codeup as never,
      graph: graph as never,
      worker: worker as never,
      audit: (event) => audit.push(event),
    },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  allowedHosts.push(`127.0.0.1:${address.port}`);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const store = app.store;
    await store.createUser({
      id: 'alice',
      username: 'alice',
      credential: cipher.encrypt('alice-pat', 'alice'),
      credential_version: 1,
    });
    await store.createUser({
      id: 'bob',
      username: 'bob',
      credential: cipher.encrypt('bob-pat', 'bob'),
      credential_version: 1,
    });
    const admin = createAccessKey();
    const bobSelf = createAccessKey();
    const bobScoped = createAccessKey();
    await store.createKey({ ...admin, owner: 'alice', scope: 'write', repos: null, expires_at: null, revoked: 0 });
    await store.createKey({ ...bobSelf, owner: 'bob', scope: 'read', repos: null, expires_at: null, revoked: 0 });
    await store.createKey({ ...bobScoped, owner: 'bob', scope: 'read', repos: ['r22'], expires_at: null, revoked: 0 });
    for (const [id, codeupId] of [
      ['r11', '11'],
      ['r22', '22'],
    ]) {
      await store.createRepository({
        id,
        codeup_id: codeupId,
        name: `repo-${codeupId}`,
        branch: 'main',
        owner: 'alice',
        sync_owner: 'alice',
        sync_credential_version: 1,
        hook_hash: 'hook',
        path: `/index/${id}`,
        commit: 'a'.repeat(40),
        indexed_at: 1,
        status: 'ready',
        error: null,
      });
    }

    // Self-scoped key: visibility is decided by Bob's own Codeup permissions, verified on demand and cached.
    const listed = await call(base, 'GET', '/api/v1/repositories', bobSelf.token);
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.body.repositories.map((r: any) => r.repo_id),
      ['r11'],
    );
    assert.equal(permissionChecks, 2);
    assert.equal((await call(base, 'GET', '/api/v1/repositories/r11', bobSelf.token)).status, 200);
    assert.equal((await call(base, 'GET', '/api/v1/repositories/r22', bobSelf.token)).status, 404);
    assert.equal(permissionChecks, 2, 'cached permissions are reused inside the TTL');
    const explore = await mcpCall(base, bobSelf.token, 'codegraph_explore', {
      repo_id: 'r11',
      query: 'where is checkout',
    });
    assert.equal(explore.status, 200);
    assert.equal(explore.result.isError, undefined);
    assert.equal(
      (await mcpCall(base, bobSelf.token, 'codegraph_explore', { repo_id: 'r22', query: 'x' })).result.isError,
      true,
    );
    // Explicitly scoped keys never consult the cloud.
    const before = permissionChecks;
    assert.equal((await call(base, 'GET', '/api/v1/repositories/r22', bobScoped.token)).status, 200);
    assert.equal(permissionChecks, before);
    // Administrator keys manage the platform but never query code.
    assert.equal(
      (await mcpCall(base, admin.token, 'codegraph_explore', { repo_id: 'r11', query: 'x' })).result.isError,
      true,
    );

    // Expired cache rows are re-verified; a revoked Codeup permission disappears.
    permitted['bob-pat'].delete('11');
    await store.upsertAccess({ user_id: 'bob', repo_id: 'r11', allowed: 1, verified_at: Date.now() - 120_000 });
    assert.equal((await call(base, 'GET', '/api/v1/repositories/r11', bobSelf.token)).status, 404);
    assert.equal((await store.getAccess('bob', 'r11'))!.allowed, 0);

    // A delayed success for an old credential cannot populate access for a newer binding.
    permitted['bob-pat'].add('22');
    const staleDeniedAt = Date.now() - 120_000;
    await store.upsertAccess({ user_id: 'bob', repo_id: 'r22', allowed: 0, verified_at: staleDeniedAt });
    let releaseAllowed!: () => void;
    let notifyAllowedStarted!: () => void;
    const allowedStarted = new Promise<void>((resolve) => {
      notifyAllowedStarted = resolve;
    });
    const allowedReleased = new Promise<void>((resolve) => {
      releaseAllowed = resolve;
    });
    beforePermissionCheck = async (token, id) => {
      if (token === 'bob-pat' && id === '22') {
        notifyAllowedStarted();
        await allowedReleased;
      }
    };
    const delayedAllowed = call(base, 'GET', '/api/v1/repositories/r22', bobSelf.token);
    await allowedStarted;
    const rebound = await call(base, 'POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'bob-pat-2' });
    assert.equal(rebound.status, 200);
    const newer = await call(base, 'POST', '/api/v1/auth/bootstrap/keys', rebound.body.bootstrap_token, {
      scope: 'read',
    });
    assert.equal(newer.status, 201);
    releaseAllowed();
    assert.equal((await delayedAllowed).status, 404);
    beforePermissionCheck = undefined;
    assert.deepEqual(await store.getAccess('bob', 'r22'), {
      user_id: 'bob',
      repo_id: 'r22',
      allowed: 0,
      verified_at: staleDeniedAt,
    });
    assert.equal((await call(base, 'GET', '/api/v1/repositories/r22', newer.body.token)).status, 404);

    // A delayed rejection for an old credential cannot revoke newer keys or matching sync state.
    await store.upsertAccess({ user_id: 'bob', repo_id: 'r11', allowed: 1, verified_at: Date.now() - 120_000 });
    let releaseInvalid!: () => void;
    let notifyInvalidStarted!: () => void;
    const invalidStarted = new Promise<void>((resolve) => {
      notifyInvalidStarted = resolve;
    });
    const invalidReleased = new Promise<void>((resolve) => {
      releaseInvalid = resolve;
    });
    beforePermissionCheck = async (token, id) => {
      if (token === 'bob-pat-2' && id === '11') {
        notifyInvalidStarted();
        await invalidReleased;
      }
    };
    const delayedInvalid = call(base, 'GET', '/api/v1/repositories/r11', newer.body.token);
    await invalidStarted;
    const reboundAgain = await call(base, 'POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'bob-pat-3' });
    assert.equal(reboundAgain.status, 200);
    const newest = await call(base, 'POST', '/api/v1/auth/bootstrap/keys', reboundAgain.body.bootstrap_token, {
      scope: 'read',
    });
    assert.equal(newest.status, 201);
    const newestVersion = (await store.getUser('bob'))!.credential_version;
    await store.updateRepository('r22', {
      sync_owner: 'bob',
      sync_credential_version: newestVersion,
      status: 'ready',
      error: null,
    });
    revoked.add('bob-pat-2');
    releaseInvalid();
    assert.equal((await delayedInvalid).status, 404);
    beforePermissionCheck = undefined;
    assert.equal((await store.getKey(hashAccessKey(newest.body.token)))?.revoked, 0);
    assert.equal((await call(base, 'GET', '/api/v1/me', newest.body.token)).status, 200);
    assert.equal((await store.getRepository('r22'))!.status, 'ready');
    revoked.delete('bob-pat-2');

    // An invalid current PAT still revokes every key and matching synchronized repository of that user.
    revoked.add('bob-pat-3');
    await store.upsertAccess({ user_id: 'bob', repo_id: 'r11', allowed: 1, verified_at: Date.now() - 120_000 });
    assert.equal((await call(base, 'GET', '/api/v1/repositories/r11', bobSelf.token)).status, 404);
    assert.equal((await store.getKey(bobSelf.hash))!.revoked, 1);
    assert.equal((await store.getKey(bobScoped.hash))!.revoked, 1);
    assert.equal((await store.getRepository('r22'))!.status, 'credential_required');
    assert.equal((await call(base, 'GET', '/api/v1/repositories/r22', bobScoped.token)).status, 401);
    await store.updateRepository('r22', {
      sync_owner: 'alice',
      sync_credential_version: 1,
      status: 'ready',
      error: null,
    });

    // Background maintenance seeds and refreshes permission rows for users holding self-scoped keys.
    revoked.clear();
    const carol = createAccessKey();
    await store.createUser({
      id: 'carol',
      username: 'carol',
      credential: cipher.encrypt('carol-pat', 'carol'),
      credential_version: 1,
    });
    await store.createKey({ ...carol, owner: 'carol', scope: 'read', repos: null, expires_at: null, revoked: 0 });
    permitted['carol-pat'] = new Set(['22']);
    await app.maintenance();
    assert.deepEqual((await store.listAccess('carol')).map((row) => [row.repo_id, row.allowed]).sort(), [
      ['r11', 0],
      ['r22', 1],
    ]);
    assert.deepEqual(
      (await call(base, 'GET', '/api/v1/repositories', carol.token)).body.repositories.map((r: any) => r.repo_id),
      ['r22'],
    );

    // Administrative governance.
    assert.equal((await call(base, 'GET', '/api/v1/admin/users', carol.token)).status, 403);
    const users = await call(base, 'GET', '/api/v1/admin/users', admin.token);
    assert.deepEqual(
      users.body.users.map((u: any) => u.id),
      ['alice', 'bob', 'carol'],
    );
    assert.ok(!JSON.stringify(users.body).includes('credential"'));
    const keys = await call(base, 'GET', '/api/v1/admin/api-keys?owner=carol', admin.token);
    assert.deepEqual(
      keys.body.keys.map((k: any) => k.prefix),
      [carol.prefix],
    );
    assert.ok(!JSON.stringify(keys.body).includes(carol.hash));
    assert.equal(
      (await call(base, 'DELETE', `/api/v1/admin/api-keys/${carol.prefix.slice(0, 11)}`, admin.token)).status,
      200,
    );
    assert.equal((await call(base, 'GET', '/api/v1/repositories', carol.token)).status, 401);
    const dave = createAccessKey();
    await store.createUser({
      id: 'dave',
      username: 'dave',
      credential: cipher.encrypt('dave-pat', 'dave'),
      credential_version: 1,
    });
    await store.createKey({ ...dave, owner: 'dave', scope: 'read', repos: ['r22'], expires_at: null, revoked: 0 });
    assert.equal((await call(base, 'POST', '/api/v1/admin/users/dave/revoke-keys', admin.token)).status, 200);
    assert.equal((await store.getKey(dave.hash))!.revoked, 1);

    assert.equal((await call(base, 'POST', '/api/v1/repositories/r22/disable', bobScoped.token)).status, 401);
    assert.equal(
      (await call(base, 'DELETE', '/api/v1/repositories/r22', admin.token)).status,
      409,
      'only disabled repositories can be deleted',
    );
    assert.equal((await call(base, 'POST', '/api/v1/repositories/r22/disable', admin.token)).status, 200);
    assert.equal((await store.getRepository('r22'))!.status, 'disabled');
    assert.equal((await call(base, 'GET', '/api/v1/repositories/r22', admin.token)).status, 404);
    assert.equal((await call(base, 'POST', '/api/v1/repositories/r22/enable', admin.token)).status, 202);
    assert.equal((await store.getRepository('r22'))!.status, 'updating');
    assert.deepEqual(enqueued, ['r22:manual']);
    assert.equal((await call(base, 'POST', '/api/v1/repositories/r22/disable', admin.token)).status, 200);
    assert.equal((await call(base, 'DELETE', '/api/v1/repositories/r22', admin.token)).status, 200);
    assert.equal(await store.getRepository('r22'), undefined);
    assert.deepEqual(
      await store.listAccess('carol'),
      (await store.listAccess('carol')).filter((row) => row.repo_id !== 'r22'),
    );

    // Disabled documentation endpoints return 404.
    assert.equal((await call(base, 'GET', '/docs', admin.token)).status, 404);
    assert.equal((await call(base, 'GET', '/openapi.json', admin.token)).status, 404);

    // Audit events carry the subject, repository and a query hash, never the query text.
    const events = audit.filter((event) => event.tool === 'codegraph_explore');
    assert.ok(
      events.some(
        (event) =>
          event.subject === 'bob' &&
          event.repo_id === 'r11' &&
          typeof event.query_hash === 'string' &&
          /^[a-f0-9]{64}$/.test(event.query_hash),
      ),
    );
    assert.ok(!JSON.stringify(audit).includes('where is checkout'));
    const admined = await call(base, 'GET', '/api/v1/admin/audit?limit=10', admin.token);
    assert.equal(admined.status, 200);
    assert.deepEqual(admined.body.events, []);

    // Admission is checked before the key store, even when the next key is valid.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await call(base, 'GET', '/api/v1/me', createAccessKey().token)).status);
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    assert.equal((await call(base, 'GET', '/api/v1/me', admin.token)).status, 429);
  } finally {
    await app.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit writer persists batches durably and drops rather than blocks on overflow', async () => {
  const db = await openTestStore();
  const store = db.store;
  try {
    const writer = new AuditWriter(store, { maxQueued: 3, batchSize: 2, flushMs: 10 });
    for (let i = 0; i < 5; i++)
      writer.record({
        request_id: `r${i}`,
        method: 'POST',
        route: '/mcp',
        status: 200,
        subject: 'alice',
        repo_id: 'repo',
        tool: 'codegraph_explore',
        tool_outcome: 'success',
        query_hash: 'a'.repeat(64),
      });
    assert.equal(writer.dropped, 2);
    await writer.close();
    const rows = await store.listAuditEvents({ subject: 'alice', limit: 10 });
    assert.equal(rows.length, 3);
    assert.equal(rows[0].query_hash, 'a'.repeat(64));
    assert.deepEqual(await store.listAuditEvents({ repo_id: 'other', limit: 10 }), []);
    assert.equal(await store.purgeAuditEvents(Date.now() + 1), 3);
    writer.record({ request_id: 'late', method: 'GET', route: '/api/v1/me', status: 200 });
    assert.equal(writer.dropped, 3, 'a closed writer drops instead of queueing');
    const failing = new AuditWriter(
      {
        async appendAuditEvents() {
          throw new Error('down');
        },
      },
      { flushMs: 1 },
    );
    failing.record({ request_id: 'x', method: 'GET', route: '/api/v1/me', status: 200 });
    await failing.close();
    assert.equal(failing.failed, 1);
  } finally {
    await db.close();
  }
});

test('rate limiter enforces fixed windows with bounded memory', () => {
  const limiter = new RateLimiter(2, 1000, 2);
  assert.ok(limiter.hit('a', 0));
  assert.ok(limiter.hit('a', 10));
  assert.ok(!limiter.hit('a', 20));
  assert.equal(limiter.blocked('a', 20), true);
  assert.ok(limiter.hit('a', 1001), 'a new window starts after expiry');
  assert.equal(limiter.blocked('a', 1001), false);
  assert.ok(limiter.hit('b', 1001));
  assert.equal(limiter.size, 2);
  assert.ok(limiter.hit('c', 1002), 'the oldest key is evicted when the table is full');
  assert.equal(limiter.size, 2);
  assert.throws(() => new RateLimiter(0, 1000), /Invalid rate limit/);
});
