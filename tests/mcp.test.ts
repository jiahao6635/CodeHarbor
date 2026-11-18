import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CodeGraphClient } from '../src/codegraph.js';
import { CODEGRAPH_TOOL_NAMES } from '../src/codegraph-tools.js';
import { createMcpHandler, type McpRepository } from '../src/mcp.js';

const repos: McpRepository[] = [
  {
    id: 'alpha',
    name: 'Alpha',
    status: 'ready',
    indexedCommit: 'aaa',
    indexedAt: '2026-01-01T00:00:00Z',
    stale: false,
    projectPath: '/internal/alpha',
  },
  {
    id: 'beta',
    name: 'Beta',
    status: 'ready',
    indexedCommit: 'bbb',
    indexedAt: '2026-01-01T00:00:00Z',
    stale: false,
    projectPath: '/internal/beta',
  },
];

test('MCP routes authorized repositories without exposing server paths or mixing callers', async () => {
  let allowed = true;
  const seen: string[] = [];
  const codegraph = {
    async withQuery<T>(fn: (explore: (path: string, query: string) => Promise<string>) => Promise<T>): Promise<T> {
      return fn(async (path, query) => {
        seen.push(path);
        return `${query} in [repository]`;
      });
    },
  } as CodeGraphClient;
  const http = createServer();
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const host = `127.0.0.1:${address.port}`;
  const handle = createMcpHandler({
    allowedHosts: [host],
    codegraph,
    async authenticate(req) {
      return allowed ? (req.headers.authorization?.replace('Bearer ', '') ?? null) : null;
    },
    async listRepositories(user) {
      return repos.filter((repo) => repo.id === user);
    },
    async getRepository(user, id) {
      return repos.find((repo) => repo.id === id && repo.id === user) ?? null;
    },
  });
  http.on('request', (req, res) => {
    void handle(req, res);
  });
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://${host}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer alpha' } },
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ['list_repositories', 'get_repository_status', ...CODEGRAPH_TOOL_NAMES],
    );
    const listing = await client.callTool({ name: 'list_repositories', arguments: {} });
    assert.match(JSON.stringify(listing), /Alpha/);
    assert.doesNotMatch(JSON.stringify(listing), /Beta|\/internal/);
    const denial = await client.callTool({ name: 'codegraph_explore', arguments: { repo_id: 'beta', query: 'test' } });
    assert.equal(denial.isError, true);
    assert.deepEqual(seen, []);
    const injection = await client.callTool({
      name: 'codegraph_explore',
      arguments: { repo_id: 'alpha', query: 'test', projectPath: '/internal/beta' },
    });
    assert.equal(injection.isError, true);
    const ok = await client.callTool({ name: 'codegraph_explore', arguments: { repo_id: 'alpha', query: 'test' } });
    assert.equal(ok.isError, undefined);
    assert.match(JSON.stringify(ok), /aaa/);
    assert.doesNotMatch(JSON.stringify(ok), /\/internal/);
    assert.deepEqual(seen, ['/internal/alpha']);
    const betaClient = new Client({ name: 'beta-test', version: '1' });
    const betaTransport = new StreamableHTTPClientTransport(new URL(`http://${host}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer beta' } },
    });
    try {
      await betaClient.connect(betaTransport);
      const betaListing = await betaClient.callTool({ name: 'list_repositories', arguments: {} });
      assert.match(JSON.stringify(betaListing), /Beta/);
      assert.doesNotMatch(JSON.stringify(betaListing), /Alpha|\/internal/);
      const betaDenial = await betaClient.callTool({ name: 'get_repository_status', arguments: { repo_id: 'alpha' } });
      assert.equal(betaDenial.isError, true);
      const betaOk = await betaClient.callTool({
        name: 'codegraph_explore',
        arguments: { repo_id: 'beta', query: 'test' },
      });
      assert.equal(betaOk.isError, undefined);
      assert.deepEqual(seen, ['/internal/alpha', '/internal/beta']);
    } finally {
      await betaClient.close();
    }
    allowed = false;
    await assert.rejects(client.callTool({ name: 'list_repositories', arguments: {} }));
  } finally {
    await client.close();
    http.close();
  }
});

test('MCP does not return source if access or key is revoked while a query runs', async () => {
  let validKey = true;
  let permitted = true;
  let releaseQuery: (() => void) | undefined;
  let queryStarted: (() => void) | undefined;
  const codegraph = {
    async withQuery<T>(fn: (explore: (path: string, query: string) => Promise<string>) => Promise<T>): Promise<T> {
      return fn(async () => {
        queryStarted?.();
        await new Promise<void>((resolve) => {
          releaseQuery = resolve;
        });
        return 'sensitive-source-code';
      });
    },
  } as CodeGraphClient;
  const http = createServer();
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const host = `127.0.0.1:${address.port}`;
  const handle = createMcpHandler({
    allowedHosts: [host],
    codegraph,
    async authenticate() {
      return validKey ? 'alpha' : null;
    },
    async listRepositories() {
      return permitted ? [repos[0]] : [];
    },
    async getRepository(_user, id) {
      return permitted && id === 'alpha' ? repos[0] : null;
    },
  });
  http.on('request', (req, res) => {
    void handle(req, res);
  });
  const client = new Client({ name: 'race-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://${host}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer alpha' } },
  });
  try {
    await client.connect(transport);
    for (const revoke of [
      () => {
        permitted = false;
      },
      () => {
        validKey = false;
      },
    ]) {
      validKey = true;
      permitted = true;
      const started = new Promise<void>((resolve) => {
        queryStarted = resolve;
      });
      const running = client.callTool({ name: 'codegraph_explore', arguments: { repo_id: 'alpha', query: 'x' } });
      await started;
      revoke();
      releaseQuery!();
      const result = await running;
      assert.equal(result.isError, true);
      assert.doesNotMatch(JSON.stringify(result), /sensitive-source-code/);
    }
  } finally {
    await client.close();
    http.close();
  }
});
