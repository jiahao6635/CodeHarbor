import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CredentialCipher, createAccessKey, hashAccessKey } from '../src/auth.js';
import { CodeupClient } from '../src/codeup.js';
import { createApp } from '../src/server.js';
import { openTestStore } from './helpers/postgres.js';

const origin = 'https://console.example.test';

test('Feishu governs metadata, scoped source access and legacy key approval independently', async () => {
  const db = await openTestStore();
  const dataDir = await mkdtemp(join(tmpdir(), 'codeharbor-authz-'));
  await writeFile(join(dataDir, 'index.html'), '<!doctype html><title>CodeHarbor Console</title>');
  const credentialKey = randomBytes(32);
  const cipher = new CredentialCipher(credentialKey);
  const { store } = db;
  const hosts = [new URL(origin).host];
  let cloneAllowed = false;
  let duringProbe: (() => Promise<void>) | undefined;
  const remote = {
    id: 42,
    name: 'visible',
    accessLevel: 30,
    defaultBranch: 'main',
    httpUrlToRepo: 'https://git.example.test/visible.git',
  };
  const codeup = new CodeupClient({
    endpoint: 'https://codeup.example.test',
    fetch: async (input, options) => {
      assert.equal(new Headers(options?.headers).get('x-yunxiao-token'), 'test-pat');
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith('/42')) return Response.json(remote);
      if (pathname.endsWith('/repositories')) return Response.json([remote, { ...remote, id: 43, accessLevel: null }]);
      return Response.json(null, { status: 404 });
    },
  });
  const app = createApp(
    {
      dataDir,
      uiDir: dataDir,
      credentialKey,
      codeupEndpoint: 'https://codeup.example.test',
      codegraphBin: process.execPath,
      allowedHosts: hosts,
      allowedOrigins: [origin],
      allowedGitHosts: ['git.example.test'],
      writeUsers: ['member-codeup'],
      feishu: {
        origin,
        appId: 'cli_test',
        appSecret: 'fixture-secret',
        tenantKey: 'tenant',
        superAdminOpenId: 'ou_admin',
      },
    },
    {
      store,
      codeup,
      probe: async (request) => {
        assert.equal(request.branch, 'release/qa');
        await duringProbe?.();
        return cloneAllowed;
      },
    },
  );
  const memberCredential = cipher.encrypt('test-pat', 'member-codeup');
  const current = createAccessKey();
  const pending = createAccessKey();
  const global = createAccessKey();
  const hook = 'fixture-hook-token';
  try {
    const session = async (id: string, role: 'member' | 'super_admin') => {
      const token = randomBytes(32).toString('base64url');
      await store.upsertFeishuAccount({ id, feishu_open_id: `ou_${id}`, feishu_tenant_key: 'tenant', name: id, role });
      await store.createBrowserSession({
        hash: createHash('sha256').update(token).digest('hex'),
        account_id: id,
        expires_at: Date.now() + 60_000,
      });
      return `__Host-codeharbor_session=${token}`;
    };
    const admin = await session('admin', 'super_admin');
    const member = await session('member', 'member');
    await store.createUser({
      id: 'member-codeup',
      username: 'git-user',
      credential: memberCredential,
      credential_version: 1,
    });
    await store.linkCodeupAccount('member', 'member-codeup');
    for (const [id, codeupId, status] of [
      ['visible', '42', 'ready'],
      ['hidden', '43', 'ready'],
      ['disabled', '44', 'disabled'],
    ]) {
      await store.createRepository({
        id,
        codeup_id: codeupId,
        name: id,
        branch: 'release/qa',
        owner: 'member-codeup',
        sync_owner: 'member-codeup',
        sync_credential_version: 1,
        hook_hash: hashAccessKey(hook),
        path: null,
        commit: null,
        indexed_at: null,
        status,
        error: null,
      });
    }
    await store.createKey({
      ...current,
      owner: 'member-codeup',
      scope: 'read',
      repos: ['visible'],
      expires_at: null,
      revoked: 0,
    });
    await store.createKey({
      ...pending,
      owner: 'member-codeup',
      scope: 'read',
      repos: ['visible'],
      expires_at: null,
      revoked: 0,
      legacy_pending: true,
    });
    await store.createKey({
      ...global,
      owner: 'member-codeup',
      scope: 'write',
      repos: null,
      expires_at: null,
      revoked: 0,
      legacy_pending: true,
    });
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    hosts.push(new URL(base).host);
    const request = (path: string, options?: RequestInit) => {
      const headers = new Headers(options?.headers);
      headers.set('origin', origin);
      return fetch(new URL(path, base), { ...options, headers });
    };
    assert.equal((await request('/api/v1/console')).status, 401);
    const consoleConfig = await request('/api/v1/console', { headers: { cookie: member } });
    assert.equal(consoleConfig.status, 200);
    assert.equal((await consoleConfig.json()).default_sync_interval_minutes, 360);
    const listed = async (cookie: string, path = '/api/v1/repositories') => {
      const response = await request(path, { headers: { cookie } });
      assert.equal(response.status, 200);
      return (await response.json()).repositories.map((repo: { repo_id: string }) => repo.repo_id).sort();
    };
    assert.deepEqual(await listed(admin), ['disabled', 'hidden', 'visible']);
    assert.deepEqual(await listed(admin, '/api/v1/repositories?for_key=1'), []);
    assert.deepEqual(await listed(member), ['visible']);
    const deleteBranch = (id: string, cloudId: number) =>
      request(`/api/v1/hooks/codeup/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-codeup-token': hook, 'codeup-event': 'Push Hook' },
        body: JSON.stringify({
          object_kind: 'push',
          project_id: cloudId,
          ref: 'refs/heads/release/qa',
          after: '0'.repeat(40),
        }),
      });
    assert.equal((await deleteBranch('disabled', 44)).status, 202);
    assert.equal((await store.getRepository('disabled'))?.status, 'disabled');
    assert.equal((await request('/api/v1/repositories/hidden', { headers: { cookie: member } })).status, 404);
    assert.equal((await request('/api/v1/admin/repositories', { headers: { cookie: member } })).status, 403);
    assert.equal(
      (
        await request('/api/v1/admin/repositories', {
          headers: { cookie: admin, authorization: `Bearer ${current.token}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (await request('/api/v1/api-keys', { method: 'POST', headers: { authorization: `Bearer ${current.token}` } }))
        .status,
      401,
    );
    const bearer = `Bearer ${current.token}`;
    assert.equal(await app.internalMcp.authenticate(bearer), true);
    assert.equal(await app.internalMcp.authenticate(`Bearer ${pending.token}`), false);
    assert.equal(await app.internalMcp.get(bearer, 'visible', new AbortController().signal), null);
    const issue = (repos: string[], scope = 'write') =>
      request('/api/v1/api-keys', {
        method: 'POST',
        headers: { cookie: member, 'content-type': 'application/json' },
        body: JSON.stringify({ repos, scope }),
      });
    assert.equal((await issue([])).status, 400);
    assert.equal((await issue(['visible'])).status, 404);
    assert.equal((await issue(['hidden'])).status, 404);
    const approve = (prefix: string) =>
      request(`/api/v1/admin/api-keys/${prefix}/approve`, { method: 'POST', headers: { cookie: admin } });
    assert.equal((await approve(pending.prefix)).status, 200);
    assert.equal((await approve(global.prefix)).status, 409);
    assert.equal(await app.internalMcp.authenticate(`Bearer ${pending.token}`), true);
    assert.equal(await app.internalMcp.authenticate(`Bearer ${global.token}`), false);
    const revoke = (cookie: string) =>
      request(`/api/v1/admin/api-keys/${pending.prefix}`, { method: 'DELETE', headers: { cookie } });
    assert.equal((await revoke(member)).status, 403);
    assert.equal((await revoke(admin)).status, 200);
    assert.equal(await app.internalMcp.authenticate(`Bearer ${pending.token}`), false);

    cloneAllowed = true;
    await store.updateUserCredential('member-codeup', 'git-user', memberCredential);
    assert.equal((await app.internalMcp.get(bearer, 'visible', new AbortController().signal))?.repo_id, 'visible');
    const issued = await issue(['visible']);
    assert.equal(issued.status, 201);
    const { token } = await issued.json();
    const writeKey = { authorization: `Bearer ${token}` };
    assert.equal((await (await request('/api/v1/me', { headers: writeKey })).json()).can_write, true);
    assert.equal(
      (await request('/api/v1/repositories/visible/sync', { method: 'POST', headers: writeKey })).status,
      202,
    );
    assert.equal(
      (await request('/api/v1/repositories/hidden/sync', { method: 'POST', headers: writeKey })).status,
      404,
    );
    assert.equal((await deleteBranch('visible', 42)).status, 202);
    assert.equal((await store.getRepository('visible'))?.status, 'branch_deleted');
    assert.equal(await app.internalMcp.get(bearer, 'visible', new AbortController().signal), null);
    assert.deepEqual(await listed(member), ['visible']);
    await store.updateRepository('visible', { status: 'ready' });
    await store.updateUserCredential('member-codeup', 'git-user', memberCredential);
    duringProbe = () => store.updateUserCredential('member-codeup', 'git-user', memberCredential);
    assert.equal(await app.internalMcp.get(bearer, 'visible', new AbortController().signal), null);

    const setStatus = (id: string, status: string) =>
      request(`/api/v1/admin/users/${id}`, {
        method: 'PATCH',
        headers: { cookie: admin, 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    assert.equal((await setStatus('admin', 'disabled')).status, 409);
    assert.equal((await setStatus('member', 'disabled')).status, 200);
    assert.equal((await setStatus('member', 'active')).status, 200);
    assert.equal(await app.internalMcp.authenticate(bearer), false);
    assert.equal((await request('/api/v1/me', { headers: { cookie: member } })).status, 401);
  } finally {
    await app.close();
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
