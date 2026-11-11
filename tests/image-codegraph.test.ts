import { strict as assert } from 'node:assert';
import test from 'node:test';
import { ImageCodeGraphClient, IMAGE_PROJECT_PATH, parseImageReference, type ImageQueryBackend } from '../src/image-codegraph.js';

const digest = `sha256:${'a'.repeat(64)}` as const;
const reference = `oci://${digest}`;
const identity = { repoId: 'repo_1', commit: 'd'.repeat(40) };

function backend(overrides: Partial<ImageQueryBackend> = {}): ImageQueryBackend {
  return { explore: async () => 'result', probe: async () => {}, close: async () => {}, ...overrides };
}

test('only immutable image references can reach the restricted runtime', async () => {
  const requests: Parameters<ImageQueryBackend['explore']>[0][] = [];
  const client = new ImageCodeGraphClient(backend({ explore: async (request) => {
    requests.push(request); return `${request.projectPath}/a.ts ${reference}`;
  } }));
  assert.equal(parseImageReference(reference), digest);
  const result = await client.withQuery((explore) => explore(reference, 'find a', undefined, identity));
  assert.equal(result, '[repository]/a.ts [repository]');
  assert.equal(requests[0].digest, digest);
  assert.equal(requests[0].projectPath, IMAGE_PROJECT_PATH);
  assert.equal(requests[0].readOnlyRoot, true);
  assert.equal(requests[0].repoId, identity.repoId);
  assert.equal(requests[0].commit, identity.commit);
  await assert.rejects(client.withQuery((explore) => explore(reference, 'find a')), /identity required/);
  for (const bad of ['latest', '/workspace/repo', `oci://${digest}/other`, `oci://sha256:${'A'.repeat(64)}`]) {
    await assert.rejects(client.withQuery((explore) => explore(bad, 'find a', undefined, identity)), /Invalid repository image reference/);
  }
  assert.equal(requests.length, 1);
});

test('publication drains queries and closes handles before and after switching', async () => {
  const events: string[] = [];
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const client = new ImageCodeGraphClient(backend({
    explore: async () => { events.push('query-start'); entered(); await waiting; events.push('query-end'); return 'ok'; },
    close: async () => { events.push('close'); },
  }));
  const query = client.withQuery((explore) => explore(reference, 'symbol', undefined, identity));
  await started;
  const publish = client.withExclusive(async () => { events.push('publish'); });
  release();
  await Promise.all([query, publish]);
  assert.deepEqual(events, ['query-start', 'query-end', 'close', 'publish', 'close']);
});

test('cancellation closes the runtime before a later query can run', async () => {
  const events: string[] = [];
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const client = new ImageCodeGraphClient(backend({
    explore: async ({ signal }) => {
      events.push('query'); entered();
      return await new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
    close: async () => { events.push('close'); },
  }));
  const abort = new AbortController();
  const running = client.withQuery((explore) => explore(reference, 'symbol', abort.signal, identity));
  await started;
  const next = client.withExclusive(async () => { events.push('publish'); });
  abort.abort();
  await assert.rejects(running);
  await next;
  assert.deepEqual(events, ['query', 'close', 'close', 'publish', 'close']);
});

test('failed cleanup permanently fails closed until the process is restarted', async () => {
  let queries = 0;
  const client = new ImageCodeGraphClient(backend({
    explore: async () => { queries++; throw new Error('query failed'); },
    close: async () => { throw new Error('cannot stop container'); },
  }));
  await assert.rejects(client.withQuery((explore) => explore(reference, 'symbol', undefined, identity)), /shutdown failed/);
  await assert.rejects(client.withQuery((explore) => explore(reference, 'symbol', undefined, identity)), /restart required/);
  assert.equal(queries, 1);
});

test('overlarge upstream responses are discarded and cleaned up', async () => {
  let closed = 0;
  const client = new ImageCodeGraphClient(backend({ explore: async () => 'x'.repeat(1024 * 1024 + 1), close: async () => { closed++; } }));
  await assert.rejects(client.withQuery((explore) => explore(reference, 'symbol', undefined, identity)), /Invalid image query result/);
  assert.equal(closed, 1);
});
