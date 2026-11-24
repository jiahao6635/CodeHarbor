import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CredentialCipher, createAccessKey } from '../src/auth.js';
import { Authorization, createMutex } from '../src/authorization.js';
import type { Explore, GraphClient } from '../src/codegraph.js';
import {
  CODEGRAPH_TOOL_NAMES,
  CODEGRAPH_TOOLS,
  type CodeGraphToolCall,
  type GraphToolQuery,
} from '../src/codegraph-tools.js';
import type { AuditEvent } from '../src/http/context.js';
import { HttpError } from '../src/http/errors.js';
import { internalRepository, mcpRepository } from '../src/http/views.js';
import { createInternalMcpHandler, type InternalMcpBackend } from '../src/internal-mcp.js';
import { createInternalMcpBackend } from '../src/internal-mcp-backend.js';
import { createMcpHandler } from '../src/mcp.js';
import { createMcpService, type McpServiceLimits, SocketMcpBackend } from '../src/mcp-service.js';
import type { AccessRecord, KeyRecord, RepositoryRecord, StoreBackend } from '../src/store.js';

const TOOL_NAMES = [
  'codegraph_search',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_impact',
  'codegraph_node',
  'codegraph_explore',
  'codegraph_files',
] as const;
const SERVICE_TOKEN = 'full-tools-internal-token-0000000000000000';
const SOURCE = 'PRIVATE_INDEXED_SOURCE_FULL_TOOLS';
const REPO_PATH = '/private/codeharbor/full-tools/repo1';
const COMMIT = 'a'.repeat(40);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sourceFor = (call: CodeGraphToolCall) => `${SOURCE}:${call.name}`;

// Every optional parameter has a non-default value, including both node modes.
const CALLS: { label: string; call: CodeGraphToolCall }[] = [
  {
    label: 'search kind/limit',
    call: { name: 'codegraph_search', arguments: { query: 'PrivateSearchNeedle', kind: 'method', limit: 37 } },
  },
  {
    label: 'callers file/limit',
    call: {
      name: 'codegraph_callers',
      arguments: { symbol: 'PrivateCallerSymbol', file: 'src/callers.ts', limit: 31 },
    },
  },
  {
    label: 'callees file/limit',
    call: {
      name: 'codegraph_callees',
      arguments: { symbol: 'PrivateCalleeSymbol', file: 'src/callees.ts', limit: 29 },
    },
  },
  {
    label: 'impact file/depth',
    call: { name: 'codegraph_impact', arguments: { symbol: 'PrivateImpactSymbol', file: 'src/impact.ts', depth: 7 } },
  },
  {
    label: 'node file-only pagination/symbolsOnly',
    call: {
      name: 'codegraph_node',
      arguments: { file: 'src/private-file.ts', offset: 13, limit: 47, symbolsOnly: true },
    },
  },
  {
    label: 'node symbol source/disambiguation',
    call: {
      name: 'codegraph_node',
      arguments: { symbol: 'PrivateNodeSymbol', includeCode: true, file: 'src/private-symbol.ts', line: 71 },
    },
  },
  {
    label: 'explore maxFiles',
    call: { name: 'codegraph_explore', arguments: { query: 'PrivateExploreNeedle', maxFiles: 23 } },
  },
  {
    label: 'files path/pattern/format/metadata/depth',
    call: {
      name: 'codegraph_files',
      arguments: { path: 'src/private-tree', pattern: '**/*.tsx', format: 'flat', includeMetadata: false, maxDepth: 9 },
    },
  },
  {
    label: 'node file-only false boolean and upper bounds',
    call: {
      name: 'codegraph_node',
      arguments: { file: 'src/bounds.ts', offset: 10_000_000, limit: 2000, symbolsOnly: false },
    },
  },
  {
    label: 'node symbol false includeCode and upper line bound',
    call: {
      name: 'codegraph_node',
      arguments: { symbol: 'PrivateNoCodeSymbol', includeCode: false, line: 10_000_000 },
    },
  },
  {
    label: 'files grouped/true metadata',
    call: { name: 'codegraph_files', arguments: { format: 'grouped', includeMetadata: true, maxDepth: 100 } },
  },
  { label: 'files tree mode', call: { name: 'codegraph_files', arguments: { format: 'tree' } } },
];
const PRIMARY_CALLS = TOOL_NAMES.map((name) => CALLS.find((entry) => entry.call.name === name)!.call);

