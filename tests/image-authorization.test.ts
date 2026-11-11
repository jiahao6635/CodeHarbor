import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StoreBackend } from '../src/async-store.js';
import type { ImageIndexPipeline } from '../src/image-indexer.js';
import { imageAuthorization } from '../src/image-authorization.js';

const digest = `sha256:${'a'.repeat(64)}` as const;
const commit = 'b'.repeat(40);

test('image authorization binds the published or active candidate to its repository and commit', async () => {
  let published = true; let running = false; let credentialVersion = 1;
  const store = {
    async getRepository(id: string) { return id === 'repo-1' ? { status: 'ready', path: published ? `oci://${digest}` : '/old', commit, sync_owner: 'owner', sync_credential_version: 1 } : undefined; },
    async getUser() { return { credential_version: credentialVersion }; },
    async listJobs() { return running ? [{ status: 'running' }] : []; },
  } as unknown as StoreBackend;
  const pipeline = { isCandidate: (ref: string, id: string, rev: string) => ref === `oci://${digest}` && id === 'repo-1' && rev === commit } as ImageIndexPipeline;
  const authorize = imageAuthorization(store, pipeline);
  assert.equal(await authorize(digest, 'repo-1', commit), true);
  assert.equal(await authorize(digest, 'repo-2', commit), false);
  assert.equal(await authorize(digest, 'repo-1', 'c'.repeat(40)), false);
  published = false;
  assert.equal(await authorize(digest, 'repo-1', commit), false);
  running = true;
  assert.equal(await authorize(digest, 'repo-1', commit), true);
  credentialVersion = 2;
  assert.equal(await authorize(digest, 'repo-1', commit), false);
});
