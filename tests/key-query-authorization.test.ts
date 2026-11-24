import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CredentialCipher, createAccessKey } from '../src/auth.js';
import { CodeupError } from '../src/codeup.js';
import { createInternalMcpHandler } from '../src/internal-mcp.js';
import { createMcpService, SocketMcpBackend } from '../src/mcp-service.js';
import { createLegacyTestApp as createApp } from './helpers/legacy-auth.js';
import { openTestStore } from './helpers/postgres.js';

test('MCP queries use explicit Key scope while cloud credentials are unavailable', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codeharbor-local-auth-'));
  const allowedHosts: string[] = [];
  const secret = randomBytes(32).toString('hex');
  const encryptionKey = randomBytes(32);
  const access = createAccessKey();
  const revokedDuringQuery = createAccessKey();
  const expired = createAccessKey();
  const cloudAdmin = createAccessKey();
  const clients: Client[] = [];
  let repositoryChecks = 0;
  let cloneChecks = 0;
  let cloudLists = 0;
  let duringQuery: (() => Promise<void>) | undefined;
  const codeup = {
    async getRepository() {
      repositoryChecks++;
      throw new CodeupError('unavailable');
    },
    async listRepositories() {
      cloudLists++;
      throw new CodeupError('invalid_credential', 401);
    },
  };
  const graph = {
    async withQuery<T>(fn: (explore: (path: string, query: string) => Promise<string>) => Promise<T>): Promise<T> {
      return await fn(async () => {
        await duringQuery?.();
        return 'private-fixture-code';
      });
    },
    async probe() {},
    async close() {},
  };
  const db = await openTestStore();
  const app = createApp(
    {
      dataDir: dir,
      credentialKey: encryptionKey,
      codeupEndpoint: 'https://devops.example',
      allowedGitHosts: ['git.example'],
      allowedHosts,
      writeUsers: ['owner'],
      codegraphBin: 'codegraph',
    },
    {
      store: db.store,
      codeup: codeup as never,
      graph: graph as never,
      worker: { async stop() {} } as never,
      probe: async () => {
        cloneChecks++;
        throw new Error('cloud unavailable');
      },
    },
  );
  let ipc: Awaited<ReturnType<typeof createInternalMcpHandler>> | undefined;
  let mcp: ReturnType<typeof createMcpService> | undefined;
  try {
    await app.store.createUser({
      id: 'owner',
      username: 'owner',
      credential: new CredentialCipher(encryptionKey).encrypt('expired-pat', 'owner'),
      credential_version: 1,
    });
    for (const [id, cloudId, commit] of [
      ['repo-a', '11', 'a'],
      ['repo-b', '22', 'b'],
    ] as const) {
      await app.store.createRepository({
        id,
        codeup_id: cloudId,
        name: id,
        branch: 'main',
        owner: 'owner',
        sync_owner: 'owner',
        sync_credential_version: 1,
        hook_hash: 'hook',
        path: `oci://sha256:${commit.repeat(64)}`,
        commit: commit.repeat(40),
        indexed_at: Date.now(),
        status: 'ready',
        error: null,
      });
    }
    for (const [key, expiry] of [
      [access, null],
      [revokedDuringQuery, null],
      [expired, Date.now() - 1],
    ] as const) {
      await app.store.createKey({
        ...key,
        owner: 'owner',
        scope: 'read',
        repos: ['repo-a'],
        expires_at: expiry,
        revoked: 0,
      });
    }
    // This Key is used only for the existing cloud-list endpoint, which currently requires null scope.
    await app.store.createKey({
      ...cloudAdmin,
      owner: 'owner',
      scope: 'write',
      repos: null,
      expires_at: null,
      revoked: 0,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    allowedHosts.push(`127.0.0.1:${address.port}`);
    const socket = join(dir, 'rpc.sock');
    ipc = await createInternalMcpHandler({ path: socket, token: secret, backend: app.internalMcp });
    const mcpHosts: string[] = ['127.0.0.1:0'];
    mcp = createMcpService({ backend: new SocketMcpBackend(socket, secret), allowedHosts: mcpHosts });
    await mcp.listen({ port: 0, host: '127.0.0.1' });
    const mcpAddress = mcp.server.address();
    assert.ok(mcpAddress && typeof mcpAddress === 'object');
    mcpHosts.push(`127.0.0.1:${mcpAddress.port}`);
    const base = `http://127.0.0.1:${mcpAddress.port}`;
    async function clientFor(token: string) {
      const client = new Client({ name: 'key-auth-test', version: '1' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    }
    const client = await clientFor(access.token);
    const listing = await client.callTool({ name: 'list_repositories', arguments: {} });
    assert.notEqual(listing.isError, true);
    assert.match(JSON.stringify(listing), /repo-a/);
    assert.doesNotMatch(JSON.stringify(listing), /repo-b/);
    const status = await client.callTool({ name: 'get_repository_status', arguments: { repo_id: 'repo-a' } });
    assert.notEqual(status.isError, true);
    const found = await client.callTool({
      name: 'codegraph_explore',
      arguments: { repo_id: 'repo-a', query: 'fixture' },
    });
    assert.notEqual(found.isError, true);
    assert.match(JSON.stringify(found), /private-fixture-code/);
    const other = await client.callTool({
      name: 'codegraph_explore',
      arguments: { repo_id: 'repo-b', query: 'fixture' },
    });
    assert.equal(other.isError, true);
    assert.doesNotMatch(JSON.stringify(other), /private-fixture-code/);
    assert.equal(repositoryChecks, 0);
    assert.equal(cloneChecks, 0);

    await app.store.updateRepository('repo-a', { commit: 'c'.repeat(40) });
    const afterUpdate = await client.callTool({
      name: 'codegraph_explore',
      arguments: { repo_id: 'repo-a', query: 'fixture' },
    });
    assert.notEqual(afterUpdate.isError, true);
    assert.match(JSON.stringify(afterUpdate), /private-fixture-code/);
    assert.equal(repositoryChecks, 0);
    assert.equal(cloneChecks, 0);

    await app.store.updateRepository('repo-a', { status: 'disabled' });
    const disabled = await client.callTool({
      name: 'codegraph_explore',
      arguments: { repo_id: 'repo-a', query: 'fixture' },
    });
    assert.equal(disabled.isError, true);
    assert.doesNotMatch(JSON.stringify(disabled), /private-fixture-code/);
    await app.store.updateRepository('repo-a', { status: 'ready' });

    const inFlight = await clientFor(revokedDuringQuery.token);
    duringQuery = () => app.store.revokeKey(revokedDuringQuery.hash);
    const denied = await inFlight.callTool({
      name: 'codegraph_explore',
      arguments: { repo_id: 'repo-a', query: 'fixture' },
    });
    assert.equal(denied.isError, true);
    assert.doesNotMatch(JSON.stringify(denied), /private-fixture-code/);
    duringQuery = undefined;
    await assert.rejects(clientFor(expired.token));

    const cloudResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/codeup/repositories`, {
      headers: { authorization: `Bearer ${cloudAdmin.token}` },
    });
    assert.equal(cloudResponse.status, 401);
    assert.equal(cloudLists, 1);
    assert.equal((await app.store.getKey(access.hash))?.revoked, 0);
    const afterExpiredPat = await client.callTool({
      name: 'codegraph_explore',
      arguments: { repo_id: 'repo-a', query: 'fixture' },
    });
    assert.notEqual(afterExpiredPat.isError, true);
    assert.match(JSON.stringify(afterExpiredPat), /private-fixture-code/);
    assert.equal(repositoryChecks, 0);
    assert.equal(cloneChecks, 0);
    await app.store.revokeKey(access.hash);
    assert.equal(await app.internalMcp.authenticate(`Bearer ${access.token}`), false);
    const revokedResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/me`, {
      headers: { authorization: `Bearer ${access.token}` },
    });
    assert.equal(revokedResponse.status, 401);
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await mcp?.close().catch(() => {});
    await ipc?.close().catch(() => {});
    await app.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
