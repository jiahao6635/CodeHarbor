import assert from 'node:assert/strict';
import test from 'node:test';
import { hashAccessKey } from '../src/auth.js';
import { Authorization, type Principal } from '../src/authorization.js';
import type { AppContext } from '../src/http/context.js';
import { HttpError } from '../src/http/errors.js';
import { authenticateBearerRequest } from '../src/http/guards.js';
import { RateLimiter } from '../src/rate-limit.js';
import type { AuditEvent } from '../src/server.js';
import { createLegacyTestApp as createApp } from './helpers/legacy-auth.js';

const validToken = `ch_${'v'.repeat(43)}`;
const validKey: Principal = {
  hash: hashAccessKey(validToken),
  prefix: validToken.slice(0, 11),
  owner: 'alice',
  scope: 'read',
  repos: null,
  expires_at: null,
  revoked: 0,
};

test('releasing a bearer reservation only changes its original window once', () => {
  const limiter = new RateLimiter(2, 60_000);
  const client = '198.51.100.10';
  const oldRelease = limiter.reserve(client, 0);
  assert.ok(oldRelease);

  const release = limiter.reserve(client, 60_000);
  assert.ok(release);
  assert.equal(limiter.hit(client, 60_000), true);
  oldRelease();
  assert.equal(limiter.blocked(client, 60_000), true);

  release();
  release();
  assert.equal(limiter.hit(client, 60_000), true);
  assert.equal(limiter.blocked(client, 60_000), true);
});

test('MCP rate limits skip the durable audit sink for requests rejected before authentication', async (t) => {
  const audits: AuditEvent[] = [];
  const allowedHosts: string[] = [];
  const app = createApp(
    {
      dataDir: '.',
      credentialKey: Buffer.alloc(32),
      codeupEndpoint: 'https://devops.example',
      organizationId: 'org',
      allowedGitHosts: [],
      allowedHosts,
      writeUsers: [],
      codegraphBin: 'codegraph',
      authFailureRatePerMinute: 1,
      mcpKeyRatePerMinute: 1,
    },
    {
      store: { async getKey() {}, async close() {} } as never,
      worker: { async stop() {} } as never,
      audit: (event) => audits.push(event),
    },
  );
  t.after(() => app.close());
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  allowedHosts.push(new URL(base).host);
  const request = async (token: string) => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    await response.text();
    return response.status;
  };
  assert.equal(await request(validToken), 401);
  assert.equal(await request(validToken), 429);
  assert.equal(await request(`ch_${'w'.repeat(43)}`), 429);
  assert.deepEqual(
    audits.map((event) => event.status),
    [401],
  );
});

test('bearer admission bounds key lookups while preserving valid clients and source isolation', async () => {
  let keyLookups = 0;
  const authorization = new Authorization({
    store: {
      async getKey(hash: string) {
        keyLookups++;
        return hash === validKey.hash ? validKey : undefined;
      },
      async getUser(owner: string) {
        return owner === 'alice' ? { id: owner } : undefined;
      },
    } as never,
    codeup: {} as never,
    cipher: {} as never,
    writeUsers: [],
    accessTtlMs: 60_000,
    auditRetentionDays: 1,
  });
  const ctx = {
    authorization,
    limiters: { authFailure: new RateLimiter(2, 60_000) },
    clientIp: (request: { socket: { remoteAddress?: string } }) => request.socket.remoteAddress ?? 'unknown',
  } as unknown as AppContext;
  const request = (client: string, token: string) =>
    ({
      headers: { authorization: `Bearer ${token}` },
      socket: { remoteAddress: client },
      durableAudit: true,
    }) as unknown as Parameters<typeof authenticateBearerRequest>[1];

  for (let i = 0; i < 3; i++) {
    const key = await authenticateBearerRequest(ctx, request('198.51.100.10', validToken));
    assert.equal(key, validKey, 'successful sequential requests release their admission reservations');
  }
  assert.equal(keyLookups, 3);

  const attacker = '203.0.113.20';
  assert.equal(await authenticateBearerRequest(ctx, request(attacker, `ch_${'a'.repeat(43)}`)), null);
  assert.equal(await authenticateBearerRequest(ctx, request(attacker, `ch_${'b'.repeat(43)}`)), null);
  assert.equal(keyLookups, 5);
  const rejected = request(attacker, `ch_${'c'.repeat(43)}`);
  await assert.rejects(
    () => authenticateBearerRequest(ctx, rejected),
    (error: unknown) => error instanceof HttpError && error.status === 429,
  );
  assert.equal(keyLookups, 5, 'an exhausted client cannot reach the key store');
  assert.equal(rejected.durableAudit, false, 'pre-authentication rejects cannot consume durable audit capacity');

  assert.equal(await authenticateBearerRequest(ctx, request('203.0.113.21', `ch_${'d'.repeat(43)}`)), null);
  assert.equal(keyLookups, 6, 'a different client receives an independent failure budget');

  const malformed = request('203.0.113.22', 'not-a-codeharbor-key');
  assert.equal(await authenticateBearerRequest(ctx, malformed), null);
  assert.equal(keyLookups, 6, 'malformed bearer values remain rejected before the key store');
});