type Surface = 'split' | 'public';
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function sendSocket(path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path });
    let text = '';
    const timer = setTimeout(() => socket.destroy(new Error('Fixture socket timeout')), 5000);
    socket.once('connect', () => socket.write(`${JSON.stringify(body)}\n`));
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    socket.once('end', () => {
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
    socket.once('close', () => clearTimeout(timer));
  });
}

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  surface: Surface = 'split',
  limits?: Partial<McpServiceLimits>,
) {
  // Short, owner-only directory keeps Unix socket paths below Darwin's limit.
  const root = await mkdtemp(join(tmpdir(), 'ch-full-'));
  await chmod(root, 0o700);
  const socketPath = join(root, 'm.sock');
  const alice = createAccessKey();
  const bob = createAccessKey();
  const header = `Bearer ${alice.token}`;
  const bobHeader = `Bearer ${bob.token}`;
  const keys = new Map<string, KeyRecord>();
  const repositories = new Map<string, RepositoryRecord>();
  const access = new Map<string, AccessRecord>();
  const audits: AuditEvent[] = [];
  const graphCalls: { path: string; call: CodeGraphToolCall; identity: Parameters<GraphToolQuery>[3] }[] = [];
  const state = {
    backendCalls: 0,
    queryLeases: 0,
    legacyQueries: 0,
    cloudCalls: 0,
    healthChecks: 0,
    graphProbes: 0,
    accessReads: 0,
    onGraphQuery: undefined as (() => Promise<void>) | undefined,
    onQueryQueued: undefined as (() => void) | undefined,
  };
  const baseline: RepositoryRecord = {
    id: 'repo1',
    codeup_id: '11',
    name: 'Alice repository',
    branch: 'main',
    owner: 'alice',
    sync_owner: 'alice',
    sync_credential_version: 1,
    sync_interval_minutes: null,
    hook_hash: 'fixture-hook',
    path: REPO_PATH,
    commit: COMMIT,
    previous_image: null,
    previous_commit: null,
    indexed_at: 1000,
    status: 'ready',
    error: null,
  };
  const keyRow = (key: typeof alice, owner: string, repos: string[] | null): KeyRecord => ({
    hash: key.hash,
    prefix: key.prefix,
    owner,
    scope: 'read',
    repos,
    expires_at: null,
    revoked: 0,
  });
  const reset = () => {
    keys.set(alice.hash, keyRow(alice, 'alice', null));
    keys.set(bob.hash, keyRow(bob, 'bob', ['repo2']));
    repositories.set('repo1', structuredClone(baseline));
    repositories.set('repo2', {
      ...baseline,
      id: 'repo2',
      codeup_id: '22',
      name: 'Bob repository',
      owner: 'bob',
      sync_owner: 'bob',
      path: '/private/codeharbor/full-tools/repo2',
      commit: 'b'.repeat(40),
    });
    access.set('alice:repo1', { user_id: 'alice', repo_id: 'repo1', allowed: 1, verified_at: Date.now() });
    access.set('alice:repo2', { user_id: 'alice', repo_id: 'repo2', allowed: 0, verified_at: Date.now() });
    state.onGraphQuery = undefined;
    state.onQueryQueued = undefined;
  };
  reset();
  const clone = <T>(value: T): T => structuredClone(value);
  // Deliberately only implement Store operations reached by actual Authorization.
  // Returning snapshots (not live objects) makes index-version races meaningful.
  const store = {
    async getKey(hash: string) {
      return clone(keys.get(hash));
    },
    async getUser(id: string) {
      return ['alice', 'bob'].includes(id)
        ? { id, username: id, credential: 'unused-encrypted-fixture', credential_version: 1 }
        : undefined;
    },
    async getRepository(id: string) {
      return clone(repositories.get(id));
    },
    async listRepositories() {
      return [...repositories.values()].map(clone);
    },
    async getRepositoriesByIds(ids: string[]) {
      return [...repositories.values()].filter((repo) => ids.includes(repo.id)).map(clone);
    },
    async getAccess(userId: string, repoId: string) {
      state.accessReads++;
      return clone(access.get(`${userId}:${repoId}`));
    },
    async listAccess(userId: string) {
      return [...access.values()].filter((row) => row.user_id === userId).map(clone);
    },
    async upsertAccess(row: AccessRecord) {
      access.set(`${row.user_id}:${row.repo_id}`, clone(row));
    },
    async revokeKey(hash: string) {
      const row = keys.get(hash);
      if (row) keys.set(hash, { ...row, revoked: 1 });
    },
    async updateRepository(id: string, patch: Partial<RepositoryRecord>) {
      const row = repositories.get(id);
      assert.ok(row);
      repositories.set(id, { ...row, ...clone(patch) });
    },
    async checkHealth() {
      state.healthChecks++;
    },
    async close() {},
  };
  const authorization = new Authorization({
    store: store as unknown as StoreBackend,
    codeup: {
      async getRepository() {
        state.cloudCalls++;
        throw new Error('Unexpected Codeup call with fresh access');
      },
    },
    cipher: new CredentialCipher(Buffer.alloc(32, 7)),
    writeUsers: [],
    accessTtlMs: 60_000,
    auditRetentionDays: 1,
  });
  const mutex = createMutex();
  const queryTool: GraphToolQuery = async (path, call, signal, identity) => {
    assert.ok(signal && !signal.aborted, 'real query receives the request signal');
    assert.ok(identity, 'published repository identity is supplied');
    const repo = repositories.get(identity.repoId);
    assert.ok(repo);
    assert.equal(path, repo.path, 'path is resolved from the authorized repository, never user arguments');
    assert.equal(identity.commit, repo.commit);
    graphCalls.push({ path, call: clone(call), identity: clone(identity) });
    await state.onGraphQuery?.();
    return sourceFor(call);
  };
  const graph: GraphClient = {
    async withToolQuery<T>(operation: (callTool: GraphToolQuery) => Promise<T>, signal?: AbortSignal): Promise<T> {
      state.queryLeases++;
      state.onQueryQueued?.();
      return mutex(async () => {
        if (signal?.aborted) throw new Error('Request cancelled');
        return operation(queryTool);
      });
    },
    async withQuery<T>(_operation: (explore: Explore) => Promise<T>): Promise<T> {
      state.legacyQueries++;
      throw new Error('Full-tool graph must use withToolQuery, including legacy IPC explore');
    },
    async withExclusive<T>(operation: (explore: Explore) => Promise<T>): Promise<T> {
      return mutex(() =>
        operation((path, query, signal, identity) =>
          queryTool(path, { name: 'codegraph_explore', arguments: { query } }, signal, identity),
        ),
      );
    },
    async probe(signal?: AbortSignal) {
      assert.ok(!signal?.aborted);
      state.graphProbes++;
    },
    async close() {},
  };
  const actualBackend = createInternalMcpBackend({
    store: store as unknown as StoreBackend,
    graph,
    authorization,
    audit: (event) => audits.push(event),
  });
  // Instrument entry only; dispatch, validation, authorization and audit stay production code.
  const backend: InternalMcpBackend = {
    ...actualBackend,
    async callTool(...args) {
      state.backendCalls++;
      return actualBackend.callTool!(...args);
    },
    async explore(...args) {
      state.backendCalls++;
      return actualBackend.explore(...args);
    },
  };
  let ipc: Awaited<ReturnType<typeof createInternalMcpHandler>> | undefined;
  let service: ReturnType<typeof createMcpService> | undefined;
  let publicServer: ReturnType<typeof createServer> | undefined;
  const clients: Client[] = [];
  const finishGates: ReturnType<typeof deferred>[] = [];
  t.after(async () => {
    for (const gate of finishGates) gate.release();
    state.onGraphQuery = undefined;
    state.onQueryQueued = undefined;
    for (const client of clients) await client.close().catch(() => {});
    if (service) {
      service.server.closeAllConnections();
      await service.close();
    }
    if (publicServer) {
      publicServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => publicServer!.close((error) => (error ? reject(error) : resolve())));
    }
    await ipc?.close();
    await rm(root, { recursive: true, force: true });
  });
  ipc = await createInternalMcpHandler({ path: socketPath, token: SERVICE_TOKEN, backend, timeoutMs: 10_000 });
  const socketBackend = new SocketMcpBackend(socketPath, SERVICE_TOKEN, 10_000);
  const allowedHosts = ['127.0.0.1'];
  let host: string;
  if (surface === 'split') {
    service = createMcpService({ backend: socketBackend, allowedHosts, limits, log() {} });
    await service.listen({ port: 0, host: '127.0.0.1' });
    const address = service.server.address();
    assert.ok(address && typeof address !== 'string');
    host = `127.0.0.1:${address.port}`;
  } else {
    const handler = createMcpHandler({
      allowedHosts,
      codegraph: graph,
      authenticate: (req) => authorization.authenticateBearer(req.headers.authorization ?? ''),
      async listRepositories(principal, signal) {
        return (await authorization.queryList(principal, signal)).map(mcpRepository);
      },
      async getRepository(principal, id, signal) {
        try {
          return mcpRepository(await authorization.queryVisible(principal, id, signal));
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) return null;
          throw error;
        }
      },
      onToolResult(_req, event) {
        audits.push({
          request_id: 'public-fixture',
          method: 'POST',
          route: '/mcp',
          status: event.outcome === 'success' ? 200 : 400,
          tool: event.tool,
          tool_outcome: event.outcome,
          repo_id: event.repo_id,
          query_hash: event.query_hash,
        });
      },
    });
    publicServer = createServer((req, res) => {
      void handler(req, res).catch(() => res.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      publicServer!.once('error', reject);
      publicServer!.listen(0, '127.0.0.1', resolve);
    });
    const address = publicServer.address();
    assert.ok(address && typeof address !== 'string');
    host = `127.0.0.1:${address.port}`;
  }
  allowedHosts.push(host);
  const base = `http://${host}`;
  const clientFor = async (authorizationHeader = header) => {
    const client = new Client({ name: 'full-tools-test', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: authorizationHeader } },
      }),
    );
    return client;
  };
  const client = await clientFor();
  const snapshot = () => ({
    backendCalls: state.backendCalls,
    queryLeases: state.queryLeases,
    graphCalls: graphCalls.length,
  });
  const requestBody = (call: unknown, extra: Record<string, unknown> = {}) => ({
    op: 'call_tool',
    token: SERVICE_TOKEN,
    authorization: header,
    repoId: 'repo1',
    call,
    ...extra,
  });
  const gateQuery = () => {
    const started = deferred();
    const finish = deferred();
    finishGates.push(finish);
    state.onGraphQuery = async () => {
      started.release();
      await finish.promise;
    };
    return { started, finish };
  };
  const revokeAccess = () =>
    store.upsertAccess({ user_id: 'alice', repo_id: 'repo1', allowed: 0, verified_at: Date.now() });
  return {
    client,
    clientFor,
    header,
    bobHeader,
    alice,
    audits,
    state,
    graphCalls,
    graph,
    store,
    repositories,
    reset,
    snapshot,
    socketPath,
    socketBackend,
    requestBody,
    gateQuery,
    revokeAccess,
    finishGates,
    base,
  };
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>;
function assertNoSource(result: ToolResult) {
  assert.equal(result.isError, true, JSON.stringify(result));
  const text = JSON.stringify(result);
  assert.ok(!text.includes(SOURCE), 'error must discard computed source');
  assert.ok(!text.includes(REPO_PATH), 'error must not expose internal paths');
  assert.ok(!text.includes(SERVICE_TOKEN), 'error must not expose service credentials');
}
function assertAudit(
  events: AuditEvent[],
  call: CodeGraphToolCall,
  outcome: 'success' | 'error',
  surface: Surface,
  prefix: string,
  authenticated = true,
) {
  assert.equal(events.length, 1, 'one audit event per code tool, not one per authorization or IPC layer');
  const event = events[0];
  assert.equal(event.tool, call.name);
  assert.equal(event.tool_outcome, outcome);
  assert.match(event.query_hash ?? '', /^[a-f0-9]{64}$/);
  const hashInput =
    surface === 'public' ? { name: call.name, arguments: { repo_id: 'repo1', ...call.arguments } } : call;
  const bareExplore = call.name === 'codegraph_explore' && Object.keys(call.arguments).length === 1;
  assert.equal(event.query_hash, sha256(bareExplore ? (call.arguments.query as string) : JSON.stringify(hashInput)));
  const allowed = [
    'request_id',
    'method',
    'route',
    'status',
    'tool',
    'tool_outcome',
    'subject',
    'key_prefix',
    'authentication',
    'repo_id',
    'query_hash',
  ];
  assert.ok(
    Object.keys(event).every((key) => allowed.includes(key)),
    'audit cannot retain raw argument fields',
  );
  if (surface === 'split') {
    if (authenticated) {
      assert.equal(event.subject, 'alice');
      assert.equal(event.key_prefix, prefix);
      assert.equal(event.authentication, 'api_key');
      assert.equal(event.repo_id, 'repo1');
    } else {
      // A key revoked before lock acquisition never yields a backend principal.
      assert.equal(event.subject, undefined);
      assert.equal(event.key_prefix, undefined);
      assert.equal(event.authentication, undefined);
      assert.equal(event.repo_id, undefined);
    }
  }
  const auditText = JSON.stringify(events);
  for (const value of [SOURCE, REPO_PATH, SERVICE_TOKEN]) assert.ok(!auditText.includes(value));
  assert.ok(!auditText.includes(JSON.stringify(call.arguments)), 'raw argument object is not audited');
  const auditValues = Object.values(event)
    .filter((value) => typeof value === 'string')
    .join('\n');
  for (const [key, value] of Object.entries(call.arguments)) {
    // Check recorded values, not field names (kind='method' must not match the audit's 'method' key).
    if (typeof value === 'string') assert.ok(!auditValues.includes(value), `${key} is hashed, not recorded`);
  }
}

