import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp, type AppConfig } from '../src/server.js';
import { CodeupError } from '../src/codeup.js';

test('HTTP bootstrap, permissions, MCP and webhooks enforce repository boundaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codeharbor-api-'));
  const allowedHosts: string[] = [];
  const allowedByToken: Record<string, Set<string>> = {
    'alice-pat': new Set(['11', '22']),
    'alice-pat-2': new Set(['11', '22']),
    'bob-pat': new Set(),
  };
  const revokedTokens = new Set<string>();
  let delayOldCredential: (() => Promise<void>) | undefined;
  let offline = false;
  const userFor = (token: string) => {
    if (revokedTokens.has(token)) throw new CodeupError('invalid_credential', 401);
    if (token === 'alice-pat' || token === 'alice-pat-2') return { id: 'alice', username: 'alice', name: 'Alice' };
    if (token === 'bob-pat') return { id: 'bob', username: 'bob', name: 'Bob' };
    throw new CodeupError('invalid_credential', 401);
  };
  const fakeCodeup = {
    async getUser(token: string) { return userFor(token); },
    async listRepositories(token: string) { userFor(token); return { repositories: [], nextPage: null }; },
    async getRepository(token: string, id: string) {
      userFor(token);
      if (token === 'alice-pat' && delayOldCredential) {
        await delayOldCredential();
        throw new CodeupError('invalid_credential', 401);
      }
      if (offline) throw new CodeupError('unavailable');
      if (!allowedByToken[token]?.has(id)) throw new CodeupError('not_found', 404);
      return { id, name: `repo-${id}`, path: `repo-${id}`, accessLevel: 30,
        cloneDownloadRestricted: false, httpUrlToRepo: `https://git.example/${id}.git` };
    },
  };
  const graphCalls: { path: string; query: string }[] = [];
  const fakeGraph = {
    async withQuery(fn: (explore: (path: string, query: string) => Promise<unknown>) => Promise<unknown>) {
      return fn(async (path, query) => { graphCalls.push({ path, query }); return { result: 'matching code' }; });
    },
    async close() {},
  };
  let kickCount = 0;
  let app: ReturnType<typeof createApp>;
  const fakeWorker = {
    start() {},
    async stop() {},
    kick() { kickCount++; },
    enqueue(repoId: string, reason: string) {
      const job = { id: randomUUID(), repo_id: repoId, status: 'queued' as const, reason, created_at: Date.now(), error: null };
      app.store.createJob(job);
      return job;
    },
  };
  const config: AppConfig = {
    dataDir: dir, databasePath: join(dir, 'state.sqlite'), credentialKey: randomBytes(32),
    codeupEndpoint: 'https://devops.example', organizationId: 'org', allowedGitHosts: ['git.example'],
    allowedHosts, writeUsers: ['alice'], codegraphBin: 'codegraph',
  };
  app = createApp(config, { codeup: fakeCodeup as never, graph: fakeGraph as never, worker: fakeWorker as never });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  allowedHosts.push(`127.0.0.1:${address.port}`);
  const base = `http://127.0.0.1:${address.port}`;

  async function request(method: string, path: string, token?: string, value?: unknown, headers?: Record<string, string>) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(value !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  try {
    const invalid = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'wrong-secret' });
    assert.equal(invalid.status, 401);
    assert.ok(!JSON.stringify(invalid.body).includes('wrong-secret'));
    const aliceBind = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'alice-pat' });
    assert.equal(aliceBind.status, 200);
    const bootstrap = aliceBind.body.bootstrap_token;
    const aliceKey = await request('POST', '/api/v1/auth/bootstrap/keys', bootstrap, { scope: 'write', expires_in: 7200 });
    assert.equal(aliceKey.status, 201);
    assert.equal((await request('POST', '/api/v1/auth/bootstrap/keys', bootstrap, { scope: 'write' })).status, 401);
    const alice = aliceKey.body.token as string;
    const bobBind = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'bob-pat' });
    assert.equal((await request('POST', '/api/v1/auth/bootstrap/keys', bobBind.body.bootstrap_token, { scope: 'write' })).status, 403);
    const bobKey = await request('POST', '/api/v1/auth/bootstrap/keys', bobBind.body.bootstrap_token, { scope: 'read' });
    assert.equal(bobKey.status, 201);
    const bob = bobKey.body.token as string;

    assert.equal((await request('POST', '/api/v1/repositories', bob, { codeup_repository_id: '11', authorize_automatic_sync: true })).status, 403);
    assert.equal((await request('POST', '/api/v1/repositories', alice, { codeup_repository_id: '11' })).status, 400);
    const created = await request('POST', '/api/v1/repositories', alice, { codeup_repository_id: '11', branch: 'main', authorize_automatic_sync: true });
    assert.equal(created.status, 202);
    assert.equal(kickCount, 1);
    const repo = created.body.repository.repo_id as string;
    const job = created.body.job_id as string;
    assert.equal((await request('GET', `/api/v1/jobs/${job}`, alice)).status, 200);
    assert.equal((await request('GET', `/api/v1/jobs/${job}`, bob)).status, 404);
    assert.equal((await request('GET', `/api/v1/repositories/${repo}`, bob)).status, 404);
    assert.equal((await request('GET', '/api/v1/repositories', bob)).body.repositories.length, 0);
    const duplicate = await request('POST', '/api/v1/repositories', alice, { codeup_repository_id: '11', branch: 'main', authorize_automatic_sync: true });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.repository.repo_id, repo);

    allowedByToken['bob-pat'].add('11');
    assert.equal((await request('GET', `/api/v1/repositories/${repo}`, bob)).status, 200);
    assert.equal((await request('POST', `/api/v1/repositories/${repo}/sync`, bob)).status, 403);
    app.store.updateRepository(repo, { path: '/private/index', commit: 'a'.repeat(40), indexed_at: Date.now(), status: 'ready' });

    const mcp = (token: string, name: string, args: Record<string, unknown>) => request('POST', '/mcp', token,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      { accept: 'application/json, text/event-stream' });
    const found = await mcp(bob, 'codegraph_explore', { repo_id: repo, query: 'order flow' });
    assert.equal(found.status, 200);
    assert.match(JSON.stringify(found.body), /matching code/);
    assert.ok(!JSON.stringify(found.body).includes('/private/index'));
    assert.deepEqual(graphCalls, [{ path: '/private/index', query: 'order flow' }]);
    const injection = await mcp(bob, 'codegraph_explore', { repo_id: repo, query: 'x', projectPath: '/other' });
    assert.match(JSON.stringify(injection.body), /Invalid arguments/);
    assert.equal(graphCalls.length, 1);
    allowedByToken['bob-pat'].delete('11');
    const denied = await mcp(bob, 'codegraph_explore', { repo_id: repo, query: 'x' });
    assert.match(JSON.stringify(denied.body), /Repository not found/);
    assert.equal(graphCalls.length, 1);
    offline = true;
    assert.equal((await request('GET', `/api/v1/repositories/${repo}`, alice)).status, 503);
    offline = false;

    const second = await request('POST', '/api/v1/repositories', alice, { codeup_repository_id: '22', authorize_automatic_sync: true });
    assert.equal(second.status, 202);
    const scoped = await request('POST', '/api/v1/api-keys', alice, { scope: 'read', repos: [repo], expires_in: 3600 });
    assert.equal(scoped.status, 201);
    assert.equal((await request('GET', `/api/v1/repositories/${second.body.repository.repo_id}`, scoped.body.token)).status, 404);
    assert.equal((await request('DELETE', `/api/v1/api-keys/${scoped.body.prefix}`, alice)).status, 200);
    assert.equal((await request('GET', `/api/v1/repositories/${repo}`, scoped.body.token)).status, 401);

    const payload = { object_kind: 'push', project_id: 11, ref: 'refs/heads/main', after: 'b'.repeat(40) };
    const hookPath = created.body.webhook_path;
    assert.equal((await request('POST', hookPath, undefined, payload, { 'x-codeup-token': 'incorrect', 'codeup-event': 'Push Hook' })).status, 404);
    const before = app.store.listJobs(repo).length;
    assert.equal((await request('POST', hookPath, undefined, { ...payload, ref: 'refs/heads/feature' }, { 'x-codeup-token': created.body.webhook_token, 'codeup-event': 'Push Hook' })).status, 202);
    assert.equal(app.store.listJobs(repo).length, before);
    assert.equal((await request('POST', hookPath, undefined, payload, { 'x-codeup-token': created.body.webhook_token, 'codeup-event': 'Push Hook' })).status, 202);
    assert.equal(app.store.listJobs(repo).length, before + 1);

    const restrictedWrite = await request('POST', '/api/v1/api-keys', alice, { scope: 'write', repos: [repo], expires_in: 3600 });
    assert.equal(restrictedWrite.status, 201);
    const restrictedToken = restrictedWrite.body.token as string;
    assert.equal((await request('GET', '/api/v1/codeup/repositories', restrictedToken)).status, 403);
    const restrictedKeys = await request('GET', '/api/v1/api-keys', restrictedToken);
    assert.equal(restrictedKeys.status, 200);
    assert.deepEqual(restrictedKeys.body.keys.map((entry: { prefix: string }) => entry.prefix), [restrictedWrite.body.prefix]);
    assert.equal((await request('DELETE', `/api/v1/api-keys/${aliceKey.body.prefix}`, restrictedToken)).status, 404);
    assert.equal((await request('POST', '/api/v1/api-keys', restrictedToken, { scope: 'write', repos: null, expires_in: 60 })).status, 403);
    assert.equal((await request('POST', '/api/v1/api-keys', restrictedToken, { scope: 'read', repos: [second.body.repository.repo_id], expires_in: 60 })).status, 403);
    assert.equal((await request('POST', '/api/v1/api-keys', restrictedToken, { scope: 'read', repos: [repo], expires_in: 7200 })).status, 403);

    // A confirmed PAT revocation invalidates all of the owner's previously issued keys.
    revokedTokens.add('alice-pat');
    assert.equal((await request('GET', `/api/v1/repositories/${repo}`, alice)).status, 404);
    assert.equal((await request('GET', '/api/v1/me', alice)).status, 401);
    assert.equal((await request('GET', '/api/v1/me', restrictedToken)).status, 401);
    revokedTokens.delete('alice-pat');
    const previousVersion = app.store.getUser('alice')!.credential_version;
    const originalSyncVersion = app.store.getRepository(repo)!.sync_credential_version;
    const rebound = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'alice-pat' });
    assert.equal(rebound.status, 200);
    assert.equal(app.store.getUser('alice')!.credential_version, previousVersion + 1);
    assert.equal(app.store.getRepository(repo)!.sync_credential_version, originalSyncVersion);
    assert.equal(app.store.getRepository(repo)!.status, 'credential_required');
    assert.equal(app.store.getRepository(second.body.repository.repo_id)!.status, 'credential_required');
    assert.equal((await request('GET', '/api/v1/me', alice)).status, 401);
    const fresh = await request('POST', '/api/v1/auth/bootstrap/keys', rebound.body.bootstrap_token, { scope: 'write' });
    assert.equal(fresh.status, 201);

    // Having write capability and Codeup access does not make Bob the repository owner.
    config.writeUsers.push('bob');
    allowedByToken['bob-pat'].add('11');
    const bobRebind = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'bob-pat' });
    const bobWrite = await request('POST', '/api/v1/auth/bootstrap/keys', bobRebind.body.bootstrap_token, { scope: 'write' });
    assert.equal(bobWrite.status, 201);
    const syncCredentialPath = `/api/v1/repositories/${repo}/sync-credential`;
    assert.equal((await request('PUT', syncCredentialPath, bobWrite.body.token, { authorize_automatic_sync: true })).status, 404);
    assert.equal((await request('PUT', syncCredentialPath, fresh.body.token, {})).status, 400);
    assert.equal((await request('PUT', syncCredentialPath, fresh.body.token, { authorize_automatic_sync: false })).status, 400);
    assert.equal(app.store.getRepository(repo)!.sync_credential_version, originalSyncVersion);
    const credentialRefresh = await request('PUT', syncCredentialPath, fresh.body.token, { authorize_automatic_sync: true });
    assert.equal(credentialRefresh.status, 202);
    assert.equal(app.store.getRepository(repo)!.sync_credential_version, previousVersion + 1);
    assert.equal(app.store.getJob(credentialRefresh.body.job_id)?.reason, 'credential_changed');
    assert.equal(app.store.getJob(credentialRefresh.body.job_id)?.status, 'queued');
    assert.equal(app.store.getRepository(second.body.repository.repo_id)!.status, 'credential_required');

    // A delayed rejection for an old credential cannot revoke a newer binding's keys.
    let releaseOld!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const released = new Promise<void>(resolve => { releaseOld = resolve; });
    delayOldCredential = async () => { notifyStarted(); await released; };
    const delayedRequest = request('GET', `/api/v1/repositories/${repo}`, fresh.body.token);
    await started;
    const reboundAgain = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'alice-pat-2' });
    const newer = await request('POST', '/api/v1/auth/bootstrap/keys', reboundAgain.body.bootstrap_token, { scope: 'write' });
    assert.equal(newer.status, 201);
    releaseOld();
    assert.equal((await delayedRequest).status, 404);
    assert.equal((await request('GET', '/api/v1/me', newer.body.token)).status, 200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
