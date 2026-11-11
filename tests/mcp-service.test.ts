import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { get, request as httpRequest, type ServerResponse } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpService, SocketMcpBackend, type McpHttpAccessEvent } from '../src/mcp-service.js';

const serviceToken = 'internal-token-000000000000000000000000';
const authorization = `Bearer ch_${'a'.repeat(43)}`;
const publicRepo = { repo_id: 'repo1', name: 'Repo', status: 'ready', indexed_commit: 'abc', indexed_at: null, stale: false };

test('isolated MCP service forwards the caller through Unix RPC and exposes no platform API', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codeharbor-mcp-service-'));
  const socketPath = join(directory, 'mcp.sock');
  const requests: Record<string, unknown>[] = [];
  let permitted = true; let available = true; let release: (() => void) | undefined; let began: (() => void) | undefined;
  const rpc = net.createServer(socket => {
    let data = '';
    socket.on('error', () => {});
    socket.on('data', async chunk => {
      data += chunk.toString();
      if (!data.endsWith('\n')) return;
      const request = JSON.parse(data) as Record<string, unknown>;
      requests.push(request);
      if (!available || request.token !== serviceToken) { socket.end('{"ok":false}\n'); return; }
      if (request.op !== 'probe' && request.authorization !== authorization) { socket.end('{"ok":false}\n'); return; }
      let result: unknown;
      switch (request.op) {
        case 'probe': result = true; break;
        case 'authenticate': result = permitted; break;
        case 'list': result = permitted ? [publicRepo] : []; break;
        case 'get': result = permitted && request.repoId === 'repo1' ? publicRepo : null; break;
        case 'explore':
          if (request.query === 'wait') {
            began?.();
            await new Promise<void>(resolve => { release = resolve; });
          }
          result = permitted && request.repoId === 'repo1' ? { repository: publicRepo, result: 'source-result' } : null;
          break;
        default: socket.end('{"ok":false}\n'); return;
      }
      socket.end(`${JSON.stringify({ok:true,result})}\n`);
    });
  });
  rpc.listen(socketPath); await once(rpc, 'listening');
  const allowedHosts: string[] = ['127.0.0.1'];
  const accessLog: McpHttpAccessEvent[] = [];
  const app = createMcpService({backend:new SocketMcpBackend(socketPath, serviceToken), allowedHosts, log:event => accessLog.push(event)});
  await app.listen({port:0,host:'127.0.0.1'});
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  allowedHosts.push(`127.0.0.1:${address.port}`);
  const base = `http://127.0.0.1:${address.port}`;
  const client = new Client({name:'isolated-test',version:'1'});
  try {
    assert.equal((await fetch(`${base}/health/live`)).status, 200);
    assert.equal((await fetch(`${base}/health/ready`)).status, 200);
    assert.equal((await fetch(`${base}/api/v1/repositories`)).status, 404);
    assert.equal((await fetch(`${base}/docs`)).status, 404);
    assert.equal((await fetch(`${base}/mcp`, {method:'POST'})).status, 401);
    assert.equal((await fetch(`${base}/health/live?secret=hidden`)).status, 200);
    const untrustedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(`${base}/health/live`, {headers:{host:'untrusted.example'}}, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(untrustedHostStatus, 403);
    assert.equal((await fetch(`${base}/health/live`, {headers:{origin:'https://untrusted.example'}})).status, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {requestInit:{headers:{authorization}}}));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), ['list_repositories','get_repository_status','codegraph_explore']);
    const listing = await client.callTool({name:'list_repositories',arguments:{}});
    assert.match(JSON.stringify(listing), /Repo/);
    const query = await client.callTool({name:'codegraph_explore',arguments:{repo_id:'repo1',query:'x'}});
    assert.match(JSON.stringify(query), /source-result/);
    assert.doesNotMatch(JSON.stringify(query), /projectPath|internal-token|Bearer/);
    assert.ok(requests.filter(request => request.op !== 'probe').every(request => request.authorization === authorization));
    const started = new Promise<void>(resolve => { began = resolve; });
    const pending = client.callTool({name:'codegraph_explore',arguments:{repo_id:'repo1',query:'wait'}});
    await started; permitted = false; release!();
    const revoked = await pending;
    assert.equal(revoked.isError, true);
    assert.doesNotMatch(JSON.stringify(revoked), /source-result/);
    available = false;
    assert.equal((await fetch(`${base}/health/ready`)).status, 503);
    assert.equal((await fetch(`${base}/mcp`, {method:'POST',headers:{authorization}})).status, 503);
    assert.ok(accessLog.some(event => event.route === '/mcp' && event.status === 401));
    assert.ok(accessLog.some(event => event.route === '/mcp' && event.status === 503));
    assert.ok(accessLog.every(event => event.duration_ms >= 0));
    const text = JSON.stringify(accessLog);
    for (const value of [authorization, serviceToken, 'source-result', 'secret=hidden']) assert.ok(!text.includes(value));
  } finally {
    await client.close().catch(() => {});
    await app.close();
    await new Promise<void>((resolve, reject) => rpc.close(error => error ? reject(error) : resolve()));
    await rm(directory, {recursive:true,force:true});
  }
});