for (const surface of ['split', 'public'] as const) {
  test(`${surface}: tools/list exposes two repository tools and exactly seven complete code tools`, {
    timeout: 15_000,
  }, async (t) => {
    const f = await fixture(t, surface);
    assert.deepEqual(
      CODEGRAPH_TOOL_NAMES,
      TOOL_NAMES,
      'independent expected list catches accidentally omitted exports',
    );
    const listed = await f.client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ['list_repositories', 'get_repository_status', ...TOOL_NAMES],
    );
    assert.deepEqual(
      listed.tools.slice(2),
      CODEGRAPH_TOOLS,
      'schemas and optional fields survive the SDK HTTP boundary',
    );
    for (const tool of listed.tools.slice(2)) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(tool.inputSchema.required?.includes('repo_id'));
      assert.ok(!Object.hasOwn(tool.inputSchema.properties ?? {}, 'projectPath'));
      assert.equal(tool.annotations?.readOnlyHint, true);
    }
    assert.deepEqual(f.snapshot(), { backendCalls: 0, queryLeases: 0, graphCalls: 0 });
    assert.equal(f.audits.length, 0, 'discovery is not a code query audit');
    const repos = await f.client.callTool({ name: 'list_repositories', arguments: {} });
    assert.notEqual(repos.isError, true);
    assert.match(JSON.stringify(repos), /Alice repository/);
    assert.doesNotMatch(JSON.stringify(repos), /Bob repository|\/private\/codeharbor/);
    const status = await f.client.callTool({ name: 'get_repository_status', arguments: { repo_id: 'repo1' } });
    assert.notEqual(status.isError, true);
    assert.match(JSON.stringify(status), new RegExp(COMMIT));
    assert.doesNotMatch(JSON.stringify(status), /projectPath|\/private\/codeharbor/);
    if (surface === 'split') {
      assert.equal((await fetch(`${f.base}/health/ready`)).status, 200);
      assert.equal(f.state.healthChecks, 1);
      assert.equal(f.state.graphProbes, 1);
    }
    assert.equal(f.state.cloudCalls, 0);
  });

  test(`${surface}: all seven tools preserve real parameters and audit exactly once without raw data`, {
    timeout: 20_000,
  }, async (t) => {
    const f = await fixture(t, surface);
    for (const { label, call } of CALLS) {
      await t.test(label, async () => {
        const before = f.snapshot();
        const auditStart = f.audits.length;
        const result = await f.client.callTool({ name: call.name, arguments: { repo_id: 'repo1', ...call.arguments } });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        assert.ok(Array.isArray(result.content) && result.content[0]?.type === 'text');
        const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
        assert.equal(payload.repo_id, 'repo1');
        assert.equal(payload.indexed_commit, COMMIT);
        assert.equal(payload.result, sourceFor(call), 'the invoked graph function supplies the HTTP result');
        assert.deepEqual(f.graphCalls.slice(before.graphCalls), [
          { path: REPO_PATH, call, identity: { repoId: 'repo1', commit: COMMIT } },
        ]);
        assert.equal(f.state.queryLeases, before.queryLeases + 1);
        assert.equal(f.state.backendCalls, before.backendCalls + (surface === 'split' ? 1 : 0));
        assert.equal(f.state.legacyQueries, 0, 'no silent explore-only fallback');
        assert.doesNotMatch(JSON.stringify(result), /projectPath|\/private\/codeharbor|Bearer|internal-token/);
        assertAudit(f.audits.slice(auditStart), call, 'success', surface, f.alice.prefix);
        assert.ok(!JSON.stringify(f.audits).includes(f.alice.token));
      });
    }
    assert.equal(f.state.cloudCalls, 0);
  });

  test(`${surface}: every code tool rejects cross-repository reads without invoking GraphToolQuery`, {
    timeout: 20_000,
  }, async (t) => {
    const f = await fixture(t, surface);
    const bobClient = await f.clientFor(f.bobHeader);
    for (const call of PRIMARY_CALLS) {
      for (const [client, repoId] of [
        [f.client, 'repo2'],
        [bobClient, 'repo1'],
        [f.client, 'missing'],
      ] as const) {
        const before = f.graphCalls.length;
        const result = await client.callTool({ name: call.name, arguments: { repo_id: repoId, ...call.arguments } });
        assertNoSource(result);
        assert.equal(f.graphCalls.length, before, `${call.name} cannot query ${repoId}`);
      }
    }
    const allowed = await bobClient.callTool({
      name: 'codegraph_search',
      arguments: { repo_id: 'repo2', query: 'BobSearch' },
    });
    assert.notEqual(allowed.isError, true);
    assert.deepEqual(f.graphCalls.at(-1), {
      path: '/private/codeharbor/full-tools/repo2',
      call: { name: 'codegraph_search', arguments: { query: 'BobSearch' } },
      identity: { repoId: 'repo2', commit: 'b'.repeat(40) },
    });
    assert.equal(f.state.cloudCalls, 0);
  });

  test(`${surface}: invalid tools, injected fields, paths and numeric/types fail before the query backend`, {
    timeout: 30_000,
  }, async (t) => {
    const f = await fixture(t, surface, { keyRequestsPerMinute: 1000 });
    for (const { label, name, arguments: args } of invalidRequests()) {
      await t.test(label, async () => {
        const before = f.snapshot();
        const result = await f.client.callTool({ name, arguments: args });
        assertNoSource(result);
        assert.deepEqual(f.snapshot(), before, 'invalid HTTP input never enters internal backend or graph lease');
      });
    }
  });

  for (const race of ['access revoked', 'key revoked', 'commit changed', 'path changed'] as const) {
    test(`${surface}: every tool discards computed source when ${race} during the query`, {
      timeout: 30_000,
    }, async (t) => {
      const f = await fixture(t, surface);
      for (const call of PRIMARY_CALLS) {
        await t.test(call.name, { timeout: 5000 }, async () => {
          f.reset();
          const before = f.snapshot();
          const auditStart = f.audits.length;
          const gate = f.gateQuery();
          const running = f.client.callTool({ name: call.name, arguments: { repo_id: 'repo1', ...call.arguments } });
          try {
            await Promise.race([
              gate.started.promise,
              running.then(() => {
                throw new Error('Query did not reach GraphToolQuery');
              }),
            ]);
            assert.equal(f.graphCalls.length, before.graphCalls + 1, 'race is inside the actual queried function');
            if (race === 'access revoked') await f.revokeAccess();
            if (race === 'key revoked') await f.store.revokeKey(f.alice.hash);
            if (race === 'commit changed') await f.store.updateRepository('repo1', { commit: 'c'.repeat(40) });
            if (race === 'path changed')
              await f.store.updateRepository('repo1', { path: '/private/replacement-generation' });
          } finally {
            gate.finish.release();
          }
          assertNoSource(await running);
          assertAudit(f.audits.slice(auditStart), call, 'error', surface, f.alice.prefix);
          assert.equal(f.state.backendCalls, before.backendCalls + (surface === 'split' ? 1 : 0));
        });
      }
    });
  }

  for (const change of ['access revoked', 'key revoked', 'new publication'] as const) {
    test(`${surface}: queued tools reauthorize and resolve the current index after the publication lock (${change})`, {
      timeout: 30_000,
    }, async (t) => {
      const f = await fixture(t, surface);
      for (const call of PRIMARY_CALLS) {
        await t.test(call.name, { timeout: 5000 }, async () => {
          f.reset();
          const locked = deferred();
          const finish = deferred();
          const queued = deferred();
          f.finishGates.push(finish);
          const publication = f.graph.withExclusive(async () => {
            locked.release();
            await finish.promise;
          });
          await locked.promise;
          f.state.onQueryQueued = queued.release;
          const before = f.graphCalls.length;
          const auditStart = f.audits.length;
          const running = f.client.callTool({ name: call.name, arguments: { repo_id: 'repo1', ...call.arguments } });
          try {
            await Promise.race([
              queued.promise,
              running.then(() => {
                throw new Error('Query did not queue behind publication');
              }),
            ]);
            assert.equal(f.graphCalls.length, before, 'query is blocked by the shared publication lock');
            if (change === 'access revoked') await f.revokeAccess();
            if (change === 'key revoked') await f.store.revokeKey(f.alice.hash);
            if (change === 'new publication')
              await f.store.updateRepository('repo1', { path: '/private/new-publication', commit: 'd'.repeat(40) });
          } finally {
            finish.release();
          }
          await publication;
          const result = await running;
          if (change === 'new publication') {
            assert.notEqual(result.isError, true, JSON.stringify(result));
            assert.deepEqual(f.graphCalls.slice(before), [
              { path: '/private/new-publication', call, identity: { repoId: 'repo1', commit: 'd'.repeat(40) } },
            ]);
            assert.match(JSON.stringify(result), new RegExp('d'.repeat(40)));
          } else {
            assertNoSource(result);
            assert.equal(f.graphCalls.length, before, 'revocation while queued must prevent any code query');
          }
          assertAudit(
            f.audits.slice(auditStart),
            call,
            change === 'new publication' ? 'success' : 'error',
            surface,
            f.alice.prefix,
            change !== 'key revoked',
          );
        });
      }
    });
  }

  test(`${surface}: publication cannot enter while a code query holds its before/after authorization lease`, {
    timeout: 30_000,
  }, async (t) => {
    const f = await fixture(t, surface);
    for (const call of PRIMARY_CALLS) {
      await t.test(call.name, { timeout: 5000 }, async () => {
        f.reset();
        const accessReadsBefore = f.state.accessReads;
        const gate = f.gateQuery();
        const running = f.client.callTool({ name: call.name, arguments: { repo_id: 'repo1', ...call.arguments } });
        await Promise.race([
          gate.started.promise,
          running.then(() => {
            throw new Error('GraphToolQuery was not reached');
          }),
        ]);
        let published = false;
        const publication = f.graph.withExclusive(async () => {
          assert.equal(
            f.state.accessReads,
            accessReadsBefore + 2,
            'both real authorization checks completed before publication',
          );
          published = true;
          await f.store.updateRepository('repo1', { commit: 'e'.repeat(40) });
        });
        assert.equal(published, false);
        gate.finish.release();
        const result = await running;
        assert.notEqual(result.isError, true);
        assert.match(JSON.stringify(result), new RegExp(COMMIT));
        await publication;
        assert.equal(published, true);
      });
    }
  });
}

