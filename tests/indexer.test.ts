import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildIndexCandidate, verifyPushWebhook } from '../src/indexer.js';

test('Codeup webhooks authenticate and distinguish branches and deletions', () => {
  const base = {
    token: 'hook-secret', expectedToken: 'hook-secret', event: 'Push Hook',
    codeupRepositoryId: '123', branch: 'main',
    body: { object_kind: 'push', project_id: 123, ref: 'refs/heads/main', after: 'a'.repeat(40) },
  };
  assert.equal(verifyPushWebhook(base), 'enqueue');
  assert.equal(verifyPushWebhook({ ...base, body: { ...base.body, after: '0'.repeat(40) } }), 'branch_deleted');
  assert.equal(verifyPushWebhook({ ...base, body: { ...base.body, ref: 'refs/heads/other' } }), 'ignore');
  assert.throws(() => verifyPushWebhook({ ...base, token: 'wrong' }), { code: 'INVALID_WEBHOOK_TOKEN' });
  assert.throws(() => verifyPushWebhook({ ...base, body: { ...base.body, project_id: 124 } }), { code: 'INVALID_WEBHOOK' });
});

test('index candidates use allowed HTTPS remotes and reject a changed branch', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'codeharbor-index-test-'));
  const previousPath = process.env.PATH;
  const git = join(tmp, 'git');
  const codegraph = join(tmp, 'codegraph');
  const changed = join(tmp, 'changed');
  const log = join(tmp, 'args.jsonl');
  const commit = 'a'.repeat(40);
  try {
    // Simulate the processes so this test exercises orchestration without a live service.
    await writeFile(git, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if(args.includes('clone')) {
  const target = args.at(-1);
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(target+'/.git');
  fs.writeFileSync(target+'/example.ts', 'export const x = 1');
} else if(args.includes('rev-parse')) console.log('${commit}');
else if(args.includes('ls-remote')) console.log((fs.existsSync(${JSON.stringify(changed)}) ? '${'b'.repeat(40)}' : '${commit}') + '\\trefs/heads/main');
`);
    await writeFile(codegraph, `#!/usr/bin/env node
const fs = require('node:fs');
if(process.argv[2] === 'init') fs.mkdirSync(process.argv[3]+'/.codegraph');
if(process.argv[2] === 'status') console.log(JSON.stringify({initialized:true,index:{state:'complete'},pendingChanges:{added:0,modified:0,removed:0},worktreeMismatch:null}));
`);
    await chmod(git, 0o700);
    await chmod(codegraph, 0o700);
    process.env.PATH = `${tmp}:${previousPath}`;
    const request = {
      dataDir: tmp, repositoryId: 'repo_1', branch: 'main', cloneUrl: 'https://git.example.com/org/repo.git',
      allowedGitHosts: ['git.example.com'], gitUsername: 'user', token: 'private-token', codegraphBin: codegraph,
    };
    const candidate = await buildIndexCandidate(request);
    assert.equal(candidate.commit, commit);
    assert.match(candidate.path, /repo_1\/versions\/.*\/worktree$/);
    assert.ok(!(await readFile(log, 'utf8')).includes('private-token'));
    await writeFile(changed, 'yes');
    await assert.rejects(buildIndexCandidate(request), { code: 'REMOTE_CHANGED' });
    await assert.rejects(buildIndexCandidate({ ...request, cloneUrl: 'https://evil.example.com/x' }), { code: 'INVALID_REMOTE' });
    await assert.rejects(buildIndexCandidate({ ...request, cloneUrl: 'https://user:password@git.example.com/x' }), { code: 'INVALID_REMOTE' });
    await assert.rejects(buildIndexCandidate({ ...request, repositoryId: '../other' }), { code: 'INVALID_REPOSITORY' });
  } finally {
    process.env.PATH = previousPath;
    await rm(tmp, { recursive: true, force: true });
  }
});