test('Unix RPC fails closed on malformed response, wrong token and cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codeharbor-mcp-rpc-'));
  const socketPath = join(directory, 'mcp.sock');
  const rpc = net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', bytes => {
      const request = JSON.parse(bytes.toString()) as Record<string, unknown>;
      if (request.op === 'explore') return;
      if (request.token !== serviceToken) socket.end('{"ok":false}\n');
      else socket.end('{"ok":true,"result":{"repo_id":"x","projectPath":"/secret"}}\n');
    });
  });
  rpc.listen(socketPath); await once(rpc, 'listening');
  try {
    const backend = new SocketMcpBackend(socketPath, serviceToken, 1000);
    await assert.rejects(backend.get(authorization, 'x'), /Invalid repository response/);
    await assert.rejects(new SocketMcpBackend(socketPath, 'wrong-token-0000000000000000000000000').authenticate(authorization));
    const abort = new AbortController();
    const pending = backend.explore(authorization, 'x', 'test', abort.signal);
    abort.abort();
    await assert.rejects(pending, /cancelled/);
  } finally {
    await new Promise<void>((resolve, reject) => rpc.close(error => error ? reject(error) : resolve()));
    await rm(directory, {recursive:true,force:true});
  }
});

test('unexpected MCP response failures close the request and leave the listener usable', { timeout: 5000 }, async () => {
  const allowedHosts = ['placeholder'];
  let injectedResponse: ServerResponse | undefined;
  let handlerEntered = false;
  const app = createMcpService({ backend: {
    async authenticate() {
      // Authentication is reached only after the service Host check, so this
      // exception is injected within the asynchronous MCP handler itself.
      handlerEntered = true;
      assert.ok(injectedResponse);
      injectedResponse.writeHead = (() => { throw new Error('simulated response failure'); }) as typeof injectedResponse.writeHead;
      return false;
    },
  } as never, allowedHosts });
  app.server.prependListener('request', (req, res) => {
    if (req.url === '/mcp') injectedResponse = res;
  });
  await app.listen({port:0,host:'127.0.0.1'});
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  allowedHosts.push(`127.0.0.1:${address.port}`);
  try {
    const base = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(`${base}/mcp`, {method:'POST', headers:{authorization}, timeout:2000}, res => {
        res.resume(); reject(new Error(`Unexpected response status ${res.statusCode}`));
      });
      req.once('error', error => error.message.includes('socket hang up') ? resolve() : reject(error));
      req.once('timeout', () => req.destroy(new Error('Request timed out')));
      req.end();
    });
    assert.equal(handlerEntered, true);
    assert.equal((await fetch(`${base}/health/live`)).status, 200);
  } finally { app.server.closeAllConnections(); await app.close(); }
});
