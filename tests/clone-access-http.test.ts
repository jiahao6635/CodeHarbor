import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCloneAccess } from '../src/clone-access.js';
import type { IndexRequest } from '../src/indexer.js';

test('clone authorization interoperates with real git-http-backend and fails closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeharbor-http-auth-test-'));
  const repo = join(root, 'work');
  const originalFetch = globalThis.fetch;
  const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    git(['init', '-b', 'main', repo]);
    writeFileSync(join(repo, 'file.txt'), 'authorized code\n');
    git(['add', 'file.txt'], repo);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'], repo);
    git(['clone', '--bare', repo, join(root, 'repo.git')]);
    const request: IndexRequest = {
      dataDir: root,
      repositoryId: '1',
      branch: 'main',
      cloneUrl: 'https://git.example/repo.git',
      allowedGitHosts: ['git.example'],
      gitUsername: 'alice',
      token: 'test-pat',
    };
    const basic = `Basic ${Buffer.from('alice:test-pat').toString('base64')}`;
    let denyPost = false;
    let modifyResult: (data: Buffer) => Buffer = (data) => data;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.host, 'git.example');
      assert.equal(init?.redirect, 'error');
      if (
        (init?.headers as Record<string, string> | undefined)?.authorization !== basic ||
        (denyPost && init?.method === 'POST')
      )
        return new Response(null, { status: 403 });
      const body = typeof init?.body === 'string' ? init.body : '';
      const result = execFileSync('git', ['http-backend'], {
        input: body,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: init?.method ?? 'GET',
          CONTENT_TYPE: (init?.headers as Record<string, string> | undefined)?.['content-type'] ?? '',
          CONTENT_LENGTH: String(Buffer.byteLength(body)),
        },
      });
      const separator = result.indexOf(Buffer.from('\r\n\r\n'));
      assert.ok(separator >= 0, 'git-http-backend returned CGI headers');
      const headers = new Headers();
      for (const line of result.subarray(0, separator).toString('utf8').split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon > 0 && line.slice(0, colon).toLowerCase() !== 'status')
          headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      const payload = result.subarray(separator + 4);
      return new Response(init?.method === 'POST' ? modifyResult(payload) : payload, { headers });
    }) as typeof fetch;
    assert.equal(await checkCloneAccess(request), true);
    assert.equal(await checkCloneAccess({ ...request, token: 'wrong-pat' }), false);
    denyPost = true;
    assert.equal(await checkCloneAccess(request), false, 'refs are visible but pack download is denied');
    denyPost = false;
    modifyResult = (data) => {
      assert.equal(data.subarray(-4).toString(), '0000');
      const error = Buffer.from([3, ...Buffer.from('late server error')]);
      return Buffer.concat([
        data.subarray(0, -4),
        Buffer.from((error.length + 4).toString(16).padStart(4, '0')),
        error,
        data.subarray(-4),
      ]);
    };
    await assert.rejects(
      checkCloneAccess(request),
      /authorization unavailable/,
      'an error after the pack must fail closed',
    );
    modifyResult = () => Buffer.alloc(32 * 1024 * 1024 + 1);
    await assert.rejects(checkCloneAccess(request), /authorization unavailable/, 'oversize responses must fail closed');
    modifyResult = (data) => data;
    await assert.rejects(checkCloneAccess({ ...request, branch: 'missing' }), /authorization unavailable/);
    globalThis.fetch = (async (_input, init) => {
      assert.equal(init?.redirect, 'error');
      return new Response(null, { status: 302, headers: { location: 'https://attacker.example/' } });
    }) as typeof fetch;
    await assert.rejects(checkCloneAccess(request), /authorization unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('stalled upstream and queued waiters time out and fail closed', async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = globalThis.setTimeout;
  const keepAlive = originalTimeout(() => {}, 500);
  try {
    globalThis.setTimeout = ((handler: (...args: any[]) => void, ms?: number, ...args: any[]) =>
      originalTimeout(handler, ms === 30_000 ? 40 : ms, ...args)) as typeof setTimeout;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })) as typeof fetch;
    const request: IndexRequest = {
      dataDir: '/tmp',
      repositoryId: '1',
      branch: 'main',
      cloneUrl: 'https://git.example/repo.git',
      allowedGitHosts: ['git.example'],
      gitUsername: 'alice',
      token: 'test-pat',
    };
    const first = checkCloneAccess(request);
    const second = checkCloneAccess(request);
    await assert.rejects(checkCloneAccess(request), (error: any) => error.code === 'AUTH_BUSY');
    await Promise.all([
      assert.rejects(first, (error: any) => error.code === 'AUTH_UNAVAILABLE'),
      assert.rejects(second, (error: any) => error.code === 'AUTH_UNAVAILABLE'),
    ]);
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimeout;
  }
});