function invalidRequests(): { label: string; name: string; arguments: Record<string, unknown> }[] {
  const invalid: ReturnType<typeof invalidRequests> = [];
  const add = (label: string, call: CodeGraphToolCall, patch: Record<string, unknown>) =>
    invalid.push({ label, name: call.name, arguments: { repo_id: 'repo1', ...call.arguments, ...patch } });
  for (const call of PRIMARY_CALLS) {
    add(`${call.name}: projectPath injection`, call, { projectPath: '/etc' });
    add(`${call.name}: unknown argument`, call, { unexpected: true });
    for (const repo_id of ['../repo1', '', '/repo1', 'x'.repeat(129), 7, null]) {
      add(`${call.name}: invalid repo_id ${JSON.stringify(repo_id)}`, call, { repo_id });
    }
    invalid.push({ label: `${call.name}: missing repo_id`, name: call.name, arguments: { ...call.arguments } });
  }
  invalid.push({ label: 'unknown tool', name: 'codegraph_arbitrary', arguments: { repo_id: 'repo1' } });
  // Exercise every exposed property, not only the shared validator in isolation.
  for (const tool of CODEGRAPH_TOOLS) {
    const call = PRIMARY_CALLS.find((entry) => entry.name === tool.name)!;
    const properties = tool.inputSchema.properties as Record<
      string,
      { type: string; minimum?: number; maximum?: number; maxLength?: number; enum?: unknown[] }
    >;
    for (const [key, property] of Object.entries(properties)) {
      if (key === 'repo_id') continue;
      let values: unknown[];
      if (property.type === 'integer') {
        values = [0, -1, 1.5, property.maximum! + 1, Number.MAX_SAFE_INTEGER + 1, '2', true, null];
      } else if (property.type === 'boolean') {
        values = ['true', 'false', 0, 1, null];
      } else {
        values = ['', '   ', 'x'.repeat(property.maxLength! + 1), 'bad\0value', 1, false, null];
        if (property.enum) values.push('unsupported-enum-value');
      }
      for (const [index, value] of values.entries())
        add(`${tool.name}: invalid ${key} #${index}`, call, { [key]: value });
      if (['file', 'path', 'pattern'].includes(key)) {
        for (const path of [
          '../other/private.ts',
          'src/../../private.ts',
          '/etc/passwd',
          'C:\\private\\code.ts',
          '..\\private.ts',
          'src\\..\\private.ts',
          'src/\u001fprivate.ts',
        ]) {
          add(`${tool.name}: unsafe ${key} ${JSON.stringify(path)}`, call, { [key]: path });
        }
      }
    }
    for (const key of tool.inputSchema.required ?? []) {
      if (key === 'repo_id') continue;
      const args: Record<string, unknown> = { repo_id: 'repo1', ...call.arguments };
      delete args[key];
      invalid.push({ label: `${tool.name}: missing ${key}`, name: tool.name, arguments: args });
    }
  }
  invalid.push({ label: 'node requires symbol or file', name: 'codegraph_node', arguments: { repo_id: 'repo1' } });
  return invalid;
}

