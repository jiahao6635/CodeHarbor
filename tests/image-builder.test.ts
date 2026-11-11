import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRepositoryImage, type RepositoryImageRequest } from '../src/image-builder.js';

const generation = '53cae6f9-cb91-4f03-9615-ce744a6046cf';
const commit = 'a'.repeat(40);
const runtimeImage = `sha256:${'b'.repeat(64)}` as const;
const resultImage = `sha256:${'c'.repeat(64)}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codeharbor-image-test-'));
  const generationDir = join(root, 'repositories', 'repo-1', 'versions', generation);
  const worktree = join(generationDir, 'worktree');
  await mkdir(join(worktree, '.git'), { recursive: true });
  await mkdir(join(worktree, 'nested', '.git'), { recursive: true });
  await mkdir(join(worktree, '.codegraph'), { recursive: true });
  await writeFile(join(generationDir, '.codeharbor-generation.json'), JSON.stringify({ version: 1, repositoryId: 'repo-1', generation }));
  await writeFile(join(worktree, '.git', 'config'), 'credential-DO-NOT-COPY');
  await writeFile(join(worktree, 'nested', '.git', 'config'), 'credential-DO-NOT-COPY');
  await writeFile(join(worktree, 'main.ts'), 'export const answer = 42;\n');
  await writeFile(join(worktree, 'Dockerfile'), 'RUN echo should-never-be-executed\n');
  await writeFile(join(worktree, '.dockerignore'), '**\n');
  const db = new DatabaseSync(join(worktree, '.codegraph', 'codegraph.db'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE markers (content TEXT); INSERT INTO markers VALUES (\'from WAL\')');
  const request: RepositoryImageRequest = { dataDir: root, repositoryId: 'repo-1', candidate: { path: worktree, generation, commit }, runtimeImage };
  return { root, worktree, db, request };
}

test('build packages a consistent SQLite snapshot without Git metadata and returns an immutable image ID', async () => {
  const f = await fixture();
  let contextPath = '';
  try {
    const result = await buildRepositoryImage(f.request, async (context, iidFile, tag) => {
      contextPath = context;
      assert.match(tag, /^codeharbor-repo:[0-9a-f]{20}-[0-9a-f-]+$/);
      assert.match(await readFile(join(context, 'Dockerfile'), 'utf8'), /^FROM sha256:[0-9a-f]{64}\nCOPY --chown=1000:1000 repo \/workspace\/repo/m);
      assert.ok(!(await readFile(join(context, 'Dockerfile'), 'utf8')).includes('should-never-be-executed'));
      assert.equal(await readFile(join(context, 'repo', 'Dockerfile'), 'utf8'), 'RUN echo should-never-be-executed\n');
      await assert.rejects(lstat(join(context, '.dockerignore')), { code: 'ENOENT' });
      assert.equal(await readFile(join(context, 'repo', 'main.ts'), 'utf8'), 'export const answer = 42;\n');
      await assert.rejects(lstat(join(context, 'repo', '.git')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(context, 'repo', 'nested', '.git')), { code: 'ENOENT' });
      assert.equal(await readFile(join(context, 'repo', '.codegraph', '.gitignore'), 'utf8'), '*\n');
      await assert.rejects(lstat(join(context, 'repo', '.codegraph', 'codegraph.db-wal')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(context, 'repo', '.codegraph', 'codegraph.db-shm')), { code: 'ENOENT' });
      const snapshot = new DatabaseSync(join(context, 'repo', '.codegraph', 'codegraph.db'), { readOnly: true });
      assert.equal(snapshot.prepare('SELECT content FROM markers').get()?.content, 'from WAL');
      assert.equal(snapshot.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
      snapshot.close();
      await writeFile(iidFile, resultImage);
    });
    assert.deepEqual(result, { image: `oci://${resultImage}`, commit, repositoryId: 'repo-1', codegraphVersion: '1.6.2' });
    await assert.rejects(lstat(contextPath), { code: 'ENOENT' });
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('rejects traversal, changed ownership, symbolic links and malformed image IDs', async () => {
  const f = await fixture();
  try {
    const never = async () => { throw new Error('must not invoke builder'); };
    await assert.rejects(buildRepositoryImage({ ...f.request, candidate: { ...f.request.candidate, path: join(f.root, 'other') } }, never), { code: 'UNSAFE_TREE' });
    await assert.rejects(buildRepositoryImage({ ...f.request, runtimeImage: 'sha256:bad' }, never), { code: 'INVALID_ARGUMENT' });
    const marker = join(f.root, 'repositories', 'repo-1', 'versions', generation, '.codeharbor-generation.json');
    await writeFile(marker, JSON.stringify({ version: 1, repositoryId: 'other', generation }));
    await assert.rejects(buildRepositoryImage(f.request, never), { code: 'UNSAFE_TREE' });
    await writeFile(marker, JSON.stringify({ version: 1, repositoryId: 'repo-1', generation }));
    await symlink('/etc/passwd', join(f.worktree, 'unsafe'));
    await assert.rejects(buildRepositoryImage(f.request, never), { code: 'UNSAFE_TREE' });
    await rm(join(f.worktree, 'unsafe'));
    await assert.rejects(buildRepositoryImage(f.request, async (_context, iidFile) => { await writeFile(iidFile, 'not-an-image'); }), { code: 'BUILD_FAILED' });
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('builder failure returns a sanitized error and removes its temporary context', async () => {
  const f = await fixture();
  let contextPath = '';
  try {
    await assert.rejects(buildRepositoryImage(f.request, async context => {
      contextPath = context;
      throw new Error('sensitive builder output');
    }), (error: Error) => !error.message.includes('sensitive') && error.message === 'Repository image could not be built');
    await assert.rejects(lstat(contextPath), { code: 'ENOENT' });
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('rejects source size and depth before invoking the image builder', async () => {
  const f = await fixture();
  try {
    const never = async () => { throw new Error('must not invoke builder'); };
    const large = await open(join(f.worktree, 'large.bin'), 'w');
    await large.truncate(512 * 1024 * 1024 + 1); await large.close();
    await assert.rejects(buildRepositoryImage(f.request, never), { code: 'CONTEXT_TOO_LARGE' });
    await rm(join(f.worktree, 'large.bin'));
    let nested = f.worktree;
    for (let i = 0; i < 66; i++) { nested = join(nested, 'd'); await mkdir(nested); }
    await assert.rejects(buildRepositoryImage(f.request, never), { code: 'CONTEXT_TOO_LARGE' });
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});
