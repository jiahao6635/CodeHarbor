import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAccessKey, hashAccessKey } from '../src/auth.js';
import { CodeupError } from '../src/codeup.js';
import type { AppConfig, AuditEvent } from '../src/server.js';
import { createLegacyTestApp as createApp } from './helpers/legacy-auth.js';
import { openTestStore } from './helpers/postgres.js';

test('HTTP bootstrap, permissions, MCP and webhooks enforce repository boundaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codeharbor-api-'));
  const allowedHosts: string[] = [];
  const allowedByToken: Record<string, Set<string>> = {
    'alice-pat': new Set(['11', '22']),
    'alice-pat-2': new Set(['11', '22']),
    'bob-pat': new Set(),
  };
  const revokedTokens = new Set<string>();
  const deniedCloneTokens = new Set<string>();
  const probeCalls: string[] = [];
  let duringExplore: (() => void | Promise<void>) | undefined;
  let delayOldCredential: (() => Promise<void>) | undefined;
  let duringIndexRuntimeProbe: ((signal?: AbortSignal) => Promise<void>) | undefined;
  let offline = false;
  let indexRuntimeHealthy = true;
  let runtimeFenced = false;
  const userFor = (token: string) => {
    if (revokedTokens.has(token)) throw new CodeupError('invalid_credential', 401);
    if (token === 'alice-pat' || token === 'alice-pat-2') return { id: 'alice', username: 'alice', name: 'Alice' };
    if (token === 'bob-pat') return { id: 'bob', username: 'bob', name: 'Bob' };
    throw new CodeupError('invalid_credential', 401);
  };
  const fakeCodeup = {
    async getUser(token: string) {
      return userFor(token);
    },
    async listRepositories(token: string) {
      userFor(token);
      if (token === 'alice-pat-2' && delayOldCredential) {
        await delayOldCredential();
        throw new CodeupError('invalid_credential', 401);
      }
      return { repositories: [], nextPage: null };
    },
    async getRepository(token: string, id: string) {
      userFor(token);
      if (offline) throw new CodeupError('unavailable');
      if (!allowedByToken[token]?.has(id)) throw new CodeupError('not_found', 404);
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
  const graphCalls: { path: string; query: string }[] = [];
  const fakeGraph = {
    async withQuery(fn: (explore: (path: string, query: string) => Promise<unknown>) => Promise<unknown>) {
      return fn(async (path, query) => {
        graphCalls.push({ path, query });
        await duringExplore?.();
        return { result: 'matching code' };
      });
    },
    async probe(signal?: AbortSignal) {
      if (!indexRuntimeHealthy) throw new Error('private runtime details');
      await duringIndexRuntimeProbe?.(signal);
    },
    async close() {},
  };
  let kickCount = 0;
  const audit: AuditEvent[] = [];
  let app: ReturnType<typeof createApp>;
  const fakeWorker = {
    start() {},
    async stop() {},
    kick() {
      kickCount++;
    },
    async enqueue(repoId: string, reason: string) {
      const job = {
        id: randomUUID(),
        repo_id: repoId,
        status: 'queued' as const,
        reason,
        created_at: Date.now(),
        error: null,
      };
      await app.store.createJob(job);
      return job;
    },
  };
  const db = await openTestStore();
  const config: AppConfig = {
    dataDir: dir,
    credentialKey: randomBytes(32),
    codeupEndpoint: 'https://devops.example',
    organizationId: 'org',
    allowedGitHosts: ['git.example'],
    allowedHosts,
    writeUsers: ['alice'],
    codegraphBin: 'codegraph',
    defaultSyncIntervalMinutes: 30,
  };
  app = createApp(config, {
    store: db.store,
    codeup: fakeCodeup as never,
    graph: fakeGraph as never,
    worker: fakeWorker as never,
    probe: async (request) => {
      probeCalls.push(request.token);
      return !deniedCloneTokens.has(request.token);
    },
    fenced: () => ({ image_runtime: runtimeFenced }),
    audit: (event) => audit.push(event),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  allowedHosts.push(`127.0.0.1:${address.port}`);
  const base = `http://127.0.0.1:${address.port}`;

  async function request(
    method: string,
    path: string,
    token?: string,
    value?: unknown,
    headers?: Record<string, string>,
  ) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(value !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  function partialRequest(method: string, path: string, token: string, start: string) {
    let resolveResponse!: (value: { status: number; body: Record<string, any> }) => void;
    let rejectResponse!: (reason: unknown) => void;
    const response = new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const req = httpRequest(
      `${base}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('error', rejectResponse);
        res.on('end', () => {
          try {
            resolveResponse({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch (error) {
            rejectResponse(error);
          }
        });
      },
    );
    req.on('error', rejectResponse);
    req.write(start);
    return {
      finish(end: string) {
        req.end(end);
        return response;
      },
    };
  }

  try {
    assert.equal((await request('GET', '/health/live')).status, 200);
    assert.equal((await request('GET', '/health/ready')).status, 200);
    assert.equal((await request('GET', '/metrics')).status, 404);
    assert.equal(
      (await request('GET', '/health/live', undefined, undefined, { origin: 'https://untrusted.example' })).status,
      403,
    );
    const docs = await fetch(`${base}/docs/`);
    assert.equal(docs.status, 200);
    assert.match(docs.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.match(await docs.text(), /swagger-ui/i);
    assert.equal((await fetch(`${base}/docs`)).status, 200);
    assert.equal((await fetch(`${base}/docs/static/swagger-ui-bundle.js`)).status, 200);
    const initializer = await fetch(`${base}/docs/static/swagger-initializer.js`);
    assert.equal(initializer.status, 200);
    const initializerText = await initializer.text();
    assert.match(initializerText, /persistAuthorization: false|"persistAuthorization":false/);
    assert.match(initializerText, /validatorUrl: null|"validatorUrl":null/);
    const openapi = await request('GET', '/openapi.json');
    assert.equal(openapi.status, 200);
    assert.match(openapi.body.openapi, /^3\./);
    assert.ok(openapi.body.paths['/api/v1/repositories']);
    const performancePath = '/api/v1/admin/system/performance';
    assert.ok(openapi.body.paths[performancePath]);
    assert.deepEqual((await request('GET', '/docs/json')).body, openapi.body);
    for (const path of ['/docs/', '/docs/json', '/docs/static/swagger-ui-bundle.js', '/openapi.json']) {
      const badHostStatus = await new Promise<number>((resolve, reject) => {
        httpRequest(`${base}${path}`, { headers: { host: 'untrusted.example' } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        })
          .on('error', reject)
          .end();
      });
      assert.equal(badHostStatus, 403);
      assert.equal((await fetch(`${base}${path}`, { headers: { origin: 'https://untrusted.example' } })).status, 403);
    }
    assert.equal((await request('GET', '/api/v1/me')).status, 401);
    assert.equal(
      (await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'x'.repeat(70_000) })).status,
      413,
    );
    const invalid = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'wrong-secret' });
    assert.equal(invalid.status, 401);
    assert.ok(!JSON.stringify(invalid.body).includes('wrong-secret'));
    const aliceBind = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'alice-pat' });
    assert.equal(aliceBind.status, 200);
    const bootstrap = aliceBind.body.bootstrap_token;
    const aliceKey = await request('POST', '/api/v1/auth/bootstrap/keys', bootstrap, {
      scope: 'write',
      expires_in: 7200,
    });
    assert.equal(aliceKey.status, 201);
    assert.equal((await request('POST', '/api/v1/auth/bootstrap/keys', bootstrap, { scope: 'write' })).status, 401);
    const alice = aliceKey.body.token as string;
    const bobBind = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'bob-pat' });
    assert.equal(
      (await request('POST', '/api/v1/auth/bootstrap/keys', bobBind.body.bootstrap_token, { scope: 'write' })).status,
      403,
    );
    const bobKey = await request('POST', '/api/v1/auth/bootstrap/keys', bobBind.body.bootstrap_token, {
      scope: 'read',
    });
    assert.equal(bobKey.status, 201);
    const bob = bobKey.body.token as string;

    assert.equal((await request('GET', performancePath)).status, 401);
    assert.equal((await request('GET', performancePath, bob)).status, 403);
    const getPerformance = (signal?: AbortSignal) =>
      fetch(`${base}${performancePath}`, { headers: { authorization: `Bearer ${alice}` }, signal });
    const performance = await getPerformance();
    assert.equal(performance.status, 200);
    assert.equal(performance.headers.get('cache-control'), 'no-store');
    const snapshot = await performance.json();
    assert.equal(snapshot.health.status, 'ok');
    assert.equal(snapshot.health.database, 'ok');
    assert.equal(snapshot.health.indexRuntime, 'ok');
    assert.equal(snapshot.health.fenced.image_runtime, false);
    assert.ok(Number.isFinite(Date.parse(snapshot.performance.sampledAt)));
    assert.ok(snapshot.performance.system.cpuCount >= 0);
    assert.ok(snapshot.performance.system.totalMemoryBytes > 0);
    assert.ok(snapshot.performance.process.uptimeSeconds > 0);
    assert.ok(snapshot.performance.process.residentMemoryBytes > 0);
    assert.ok(snapshot.performance.storage.totalBytes > 0);
    assert.ok(!JSON.stringify(snapshot).includes(dir));

    runtimeFenced = true;
    assert.equal((await request('GET', performancePath, alice)).body.health.status, 'degraded');
    runtimeFenced = false;

    const checkHealth = app.store.checkHealth;
    app.store.checkHealth = async () => {
      throw new Error('private database details');
    };
    indexRuntimeHealthy = false;
    try {
      const degraded = await request('GET', performancePath, alice);
      assert.equal(degraded.status, 200);
      assert.equal(degraded.body.health.status, 'degraded');
      assert.equal(degraded.body.health.database, 'unavailable');
      assert.equal(degraded.body.health.indexRuntime, 'unavailable');
      assert.doesNotMatch(JSON.stringify(degraded.body), /private (runtime|database) details/);
      assert.equal((await request('GET', '/health/ready')).status, 503);
    } finally {
      app.store.checkHealth = checkHealth;
      indexRuntimeHealthy = true;
    }

    let releaseProbe!: () => void;
    const blockedProbe = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const probeSignals: (AbortSignal | undefined)[] = [];
    duringIndexRuntimeProbe = (signal) => {
      probeSignals.push(signal);
      return blockedProbe;
    };
    try {
      const watchdog = AbortSignal.timeout(10_000);
      const concurrent = await Promise.all([getPerformance(watchdog), getPerformance(watchdog)]);
      for (const response of [...concurrent, await getPerformance(watchdog)]) {
        assert.equal(response.status, 200);
        const { health, performance } = await response.json();
        assert.equal(health.status, 'degraded');
        assert.equal(health.database, 'ok');
        assert.equal(health.indexRuntime, 'unavailable');
        assert.ok(performance.process.residentMemoryBytes > 0);
      }
      assert.equal(probeSignals.length, 1);
      assert.equal(probeSignals[0]?.aborted, true);
    } finally {
      duringIndexRuntimeProbe = undefined;
      releaseProbe();
    }
    assert.equal((await request('GET', performancePath, alice)).body.health.status, 'ok');

    assert.equal(
      (
        await request('POST', '/api/v1/repositories', bob, {
          codeup_repository_id: '11',
          authorize_automatic_sync: true,
        })
      ).status,
      403,
    );
    assert.equal((await request('POST', '/api/v1/repositories', alice, { codeup_repository_id: '11' })).status, 400);
    deniedCloneTokens.add('alice-pat');
    assert.equal(
      (
        await request('POST', '/api/v1/repositories', alice, {
          codeup_repository_id: '11',
          branch: 'main',
          authorize_automatic_sync: true,
        })
      ).status,
      404,
    );
    deniedCloneTokens.delete('alice-pat');
    const created = await request('POST', '/api/v1/repositories', alice, {
      codeup_repository_id: '11',
      branch: 'main',
      authorize_automatic_sync: true,
    });
    assert.equal(created.status, 202);
    assert.equal(kickCount, 1);
    const repo = created.body.repository.repo_id as string;
    const job = created.body.job_id as string;
    assert.equal(created.body.repository.codeup_id, '11');
    assert.equal(created.body.repository.sync_interval_minutes, null);
    assert.equal(created.body.repository.effective_sync_interval_minutes, 30);
    assert.equal(created.body.repository.webhook_path, `/api/v1/hooks/codeup/${repo}`);
    assert.equal(created.body.webhook_path, created.body.repository.webhook_path);
    assert.equal((await request('GET', `/api/v1/jobs/${job}`, alice)).status, 200);
    assert.equal((await request('GET', `/api/v1/jobs/${job}`, bob)).status, 404);
    const history = await request('GET', `/api/v1/repositories/${repo}/jobs`, alice);
    assert.equal(history.status, 200);
    assert.deepEqual(
      history.body.jobs.map((entry: { id: string }) => entry.id),
      [job],
    );
    assert.equal((await request('GET', `/api/v1/repositories/${repo}/jobs`, bob)).status, 404);
    const me = await request('GET', '/api/v1/me', alice);
    assert.equal(me.status, 200);
    assert.equal(me.body.is_admin, true);
    assert.equal(me.body.can_write, true);
    assert.equal(me.body.key_repos, null);
    assert.equal(me.body.key_prefix, aliceKey.body.prefix);
    assert.equal(typeof me.body.key_expires_at, 'number');
    const bobMe = await request('GET', '/api/v1/me', bob);
    assert.equal(bobMe.body.is_admin, false);
    assert.equal(bobMe.body.can_write, false);
    // The bundled console is same-origin: its Origin header must pass without being listed.
    assert.equal(
      (await request('GET', '/api/v1/me', alice, undefined, { origin: `http://127.0.0.1:${address.port}` })).status,
      200,
    );
    assert.equal((await request('GET', '/api/v1/me', alice, undefined, { origin: 'http://127.0.0.1:1' })).status, 403);
    assert.equal((await request('GET', `/api/v1/repositories/${repo}`, bob)).status, 404);
    assert.equal((await request('GET', '/api/v1/repositories', bob)).body.repositories.length, 0);
    const duplicate = await request('POST', '/api/v1/repositories', alice, {
      codeup_repository_id: '11',
      branch: 'main',
      sync_interval_minutes: 5,
      authorize_automatic_sync: true,
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.repository.repo_id, repo);
    assert.equal(duplicate.body.repository.sync_interval_minutes, null);

    // A bootstrap read key has null scope and must not inherit every repository.
    allowedByToken['bob-pat'].add('11');
    assert.equal((await request('GET', `/api/v1/repositories/${repo}`, bob)).status, 404);
    const bobScoped = createAccessKey();
    await app.store.createKey({
      ...bobScoped,
      owner: 'bob',
      scope: 'read',
      repos: [repo],
      expires_at: null,
      revoked: 0,
    });
    assert.equal((await request('GET', performancePath, bobScoped.token)).status, 403);
    deniedCloneTokens.add('bob-pat');
    offline = true;
    const beforeReads = probeCalls.length;
    assert.equal((await request('GET', `/api/v1/repositories/${repo}`, bobScoped.token)).status, 200);
    assert.equal(probeCalls.length, beforeReads);
    offline = false;
    deniedCloneTokens.delete('bob-pat');
    await app.store.updateRepository(repo, { status: 'disabled' });
    assert.equal((await request('GET', `/api/v1/repositories/${repo}`, bobScoped.token)).status, 404);
    // Disabled repositories disappear from the user list but stay visible to administrators.
    assert.equal((await request('GET', '/api/v1/repositories', alice)).body.repositories.length, 0);
    const adminRepos = await request('GET', '/api/v1/admin/repositories', alice);
    assert.equal(adminRepos.status, 200);
    assert.deepEqual(
      adminRepos.body.repositories.map((entry: Record<string, unknown>) => [entry.repo_id, entry.status, entry.owner]),
      [[repo, 'disabled', 'alice']],
    );
    assert.equal((await request('GET', '/api/v1/admin/repositories', bob)).status, 403);
    await app.store.updateRepository(repo, { status: 'pending' });
    assert.equal((await request('POST', `/api/v1/repositories/${repo}/sync`, bobScoped.token)).status, 403);
    await app.store.updateRepository(repo, {
      path: '/private/index',
      commit: 'a'.repeat(40),
      indexed_at: Date.now(),
      status: 'ready',
    });

    const mcp = (token: string, name: string, args: Record<string, unknown>) =>
      request(
        'POST',
        '/mcp',
        token,
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
        { accept: 'application/json, text/event-stream' },
      );
    const unscoped = await mcp(bob, 'codegraph_explore', { repo_id: repo, query: 'unscoped' });
    assert.doesNotMatch(JSON.stringify(unscoped.body), /matching code/);
    const adminUnscoped = await mcp(alice, 'codegraph_explore', { repo_id: repo, query: 'admin-unscoped' });
    assert.doesNotMatch(JSON.stringify(adminUnscoped.body), /matching code/);
    const probesBeforeQuery = probeCalls.length;
    offline = true;
    deniedCloneTokens.add('bob-pat');
    const found = await mcp(bobScoped.token, 'codegraph_explore', { repo_id: repo, query: 'order flow' });
    assert.equal(found.status, 200);
    assert.match(JSON.stringify(found.body), /matching code/);
    assert.ok(!JSON.stringify(found.body).includes('/private/index'));
    assert.equal(probeCalls.length, probesBeforeQuery);
    offline = false;
    deniedCloneTokens.delete('bob-pat');
    assert.deepEqual(graphCalls, [{ path: '/private/index', query: 'order flow' }]);
    duringExplore = async () => {
      await app.store.updateRepository(repo, { commit: 'b'.repeat(40) });
    };
    const changedDuringQuery = await mcp(bobScoped.token, 'codegraph_explore', { repo_id: repo, query: 'changed' });
    assert.doesNotMatch(JSON.stringify(changedDuringQuery.body), /matching code/);
    duringExplore = undefined;
    await app.store.updateRepository(repo, { commit: 'a'.repeat(40) });
    const injection = await mcp(bobScoped.token, 'codegraph_explore', {
      repo_id: repo,
      query: 'x',
      projectPath: '/other',
    });
    assert.match(JSON.stringify(injection.body), /Invalid arguments/);
    assert.equal(graphCalls.length, 2);
    allowedByToken['bob-pat'].delete('11');
    const stillAllowed = await mcp(bobScoped.token, 'codegraph_explore', { repo_id: repo, query: 'x' });
    assert.match(JSON.stringify(stillAllowed.body), /matching code/);
    offline = true;
    assert.equal((await request('GET', `/api/v1/repositories/${repo}`, alice)).status, 200);
    offline = false;

    for (const invalid of [0, 1441, 1.5, '5']) {
      const response = await request('POST', '/api/v1/repositories', alice, {
        codeup_repository_id: '22',
        sync_interval_minutes: invalid,
        authorize_automatic_sync: true,
      });
      assert.equal(response.status, 400);
    }
    const second = await request('POST', '/api/v1/repositories', alice, {
      codeup_repository_id: '22',
      sync_interval_minutes: 5,
      authorize_automatic_sync: true,
    });
    assert.equal(second.status, 202);
    const customSchedule = await request('GET', `/api/v1/repositories/${second.body.repository.repo_id}`, alice);
    assert.equal(customSchedule.status, 200);
    assert.equal(customSchedule.body.sync_interval_minutes, 5);
    assert.equal(customSchedule.body.effective_sync_interval_minutes, 5);
    const noScope = await request('POST', '/api/v1/api-keys', alice, { scope: 'read', repos: null, expires_in: 3600 });
    assert.equal(noScope.status, 400);
    assert.equal(noScope.body.error, 'REPOSITORY_SCOPE_REQUIRED');
    const omittedScope = await request('POST', '/api/v1/api-keys', alice, { scope: 'read', expires_in: 3600 });
    assert.equal(omittedScope.status, 400);
    const scoped = await request('POST', '/api/v1/api-keys', alice, { scope: 'read', repos: [repo], expires_in: 3600 });
    assert.equal(scoped.status, 201);
    assert.equal(
      (await request('GET', `/api/v1/repositories/${second.body.repository.repo_id}`, scoped.body.token)).status,
      404,
    );
    duringExplore = async () => {
      await app.store.revokeKey(hashAccessKey(scoped.body.token));
    };
    const revokedDuringQuery = await mcp(scoped.body.token, 'codegraph_explore', { repo_id: repo, query: 'revoked' });
    assert.doesNotMatch(JSON.stringify(revokedDuringQuery.body), /matching code/);
    duringExplore = undefined;
    assert.equal((await request('GET', `/api/v1/repositories/${repo}`, scoped.body.token)).status, 401);

    const payload = { object_kind: 'push', project_id: 11, ref: 'refs/heads/main', after: 'b'.repeat(40) };
    const hookPath = created.body.webhook_path;
    assert.equal(
      (
        await request('POST', hookPath, undefined, payload, {
          'x-codeup-token': 'incorrect',
          'codeup-event': 'Push Hook',
        })
      ).status,
      404,
    );
    const before = (await app.store.listJobs(repo)).length;
    assert.equal(
      (
        await request(
          'POST',
          hookPath,
          undefined,
          { ...payload, ref: 'refs/heads/feature' },
          { 'x-codeup-token': created.body.webhook_token, 'codeup-event': 'Push Hook' },
        )
      ).status,
      202,
    );
    assert.equal((await app.store.listJobs(repo)).length, before);
    assert.equal(
      (
        await request('POST', hookPath, undefined, payload, {
          'x-codeup-token': created.body.webhook_token,
          'codeup-event': 'Push Hook',
        })
      ).status,
      202,
    );
    assert.equal((await app.store.listJobs(repo)).length, before + 1);

    const restrictedWrite = await request('POST', '/api/v1/api-keys', alice, {
      scope: 'write',
      repos: [repo],
      expires_in: 3600,
    });
    assert.equal(restrictedWrite.status, 201);
    const restrictedToken = restrictedWrite.body.token as string;
    assert.equal((await request('GET', '/api/v1/codeup/repositories', restrictedToken)).status, 403);
    const restrictedKeys = await request('GET', '/api/v1/api-keys', restrictedToken);
    assert.equal(restrictedKeys.status, 200);
    assert.deepEqual(
      restrictedKeys.body.keys.map((entry: { prefix: string }) => entry.prefix),
      [restrictedWrite.body.prefix],
    );
    assert.equal((await request('DELETE', `/api/v1/api-keys/${aliceKey.body.prefix}`, restrictedToken)).status, 404);
    assert.equal(
      (await request('POST', '/api/v1/api-keys', restrictedToken, { scope: 'write', repos: null, expires_in: 60 }))
        .status,
      403,
    );
    assert.equal(
      (
        await request('POST', '/api/v1/api-keys', restrictedToken, {
          scope: 'read',
          repos: [second.body.repository.repo_id],
          expires_in: 60,
        })
      ).status,
      403,
    );
    assert.equal(
      (await request('POST', '/api/v1/api-keys', restrictedToken, { scope: 'read', repos: [repo], expires_in: 7200 }))
        .status,
      403,
    );

    // PAT revocation blocks live Cloud DevOps operations, not existing CodeHarbor keys.
    revokedTokens.add('alice-pat');
    assert.equal((await request('GET', '/api/v1/codeup/repositories', alice)).status, 401);
    assert.equal(
      (
        await request('POST', '/api/v1/repositories', alice, {
          codeup_repository_id: '33',
          authorize_automatic_sync: true,
        })
      ).status,
      401,
    );
    assert.equal((await request('GET', `/api/v1/repositories/${repo}`, alice)).status, 200);
    assert.equal((await request('GET', '/api/v1/me', alice)).status, 200);
    assert.equal((await request('GET', '/api/v1/me', restrictedToken)).status, 200);
    assert.match(
      JSON.stringify((await mcp(restrictedToken, 'codegraph_explore', { repo_id: repo, query: 'pat-expired' })).body),
      /matching code/,
    );
    revokedTokens.delete('alice-pat');
    const userBeforeRebind = (await app.store.getUser('alice'))!;
    const repositoriesBeforeRebind = await app.store.listRepositories();
    const samePat = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'alice-pat' });
    assert.equal(samePat.status, 200);
    assert.deepEqual(await app.store.getUser('alice'), userBeforeRebind);
    assert.deepEqual(await app.store.listRepositories(), repositoriesBeforeRebind);
    const samePatKey = await request('POST', '/api/v1/auth/bootstrap/keys', samePat.body.bootstrap_token, {
      scope: 'read',
    });
    assert.equal(samePatKey.status, 201);
    assert.equal((await request('GET', '/api/v1/me', alice)).status, 200);

    // A genuinely different PAT still invalidates each repository's prior authorization.
    const previousVersion = userBeforeRebind.credential_version;
    const originalSyncVersion = (await app.store.getRepository(repo))!.sync_credential_version;
    const rebound = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'alice-pat-2' });
    assert.equal(rebound.status, 200);
    assert.equal((await app.store.getUser('alice'))!.credential_version, previousVersion + 1);
    assert.equal((await app.store.getRepository(repo))!.sync_credential_version, originalSyncVersion);
    assert.equal((await app.store.getRepository(repo))!.status, 'credential_required');
    assert.equal((await app.store.getRepository(second.body.repository.repo_id))!.status, 'credential_required');
    assert.equal((await request('GET', '/api/v1/me', alice)).status, 200);
    const fresh = await request('POST', '/api/v1/auth/bootstrap/keys', rebound.body.bootstrap_token, {
      scope: 'write',
    });
    assert.equal(fresh.status, 201);

    // Having write capability and Codeup access does not make Bob the repository owner.
    config.writeUsers.push('bob');
    allowedByToken['bob-pat'].add('11');
    const bobRebind = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'bob-pat' });
    const bobWrite = await request('POST', '/api/v1/auth/bootstrap/keys', bobRebind.body.bootstrap_token, {
      scope: 'write',
    });
    assert.equal(bobWrite.status, 201);
    const syncCredentialPath = `/api/v1/repositories/${repo}/sync-credential`;
    assert.equal(
      (await request('PUT', syncCredentialPath, bobWrite.body.token, { authorize_automatic_sync: true })).status,
      404,
    );
    assert.equal((await request('PUT', syncCredentialPath, fresh.body.token, {})).status, 400);
    assert.equal(
      (await request('PUT', syncCredentialPath, fresh.body.token, { authorize_automatic_sync: false })).status,
      400,
    );
    assert.equal((await app.store.getRepository(repo))!.sync_credential_version, originalSyncVersion);
    const credentialRefresh = await request('PUT', syncCredentialPath, fresh.body.token, {
      authorize_automatic_sync: true,
    });
    assert.equal(credentialRefresh.status, 202);
    assert.equal((await app.store.getRepository(repo))!.sync_credential_version, previousVersion + 1);
    assert.equal((await app.store.getJob(credentialRefresh.body.job_id))?.reason, 'credential_changed');
    assert.equal((await app.store.getJob(credentialRefresh.body.job_id))?.status, 'queued');
    assert.equal((await app.store.getRepository(second.body.repository.repo_id))!.status, 'credential_required');

    // A delayed rejection for an old credential cannot revoke a newer binding's keys.
    let releaseOld!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    delayOldCredential = async () => {
      notifyStarted();
      await released;
    };
    const delayedRequest = request('GET', '/api/v1/codeup/repositories', fresh.body.token);
    await started;
    const reboundAgain = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'alice-pat' });
    const newer = await request('POST', '/api/v1/auth/bootstrap/keys', reboundAgain.body.bootstrap_token, {
      scope: 'write',
    });
    assert.equal(newer.status, 201);
    releaseOld();
    assert.equal((await delayedRequest).status, 401);
    delayOldCredential = undefined;
    assert.equal((await request('GET', '/api/v1/me', newer.body.token)).status, 200);

    // A session accepted before reading a slow body must still be consumed only once.
    const raceBind = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'bob-pat' });
    const firstPending = partialRequest(
      'POST',
      '/api/v1/auth/bootstrap/keys',
      raceBind.body.bootstrap_token,
      '{"scope":"read"',
    );
    const secondPending = partialRequest(
      'POST',
      '/api/v1/auth/bootstrap/keys',
      raceBind.body.bootstrap_token,
      '{"scope":"read"',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const bootstrapResults = await Promise.all([firstPending.finish('}'), secondPending.finish('}')]);
    assert.deepEqual(bootstrapResults.map((result) => result.status).sort(), [201, 401]);

    // Authorization must still hold after waiting for a slow request body.
    const slowSync = partialRequest('PUT', syncCredentialPath, newer.body.token, '{"authorize_automatic_sync":');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const repoVersionBefore = (await app.store.getRepository(repo))!.sync_credential_version;
    const reboundDuringRequest = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'alice-pat-2' });
    assert.equal(reboundDuringRequest.status, 200);
    assert.equal((await slowSync.finish('true}')).status, 401);
    assert.equal((await app.store.getRepository(repo))!.sync_credential_version, repoVersionBefore);
    const latestKey = await request('POST', '/api/v1/auth/bootstrap/keys', reboundDuringRequest.body.bootstrap_token, {
      scope: 'write',
      expires_in: 7200,
    });
    assert.equal(latestKey.status, 201);
    const slowParent = await request('POST', '/api/v1/api-keys', latestKey.body.token, {
      scope: 'write',
      repos: [repo],
      expires_in: 3600,
    });
    assert.equal(slowParent.status, 201);
    const slowKey = partialRequest('POST', '/api/v1/api-keys', slowParent.body.token, '{"scope":"read","repos":[]');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      (await request('DELETE', `/api/v1/api-keys/${slowParent.body.prefix}`, latestKey.body.token)).status,
      200,
    );
    assert.equal((await slowKey.finish(',"expires_in":60}')).status, 401);
    assert.ok(audit.some((event) => event.authentication === 'yunxiao_pat' && event.subject === 'alice'));
    assert.ok(audit.some((event) => event.authentication === 'bootstrap' && event.subject === 'alice'));
    assert.ok(
      audit.some(
        (event) =>
          event.authentication === 'api_key' && event.subject === 'alice' && event.key_prefix === aliceKey.body.prefix,
      ),
    );
    assert.ok(audit.some((event) => event.authentication === 'webhook' && event.repo_id === repo));
    assert.ok(audit.some((event) => event.route === '/api/v1/repositories/:id' && event.repo_id === repo));
    assert.ok(
      audit.some(
        (event) => event.tool === 'codegraph_explore' && event.tool_outcome === 'success' && event.repo_id === repo,
      ),
    );
    assert.ok(audit.some((event) => event.tool === 'codegraph_explore' && event.tool_outcome === 'error'));
    const logged = JSON.stringify(audit);
    for (const secret of [
      'alice-pat',
      'wrong-secret',
      alice,
      created.body.webhook_token,
      'order flow',
      'matching code',
    ]) {
      assert.ok(!logged.includes(secret));
    }
  } finally {
    await app.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keys can have no expiry without bypassing parent lifetimes or revocation', async () => {
  const db = await openTestStore();
  const allowedHosts: string[] = [];
  const app = createApp(
    {
      dataDir: '/unused',
      credentialKey: randomBytes(32),
      codeupEndpoint: 'https://devops.example',
      allowedGitHosts: ['git.example'],
      allowedHosts,
      writeUsers: ['expiry-user'],
    },
    {
      store: db.store,
      codeup: {
        async getUser() {
          return { id: 'expiry-user', username: 'expiry-user', name: 'Expiry User' };
        },
        async listRepositories() {
          return { repositories: [], nextPage: null };
        },
      } as never,
      graph: { async probe() {}, async close() {} } as never,
      worker: { async stop() {} } as never,
    },
  );
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    allowedHosts.push(`127.0.0.1:${address.port}`);
    const base = `http://127.0.0.1:${address.port}`;
    async function request(method: string, path: string, token?: string, body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    }
    async function bootstrap() {
      const bound = await request('POST', '/api/v1/auth/yunxiao/bind', undefined, { pat: 'expiry-test-pat' });
      assert.equal(bound.status, 200);
      assert.equal(bound.body.expires_in, 300, 'bootstrap sessions must still expire');
      return bound.body.bootstrap_token as string;
    }

    const bootstrapToken = await bootstrap();
    for (const invalid of [0, -1, 90 * 86_400 + 1, 'never']) {
      assert.equal(
        (await request('POST', '/api/v1/auth/bootstrap/keys', bootstrapToken, { scope: 'write', expires_in: invalid }))
          .status,
        400,
      );
    }
    const unlimited = await request('POST', '/api/v1/auth/bootstrap/keys', bootstrapToken, {
      scope: 'write',
      expires_in: null,
    });
    assert.equal(unlimited.status, 201);
    assert.equal(unlimited.body.expires_in, null);
    const root = unlimited.body.token as string;
    assert.equal((await db.store.getKey(hashAccessKey(root)))?.expires_at, null);
    const me = await request('GET', '/api/v1/me', root);
    assert.equal(me.status, 200);
    assert.equal(me.body.key_expires_at, null);
    assert.equal(me.body.is_admin, true);

    const child = await request('POST', '/api/v1/api-keys', root, {
      scope: 'read',
      repos: ['repo-1'],
      expires_in: null,
    });
    assert.equal(child.status, 201);
    assert.equal(child.body.expires_at, null);
    assert.equal((await request('GET', '/api/v1/me', child.body.token)).status, 200);
    assert.equal((await request('DELETE', `/api/v1/api-keys/${child.body.prefix}`, root)).status, 200);
    assert.equal((await request('GET', '/api/v1/me', child.body.token)).status, 401);

    const finite = await request('POST', '/api/v1/api-keys', root, {
      scope: 'write',
      repos: ['repo-1'],
      expires_in: 3600,
    });
    assert.equal(finite.status, 201);
    assert.ok(finite.body.expires_at > Date.now());
    for (const expiry of [null, 7200]) {
      assert.equal(
        (
          await request('POST', '/api/v1/api-keys', finite.body.token, {
            scope: 'read',
            repos: ['repo-1'],
            expires_in: expiry,
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await request('POST', '/api/v1/api-keys', finite.body.token, {
          scope: 'read',
          repos: ['repo-1'],
          expires_in: 60,
        })
      ).status,
      201,
    );
    const defaultStart = Date.now();
    const defaultChild = await request('POST', '/api/v1/api-keys', root, { scope: 'write', repos: null });
    assert.equal(defaultChild.status, 201);
    assert.ok(defaultChild.body.expires_at >= defaultStart + 30 * 86_400_000);
    assert.ok(defaultChild.body.expires_at <= Date.now() + 30 * 86_400_000);

    const readKey = await request('POST', '/api/v1/auth/bootstrap/keys', await bootstrap(), {
      scope: 'read',
      expires_in: null,
    });
    assert.equal(readKey.status, 201);
    assert.equal(readKey.body.expires_in, null);
    assert.equal((await request('GET', '/api/v1/me', readKey.body.token)).body.key_expires_at, null);
    assert.equal(
      (await request('POST', '/api/v1/api-keys', readKey.body.token, { scope: 'write', expires_in: null })).status,
      403,
    );
    const defaultKey = await request('POST', '/api/v1/auth/bootstrap/keys', await bootstrap(), { scope: 'read' });
    assert.equal(defaultKey.status, 201);
    assert.equal(defaultKey.body.expires_in, 30 * 86_400);
  } finally {
    await app.close();
    await db.close();
  }
});

test('metrics use a separate credential and contain only bounded aggregate labels', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codeharbor-metrics-'));
  const allowedHosts: string[] = [];
  const metricsToken = 'test-metrics-token-000000000000000000';
  const db = await openTestStore();
  const app = createApp(
    {
      dataDir: dir,
      credentialKey: randomBytes(32),
      codeupEndpoint: 'https://devops.example',
      allowedGitHosts: ['git.example'],
      allowedHosts,
      writeUsers: [],
      codegraphBin: 'codegraph',
      metricsToken,
    },
    { store: db.store, graph: { async probe() {}, async close() {} } as never, worker: { async stop() {} } as never },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  allowedHosts.push(`127.0.0.1:${address.port}`);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/metrics`)).status, 401);
    assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer wrong-token' } })).status, 401);
    assert.equal(
      (
        await fetch(`${base}/api/v1/admin/system/performance`, {
          headers: { authorization: `Bearer ${metricsToken}` },
        })
      ).status,
      401,
    );
    assert.equal((await fetch(`${base}/health/live?secret=not-in-metrics`)).status, 200);
    const result = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` } });
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type')!, /^text\/plain; version=0\.0\.4/);
    const content = await result.text();
    assert.match(content, /codeharbor_http_requests_total\{method="GET",status="200"\}/);
    assert.match(content, /codeharbor_http_request_duration_seconds_bucket/);
    assert.match(content, /^codeharbor_index_queue_queued_jobs 0$/m);
    assert.match(content, /^codeharbor_index_jobs_failure_ratio_24h NaN$/m);
    assert.match(content, /^codeharbor_index_build_samples_24h 0$/m);
    assert.match(content, /^# TYPE codeharbor_process_resident_memory_bytes gauge$/m);
    assert.match(content, /^# TYPE codeharbor_process_cpu_seconds_total counter$/m);
    assert.match(content, /^codeharbor_process_resident_memory_bytes [1-9]\d*$/m);
    assert.match(content, /^codeharbor_system_memory_total_bytes [1-9]\d*$/m);
    assert.match(content, /^codeharbor_data_filesystem_available_bytes \d+$/m);
    assert.ok(!content.includes(dir));
    assert.ok(!content.includes('not-in-metrics') && !content.includes(metricsToken));
    assert.ok(!content.includes('route=') && !content.includes('user=') && !content.includes('repo='));
    app.store.jobMetrics = async () => {
      throw new Error('database secret');
    };
    const unavailable = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` } });
    assert.equal(unavailable.status, 503);
    const errorBody = await unavailable.text();
    assert.match(errorBody, /METRICS_UNAVAILABLE/);
    assert.ok(!errorBody.includes('database secret'));
  } finally {
    await app.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('console build is served under /ui with client-side routing fallback and strict headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codeharbor-ui-'));
  const uiDir = join(dir, 'web-dist');
  mkdirSync(join(uiDir, 'assets'), { recursive: true });
  writeFileSync(
    join(uiDir, 'index.html'),
    '<!doctype html><title>CodeHarbor Console</title><script src="/ui/assets/app-abc.js"></script>',
  );
  writeFileSync(join(uiDir, 'assets', 'app-abc.js'), 'console.log("ui")');
  writeFileSync(join(dir, 'outside.txt'), 'secret');
  const allowedHosts: string[] = [];
  const db = await openTestStore();
  const app = createApp(
    {
      dataDir: dir,
      credentialKey: randomBytes(32),
      codeupEndpoint: 'https://devops.example',
      allowedGitHosts: ['git.example'],
      allowedHosts,
      writeUsers: [],
      codegraphBin: 'codegraph',
      uiDir,
      uiMcpUrl: 'https://mcp.internal.example/mcp',
    },
    { store: db.store, graph: { async probe() {}, async close() {} } as never, worker: { async stop() {} } as never },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  allowedHosts.push(`127.0.0.1:${address.port}`);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of [
      '/ui',
      '/ui/',
      '/ui/repositories/some-id',
      '/ui/admin/audit?since=1',
      '/ui/admin/performance',
    ]) {
      const page = await fetch(`${base}${path}`);
      assert.equal(page.status, 200, path);
      assert.match(page.headers.get('content-type') ?? '', /text\/html/);
      assert.match(await page.text(), /CodeHarbor Console/);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
      assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
      assert.equal(page.headers.get('x-frame-options'), 'DENY');
    }
    const asset = await fetch(`${base}/ui/assets/app-abc.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.match(asset.headers.get('content-type') ?? '', /javascript/);
    // Nothing outside the build directory and nothing from the API surface is reachable through /ui.
    for (const path of ['/ui/../outside.txt', '/ui/..%2foutside.txt', '/ui/%2e%2e/outside.txt']) {
      const traversal = await fetch(`${base}${path}`);
      assert.doesNotMatch(await traversal.text(), /secret/, path);
    }
    assert.equal((await fetch(`${base}/api/v1/console`)).status, 401);
    const consoleKey = createAccessKey();
    await db.store.createUser({ id: 'console', username: 'console', credential: 'unused', credential_version: 1 });
    await db.store.createKey({
      ...consoleKey,
      owner: 'console',
      scope: 'read',
      repos: null,
      expires_at: null,
      revoked: 0,
    });
    const consoleConfig = await fetch(`${base}/api/v1/console`, {
      headers: { authorization: `Bearer ${consoleKey.token}` },
    });
    assert.equal(consoleConfig.status, 200);
    assert.equal((await consoleConfig.json()).default_sync_interval_minutes, 360);
    assert.equal((await fetch(`${base}/health/live`)).headers.get('content-security-policy'), null);
    assert.equal((await fetch(`${base}/uix`)).status, 404);
    assert.equal((await fetch(`${base}/ui/`, { headers: { origin: 'https://untrusted.example' } })).status, 403);
  } finally {
    await app.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
