import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CredentialCipher } from '../src/auth.js';
import { CodeupClient } from '../src/codeup.js';
import { createApp } from '../src/server.js';
import { openTestStore } from './helpers/postgres.js';

const ORIGIN = 'https://console.example.test';
const SECRET = 'fixture-feishu-app-secret';
const TENANT = 'tenant-codeharbor';
const ADMIN = 'ou_codeharbor_admin';
const MEMBER = 'ou_codeharbor_member';

function cookie(response: Response, name: string): string {
  const found = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  assert.ok(found, `expected cookie ${name}`);
  assert.match(found, /Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  return found.split(';')[0];
}

test('Feishu verifies the browser, authorization code and tenant before creating a durable session', async () => {
  const { store, close } = await openTestStore();
  const dataDir = await mkdtemp(join(tmpdir(), 'codeharbor-feishu-test-'));
  const credentialKey = randomBytes(32);
  const cipher = new CredentialCipher(credentialKey);
  const allowedHosts: string[] = [];
  const profiles = new Map([
    ['admin', { open_id: ADMIN, tenant_key: TENANT, name: '管理员' }],
    ['member', { open_id: MEMBER, tenant_key: TENANT, name: '成员' }],
    ['external', { open_id: ADMIN, tenant_key: 'another-tenant', name: '外部用户' }],
  ]);
  let pendingChallenge: string | null = null;
  let providerCalls = 0;
  const feishuFetch: typeof fetch = async (input, options) => {
    providerCalls++;
    if (String(input) === 'https://accounts.feishu.cn/oauth/v3/token') {
      assert.equal(options?.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.ok(options.body instanceof URLSearchParams);
      assert.equal(options.body.get('client_secret'), SECRET);
      assert.equal(options.body.get('redirect_uri'), `${ORIGIN}/api/v1/auth/feishu/callback`);
      const verifier = options.body.get('code_verifier');
      assert.ok(verifier);
      assert.equal(createHash('sha256').update(verifier).digest('base64url'), pendingChallenge);
      return Response.json({ code: 0, access_token: options.body.get('code') });
    }
    assert.equal(String(input), 'https://open.feishu.cn/open-apis/authen/v1/user_info');
    const bearer = new Headers(options?.headers).get('authorization')?.slice('Bearer '.length);
    return Response.json({ code: 0, data: profiles.get(bearer ?? '') });
  };
  const codeup = new CodeupClient({
    endpoint: 'https://codeup.example.test',
    fetch: async (input, options) => {
      const pat = new Headers(options?.headers).get('x-yunxiao-token');
      if (!pat || !['first-pat', 'next-pat', 'other-pat'].includes(pat)) return Response.json({}, { status: 401 });
      const id = pat === 'other-pat' ? 'other-codeup-account' : 'legacy-codeup-account';
      return String(input).includes('/platform/user')
        ? Response.json({ id, username: id, name: '云效用户' })
        : Response.json([]);
    },
  });
  const feishu = {
    origin: ORIGIN,
    appId: 'cli_codeharbor_test',
    appSecret: SECRET,
    tenantKey: TENANT,
    superAdminOpenId: ADMIN,
  };
  const app = createApp(
    {
      dataDir,
      credentialKey,
      codeupEndpoint: 'https://codeup.example.test',
      codegraphBin: process.execPath,
      allowedHosts,
      allowedGitHosts: ['codeup.example.test'],
      writeUsers: [],
      feishu,
    },
    {
      store,
      codeup,
      feishuFetch,
      graph: {
        async withQuery() {
          throw new Error('Unexpected graph query');
        },
        async withExclusive() {
          throw new Error('Unexpected graph operation');
        },
        async probe() {},
        async close() {},
      },
    },
  );
  try {
    await store.createUser({
      id: 'legacy-codeup-account',
      username: 'legacy-codeup-account',
      credential: cipher.encrypt('first-pat', 'legacy-codeup-account'),
      credential_version: 1,
    });
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    allowedHosts.push(new URL(base).host);
    const request = (path: string, options?: RequestInit) =>
      fetch(new URL(path, base), { ...options, redirect: 'manual' });
    const start = async () => {
      const response = await request('/api/v1/auth/feishu/start');
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const location = response.headers.get('location');
      assert.ok(location);
      const authorization = new URL(location);
      assert.equal(authorization.hostname, 'accounts.feishu.cn');
      assert.equal(authorization.searchParams.get('target_tenant'), TENANT);
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(authorization.searchParams.has('client_secret'), false);
      pendingChallenge = authorization.searchParams.get('code_challenge');
      return {
        state: authorization.searchParams.get('state'),
        cookie: cookie(response, '__Host-codeharbor_oauth'),
      };
    };
    const callback = (state: string | null, profile: string, flowCookie?: string) =>
      request(`/api/v1/auth/feishu/callback?state=${state}&code=${profile}`, {
        headers: flowCookie ? { cookie: flowCookie } : {},
      });
    const bind = (pat: string, sessionCookie?: string, origin?: string) =>
      request('/api/v1/auth/yunxiao/bind', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(sessionCookie ? { cookie: sessionCookie } : {}),
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ pat }),
      });

    const performancePath = '/api/v1/admin/system/performance';
    assert.equal((await request(performancePath)).status, 401);
    assert.equal((await bind('first-pat')).status, 401);
    assert.equal((await request('/api/v1/auth/bootstrap/keys', { method: 'POST' })).status, 404);
    const unauthorizedTenant = await start();
    assert.equal(
      (await callback(unauthorizedTenant.state, 'external', unauthorizedTenant.cookie)).headers.get('location'),
      '/ui/login?error=login_failed',
    );
    assert.deepEqual(await store.listAccounts(), []);

    const adminFlow = await start();
    const beforeAdminExchange = providerCalls;
    assert.equal((await callback(adminFlow.state, 'admin')).headers.get('location'), '/ui/login?error=login_failed');
    assert.equal(providerCalls, beforeAdminExchange);
    const loggedIn = await callback(adminFlow.state, 'admin', adminFlow.cookie);
    assert.equal(loggedIn.headers.get('location'), '/ui/repositories');
    assert.equal(loggedIn.headers.get('referrer-policy'), 'no-referrer');
    const adminCookie = cookie(loggedIn, '__Host-codeharbor_session');
    assert.equal(cookie(loggedIn, '__Host-codeharbor_oauth'), '__Host-codeharbor_oauth=');
    const performance = await request(performancePath, { headers: { cookie: adminCookie } });
    assert.equal(performance.status, 200);
    assert.equal((await performance.json()).health.status, 'ok');
    assert.equal(
      (await request(performancePath, { headers: { cookie: adminCookie, authorization: 'Bearer fixture' } })).status,
      401,
    );

    assert.equal(
      (await callback(adminFlow.state, 'admin', adminFlow.cookie)).headers.get('location'),
      '/ui/login?error=login_failed',
    );
    assert.equal(providerCalls, beforeAdminExchange + 2);
    const [admin] = await store.listAccounts();
    assert.equal(admin.role, 'super_admin');
    assert.equal(admin.codeup_user_id, null);
    assert.equal((await bind('first-pat', adminCookie)).status, 403);
    assert.equal((await bind('first-pat', adminCookie, ORIGIN)).status, 200);
    const linked = await store.getAccountByCodeupId('legacy-codeup-account');
    assert.equal(linked?.id, admin.id);
    assert.equal((await store.getUser('legacy-codeup-account'))?.credential_version, 1);
    assert.equal((await bind('next-pat', adminCookie, ORIGIN)).status, 200);
    const rotated = await store.getUser('legacy-codeup-account');
    assert.equal(rotated?.credential_version, 2);
    assert.ok(rotated);
    assert.equal(cipher.decrypt(rotated.credential, rotated.id), 'next-pat');
    assert.equal((await bind('other-pat', adminCookie, ORIGIN)).status, 409);

    feishu.superAdminOpenId = MEMBER;
    const memberFlow = await start();
    const memberCookie = cookie(
      await callback(memberFlow.state, 'member', memberFlow.cookie),
      '__Host-codeharbor_session',
    );
    assert.equal((await request(performancePath, { headers: { cookie: memberCookie } })).status, 403);
    assert.equal((await bind('next-pat', memberCookie, ORIGIN)).status, 409);
    const accounts = await store.listAccounts();
    const member = accounts.find((account) => account.feishu_open_id === MEMBER);
    assert.ok(member);
    assert.equal(member.role, 'member');
    await store.updateAccount(member.id, { status: 'disabled' });
    assert.equal((await bind('other-pat', memberCookie, ORIGIN)).status, 401);

    const loggedOut = await request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie: adminCookie, origin: ORIGIN },
    });
    assert.equal(loggedOut.status, 204);
    assert.equal(cookie(loggedOut, '__Host-codeharbor_session'), '__Host-codeharbor_session=');
    assert.equal((await bind('next-pat', adminCookie, ORIGIN)).status, 401);
  } finally {
    await app.close();
    await close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
