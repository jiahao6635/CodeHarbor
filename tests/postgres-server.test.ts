import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { PostgresStore } from '../src/postgres-store.js';
import { createApp } from '../src/server.js';
import { CodeupError } from '../src/codeup.js';

const baseUrl = process.env.CODEHARBOR_TEST_DATABASE_URL;
test('real PostgreSQL-backed HTTP and MCP use case', { skip: !baseUrl, timeout: 30000 }, async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  const dbName = `codeharbor_it_${randomUUID().replaceAll('-', '')}`;
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-pg-http-'));
  let app: ReturnType<typeof createApp> | undefined;
  let store: PostgresStore | undefined;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(baseUrl!); url.pathname = `/${dbName}`;
    store = await PostgresStore.open(url.href);
    const users: Record<string, {id: string, username: string, name: string}> = {
      'alice-test': { id:'alice', username:'alice', name:'Alice' },
      'bob-test': { id:'bob', username:'bob', name:'Bob' },
    };
    const codeup = {
      async getUser(token: string) { if (!users[token]) throw new CodeupError('invalid_credential', 401); return users[token]; },
      async listRepositories(token: string) { if (!users[token]) throw new CodeupError('invalid_credential', 401); return { repositories:[], nextPage:null }; },
      async getRepository(token: string, id: string) {
        if (token !== 'alice-test' || id !== '42') throw new CodeupError('not_found', 404);
        return { id, name:'repo', path:'repo', accessLevel:30, cloneDownloadRestricted:false, httpUrlToRepo:'https://git.example/repo' };
      },
    };
    const graph = {
      async withQuery(fn: (explore: (path: string, query: string) => Promise<string>) => Promise<unknown>) {
        return fn(async () => 'indexed code');
      },
      async close() {}, async probe() {},
    };
    const worker = { start() {}, async stop() {}, kick() {}, async enqueue() { throw new Error('not used'); } };
    const allowedHosts: string[] = [];
    app = createApp({ dataDir:dir, databasePath:join(dir,'unused.sqlite'), credentialKey:randomBytes(32),
      codeupEndpoint:'https://codeup.example', organizationId:'org', allowedGitHosts:['git.example'],
      allowedHosts, writeUsers:['alice'], codegraphBin:'codegraph' },
      { store, codeup:codeup as never, graph:graph as never, worker:worker as never, probe:async () => true });
    await app.listen({port:0, host:'127.0.0.1'});
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    allowedHosts.push(`127.0.0.1:${address.port}`);
    const base = `http://127.0.0.1:${address.port}`;
    async function request(method:string, path:string, token?:string, data?:unknown) {
      const response = await fetch(base+path, { method, headers:{
        ...(token ? { authorization:`Bearer ${token}` } : {}),
        ...(data === undefined ? {} : { 'content-type':'application/json', accept:'application/json, text/event-stream' }),
      }, ...(data === undefined ? {} : { body:JSON.stringify(data) }) });
      return { status:response.status, json:await response.json() as Record<string, any> };
    }
    const bind = await request('POST','/api/v1/auth/yunxiao/bind',undefined,{pat:'alice-test'});
    assert.equal(bind.status,200);
    const auth = await request('POST','/api/v1/auth/bootstrap/keys',bind.json.bootstrap_token,{scope:'write'});
    assert.equal(auth.status,201); const key=auth.json.token;
    const created = await request('POST','/api/v1/repositories',key,{codeup_repository_id:'42', branch:'main', authorize_automatic_sync:true});
    assert.equal(created.status,202);
    assert.equal((await store.getJob(created.json.job_id))?.status,'queued');
    const repoId = created.json.repository.repo_id;
    await store.updateRepository(repoId,{path:'/internal/project',commit:'a'.repeat(40),indexed_at:Date.now(),status:'ready'});
    const mcp = await request('POST','/mcp',key,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'codegraph_explore',arguments:{repo_id:repoId,query:'find code'}}});
    assert.equal(mcp.status,200); assert.match(JSON.stringify(mcp.json),/indexed code/);
    const bindBob = await request('POST','/api/v1/auth/yunxiao/bind',undefined,{pat:'bob-test'});
    const bob = await request('POST','/api/v1/auth/bootstrap/keys',bindBob.json.bootstrap_token,{scope:'read'});
    assert.equal((await request('GET',`/api/v1/repositories/${repoId}`,bob.json.token)).status,404);
    const denied = await request('POST','/mcp',bob.json.token,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'codegraph_explore',arguments:{repo_id:repoId,query:'find code'}}});
    assert.doesNotMatch(JSON.stringify(denied.json),/indexed code/);
    await app.close(); app=undefined; store=undefined;
    const restarted = await PostgresStore.open(url.href);
    try { assert.equal((await restarted.getJob(created.json.job_id))?.status,'queued'); }
    finally { await restarted.close(); }
  } finally {
    if (app) { await app.close(); store=undefined; } else if (store) await store.close();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end(); await rm(dir,{recursive:true,force:true});
  }
});
