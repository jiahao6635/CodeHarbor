import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { GraphClient } from '../src/codegraph.js';
import { ImageIndexPipeline } from '../src/image-indexer.js';
import type { IndexRequest } from '../src/indexer.js';

const digest = `sha256:${'a'.repeat(64)}` as const;
const image = `oci://${digest}` as const;
const commit = 'b'.repeat(40);
const request: IndexRequest = {
  dataDir: '/not-used',
  repositoryId: 'repo-1',
  branch: 'main',
  cloneUrl: 'https://git.example/repo',
  allowedGitHosts: ['git.example'],
  gitUsername: 'user',
  token: 'test-token',
};
const graph: GraphClient = {
  async withQuery(fn) {
    return fn(async (ref, _query, _signal, identity) => {
      assert.equal(ref, image);
      assert.deepEqual(identity, { repoId: request.repositoryId, commit });
      return 'ok';
    });
  },
  async withExclusive(fn) {
    return fn(async () => 'ok');
  },
  async probe() {},
  async close() {},
};

test('image indexing publishes only an image reference and removes the temporary checkout', async () => {
  let temp = '';
  let reconciled: { repositoryId: string; imageIds: string[] } | undefined;
  const pipeline = new ImageIndexPipeline(
    digest,
    graph,
    async (input) => {
      temp = input.dataDir;
      const path = join(temp, 'worktree');
      await mkdir(path);
      await writeFile(join(path, 'source'), 'sample');
      return { path, commit, generation: 'generation-1' };
    },
    async (input) => {
      assert.equal(input.dataDir, temp);
      assert.equal(input.repositoryId, request.repositoryId);
      assert.equal(input.candidate.commit, commit);
      return { image, commit, repositoryId: request.repositoryId, codegraphVersion: '1.6.2' };
    },
    {
      async reconcileRepository(repositoryId, imageIds) {
        reconciled = { repositoryId, imageIds };
      },
    },
  );
  assert.deepEqual(await pipeline.build(request), { path: image, commit, generation: 'generation-1' });
  await assert.rejects(access(temp));
  assert.equal(await pipeline.healthy(request, image, commit), true);
  assert.equal(await pipeline.healthy(request, '/old/worktree', commit), false);
  const previous = `oci://sha256:${'f'.repeat(64)}`;
  await pipeline.release(image, [image, previous]);
  assert.deepEqual(reconciled, {
    repositoryId: request.repositoryId,
    imageIds: [digest, previous.slice('oci://'.length)],
  });
});

test('image indexing removes its temporary checkout when image creation fails', async () => {
  let temp = '';
  const pipeline = new ImageIndexPipeline(
    digest,
    graph,
    async (input) => {
      temp = input.dataDir;
      return { path: join(temp, 'worktree'), commit, generation: 'generation-1' };
    },
    async () => {
      throw new Error('image failure');
    },
  );
  await assert.rejects(pipeline.build(request), /image failure/);
  await assert.rejects(access(temp));
});

test('a runtime outage is not treated as a missing image that should be rebuilt', async () => {
  const unavailable: GraphClient = {
    ...graph,
    async withQuery() {
      throw new Error('runtime unavailable');
    },
  };
  const pipeline = new ImageIndexPipeline(digest, unavailable);
  await assert.rejects(pipeline.healthy(request, image, commit), /runtime unavailable/);
});
