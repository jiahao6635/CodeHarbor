import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCloneAccess } from '../src/clone-access.js';
import type { IndexRequest } from '../src/indexer.js';

function packet(value: Buffer | string): Buffer {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}
const flush = Buffer.from('0000');

test('clone access validates the complete Git pack and the advertised commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codeharbor-auth-test-'));
  const git = (args: string[], options: { input?: string } = {}) => execFileSync('git', args, { cwd: dir, ...options });
  const originalFetch = globalThis.fetch;
  try {
    git(['init', '-b', 'main']);
    writeFileSync(join(dir, 'hello.txt'), 'hello\n');
    git(['add', 'hello.txt']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'test']);
    const commit = git(['rev-parse', 'HEAD']).toString().trim();
    const pack = git(['pack-objects', '--stdout', '--revs'], { input: `${commit}\n` });
    const request: IndexRequest = {
      dataDir: dir,
      repositoryId: '123',
      branch: 'main',
      cloneUrl: 'https://git.example/repo.git',
      allowedGitHosts: ['git.example'],
      gitUsername: 'alice',
      token: 'test-pat',
    };
    const advertisement = Buffer.concat([
      packet('# service=git-upload-pack\n'),
      flush,
      packet(`${commit} refs/heads/main\0shallow side-band-64k\n`),
      flush,
    ]);
    const result = (payload: Buffer) =>
      Buffer.concat([
        packet(`shallow ${commit}\n`),
        flush,
        packet('NAK\n'),
        packet(Buffer.concat([Buffer.from([1]), payload])),
        flush,
      ]);
    let posts = 0;
    function stub(payload: Buffer, postStatus = 200) {
      globalThis.fetch = (async (url, init) => {
        assert.equal(new URL(String(url)).host, 'git.example');
        assert.equal(
          (init?.headers as Record<string, string> | undefined)?.authorization,
          `Basic ${Buffer.from('alice:test-pat').toString('base64')}`,
        );
        if (init?.method === 'POST') {
          posts++;
          return new Response(payload, {
            status: postStatus,
            headers: { 'content-type': 'application/x-git-upload-pack-result' },
          });
        }
        return new Response(advertisement, {
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
        });
      }) as typeof fetch;
    }
    stub(result(pack));
    assert.equal(await checkCloneAccess(request), true);
    assert.equal(posts, 1);
    stub(Buffer.alloc(0), 403);
    assert.equal(await checkCloneAccess(request), false);
    stub(Buffer.concat([packet('NAK\n'), packet(Buffer.from([3, 69, 82, 82])), flush]));
    await assert.rejects(checkCloneAccess(request), /authorization unavailable/);
    stub(Buffer.concat([packet('NAK\n'), packet(Buffer.concat([Buffer.from([1]), pack.subarray(0, 12)])), flush]));
    await assert.rejects(checkCloneAccess(request), /authorization unavailable/);
    const malformed = Buffer.concat([Buffer.from('PACK'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 0])]);
    const validHashButInvalidPack = Buffer.concat([malformed, createHash('sha1').update(malformed).digest()]);
    stub(result(validHashButInvalidPack));
    await assert.rejects(checkCloneAccess(request), /authorization unavailable/);
    const wrongCommit = 'b'.repeat(40);
    const wrongAdvertisement = Buffer.concat([
      packet('# service=git-upload-pack\n'),
      flush,
      packet(`${wrongCommit} refs/heads/main\0shallow side-band-64k\n`),
      flush,
    ]);
    globalThis.fetch = (async (_url, init) =>
      init?.method === 'POST'
        ? new Response(result(pack), { headers: { 'content-type': 'application/x-git-upload-pack-result' } })
        : new Response(wrongAdvertisement, {
            headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
          })) as typeof fetch;
    await assert.rejects(checkCloneAccess(request), /authorization unavailable/);
    await assert.rejects(
      checkCloneAccess({ ...request, cloneUrl: 'https://attacker.example/repo.git' }),
      /authorization unavailable/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
