import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildIndexCandidate } from '../src/indexer.js';

test('builds a queryable index for a real Git commit with the installed CodeGraph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codeharbor-codegraph-'));
  const previousPath = process.env.PATH;
  const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const repository = join(root, 'source');
  const mockBin = join(root, 'bin');
  const codegraph = resolve('node_modules/.bin/codegraph');
  try {
    await mkdir(repository);
    await mkdir(mockBin);
    execFileSync(git, ['init', '-b', 'main'], { cwd: repository, stdio: 'ignore' });
    await writeFile(join(repository, 'order.ts'), 'export function createOrder() { return 42; }\n');
    execFileSync(git, ['add', '.'], { cwd: repository });
    execFileSync(git, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'], { cwd: repository, stdio: 'ignore' });
    const commit = execFileSync(git, ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    const mockGit = join(mockBin, 'git');
    // Rewrite only the HTTPS test remote to a real local repository.
    await writeFile(mockGit, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2).map(arg => arg === 'https://git.example.com/org/repo.git' ? ${JSON.stringify(repository)} : arg === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : arg);
const result = spawnSync(${JSON.stringify(git)}, args, {stdio: 'inherit', env: process.env});
process.exit(result.status === null ? 1 : result.status);
`);
    await chmod(mockGit, 0o700);
    process.env.PATH = `${mockBin}:${previousPath}`;
    const candidate = await buildIndexCandidate({
      dataDir: join(root, 'data'), repositoryId: 'r1', branch: 'main',
      cloneUrl: 'https://git.example.com/org/repo.git', allowedGitHosts: ['git.example.com'],
      gitUsername: 'test', token: 'test-token', codegraphBin: codegraph, timeoutMs: 60_000,
    });
    assert.equal(candidate.commit, commit);
    const result = execFileSync(codegraph, ['query', 'createOrder', '--json'], {
      cwd: candidate.path, encoding: 'utf8', env: { ...process.env, DO_NOT_TRACK: '1' }, timeout: 60_000,
    });
    assert.match(result, /createOrder/);
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