test('actual private IPC rejects malformed call_tool envelopes/arguments before backend entry and retains bare explore', {
  timeout: 30_000,
}, async (t) => {
  const f = await fixture(t);
  const search = PRIMARY_CALLS[0];
  const valid = f.requestBody(search);
  const malformed: { label: string; body: unknown }[] = [
    { label: 'wrong service token', body: { ...valid, token: 'wrong-service-token' } },
    { label: 'invalid bearer shape', body: { ...valid, authorization: 'Bearer invalid' } },
    { label: 'missing op', body: Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'op')) },
    { label: 'missing token', body: Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'token')) },
    {
      label: 'missing authorization',
      body: Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'authorization')),
    },
    { label: 'missing repoId', body: Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'repoId')) },
    { label: 'missing call', body: Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'call')) },
    { label: 'extra projectPath envelope', body: { ...valid, projectPath: '/etc' } },
    { label: 'extra owner envelope', body: { ...valid, owner: 'bob' } },
    { label: 'extra query envelope', body: { ...valid, query: 'legacy query' } },
    { label: 'unknown operation', body: { ...valid, op: 'arbitrary' } },
    { label: 'repoId traversal', body: { ...valid, repoId: '../repo1' } },
    { label: 'unknown call name', body: f.requestBody({ name: 'codegraph_arbitrary', arguments: {} }) },
    { label: 'extra call field', body: f.requestBody({ ...search, projectPath: '/etc' }) },
    { label: 'missing call name', body: f.requestBody({ arguments: search.arguments }) },
    { label: 'missing call arguments', body: f.requestBody({ name: search.name }) },
    { label: 'null call', body: f.requestBody(null) },
    { label: 'array call', body: f.requestBody([]) },
    { label: 'array arguments', body: f.requestBody({ name: search.name, arguments: [] }) },
    { label: 'null arguments', body: f.requestBody({ name: search.name, arguments: null }) },
  ];
  for (const entry of invalidRequests()) {
    const { repo_id, ...args } = entry.arguments;
    malformed.push({
      label: entry.label,
      body: f.requestBody({ name: entry.name, arguments: args }, { repoId: repo_id }),
    });
  }
  for (const { label, body } of malformed) {
    await t.test(label, async () => {
      const before = f.snapshot();
      const auditStart = f.audits.length;
      assert.deepEqual(await sendSocket(f.socketPath, body), { ok: false });
      assert.deepEqual(f.snapshot(), before, 'private trust boundary rejects before actual backend entry');
      assert.equal(f.audits.length, auditStart, 'invalid envelopes never reach backend audit');
    });
  }
  // A valid control proves the raw-socket helper reaches real dispatch, not a blanket denial.
  const auditStart = f.audits.length;
  assert.deepEqual(await sendSocket(f.socketPath, valid), {
    ok: true,
    result: { repository: internalRepository(f.repositories.get('repo1')!), result: sourceFor(search) },
  });
  assert.deepEqual(f.graphCalls.at(-1)?.call, search);
  assertAudit(f.audits.slice(auditStart), search, 'success', 'split', f.alice.prefix);
  const call: CodeGraphToolCall = { name: 'codegraph_explore', arguments: { query: 'PrivateLegacyExplore' } };
  for (const operation of [
    'raw explore',
    'SocketMcpBackend.explore',
    'SocketMcpBackend.callTool',
    'HTTP bare explore',
  ]) {
    const before = f.snapshot();
    const start = f.audits.length;
    const signal = new AbortController().signal;
    if (operation === 'raw explore') {
      assert.deepEqual(
        await sendSocket(f.socketPath, {
          op: 'explore',
          token: SERVICE_TOKEN,
          authorization: f.header,
          repoId: 'repo1',
          query: call.arguments.query,
        }),
        {
          ok: true,
          result: { repository: internalRepository(f.repositories.get('repo1')!), result: sourceFor(call) },
        },
      );
    } else if (operation === 'SocketMcpBackend.explore') {
      assert.equal(
        (await f.socketBackend.explore(f.header, 'repo1', call.arguments.query as string, signal))?.result,
        sourceFor(call),
      );
    } else if (operation === 'SocketMcpBackend.callTool') {
      assert.equal((await f.socketBackend.callTool(f.header, 'repo1', call, signal))?.result, sourceFor(call));
    } else {
      const result = await f.client.callTool({ name: call.name, arguments: { repo_id: 'repo1', ...call.arguments } });
      assert.notEqual(result.isError, true);
      assert.match(JSON.stringify(result), /PrivateLegacyExplore|PRIVATE_INDEXED_SOURCE_FULL_TOOLS/);
    }
    assert.deepEqual(f.graphCalls.slice(before.graphCalls), [
      { path: REPO_PATH, call, identity: { repoId: 'repo1', commit: COMMIT } },
    ]);
    assert.equal(f.state.backendCalls, before.backendCalls + 1);
    assert.equal(f.state.queryLeases, before.queryLeases + 1);
    assertAudit(f.audits.slice(start), call, 'success', 'split', f.alice.prefix);
  }
  assert.equal(f.state.legacyQueries, 0);
});
