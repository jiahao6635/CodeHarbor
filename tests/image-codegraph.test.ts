import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  IMAGE_PROJECT_PATH,
  ImageCodeGraphClient,
  type ImageQueryBackend,
  parseImageReference,
} from '../src/image-codegraph.js';
import { ImageRuntimeCancelledError, ImageRuntimeRequestError } from '../src/image-runtime-errors.js';

const digest = `sha256:${'a'.repeat(64)}` as const;
const reference = `oci://${digest}`;
const identity = { repoId: 'repo_1', commit: 'd'.repeat(40) };

function backend(overrides: Partial<ImageQueryBackend> = {}): ImageQueryBackend {
  return { explore: async () => 'result', probe: async () => {}, close: async () => {}, ...overrides };
}

test('only immutable image references can reach the restricted runtime', async () => {
  const requests: Parameters<ImageQueryBackend['explore']>[0][] = [];
  const client = new ImageCodeGraphClient(
    backend({
      explore: async (request) => {
        requests.push(request);
        return `${request.projectPath}/a.ts ${reference}`;
      },
    }),
  );
  assert.equal(parseImageReference(reference), digest);
  const result = await client.withQuery((explore) => explore(reference, 'find a', undefined, identity));
  assert.equal(result, '[repository]/a.ts [repository]');
  assert.equal(requests[0].digest, digest);
  assert.equal(requests[0].projectPath, IMAGE_PROJECT_PATH);
  assert.equal(requests[0].readOnlyRoot, true);
  assert.equal(requests[0].repoId, identity.repoId);
  assert.equal(requests[0].commit, identity.commit);
  await assert.rejects(
    client.withQuery((explore) => explore(reference, 'find a')),
    /identity required/,
  );
  for (const bad of ['latest', '/workspace/repo', `oci://${digest}/other`, `oci://sha256:${'A'.repeat(64)}`]) {
    await assert.rejects(
      client.withQuery((explore) => explore(bad, 'find a', undefined, identity)),
      /Invalid repository image reference/,
    );
  }
  assert.equal(requests.length, 1);
});

test('publication drains queries and closes handles before and after switching', async () => {
  const events: string[] = [];
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const client = new ImageCodeGraphClient(
    backend({
      explore: async () => {
        events.push('query-start');
        entered();
        await waiting;
        events.push('query-end');
        return 'ok';
      },
      close: async () => {
        events.push('close');
      },
    }),
    undefined,
    2,
  );
  const query = client.withQuery((explore) => explore(reference, 'symbol', undefined, identity));
  await started;
  const publish = client.withExclusive(async () => {
    events.push('publish');
  });
  release();
  await Promise.all([query, publish]);
  assert.deepEqual(events, ['query-start', 'query-end', 'close', 'publish', 'close']);
});

test('different repositories query concurrently with a bounded, fair publication queue', async () => {
  const events: string[] = [];
  let release!: () => void;
  let bothEntered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    bothEntered = resolve;
  });
  let active = 0;
  let maxActive = 0;
  const client = new ImageCodeGraphClient(
    backend({
      explore: async ({ repoId }) => {
        events.push(`start:${repoId}`);
        maxActive = Math.max(maxActive, ++active);
        if (active === 2) bothEntered();
        await gate;
        active--;
        events.push(`end:${repoId}`);
        return 'ok';
      },
      close: async () => {
        events.push('close');
      },
    }),
    undefined,
    2,
  );
  const run = (id: string) =>
    client.withQuery((explore) => explore(reference, 'symbol', undefined, { ...identity, repoId: id }));
  const first = run('repo_1');
  const second = run('repo_2');
  await started;
  const publish = client.withExclusive(async () => {
    events.push('publish');
  });
  const third = run('repo_3');
  assert.equal(maxActive, 2);
  assert.ok(!events.includes('start:repo_3'));
  release();
  await Promise.all([first, second, publish, third]);
  assert.ok(events.indexOf('publish') > events.indexOf('end:repo_1'));
  assert.ok(events.indexOf('publish') > events.indexOf('end:repo_2'));
  assert.ok(events.indexOf('start:repo_3') > events.indexOf('publish'));
  assert.equal(maxActive, 2);
});

test('default and custom concurrency limits bound simultaneous queries', async () => {
  for (const limit of [10, 3]) {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const full = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const instance = backend({
      explore: async () => {
        started++;
        active++;
        maxActive = Math.max(maxActive, active);
        if (active === limit) entered();
        await gate;
        active--;
        return 'ok';
      },
    });
    const client =
      limit === 10 ? new ImageCodeGraphClient(instance) : new ImageCodeGraphClient(instance, undefined, limit);
    const requests = Array.from({ length: limit + 1 }, (_, index) =>
      client.withQuery((explore) => explore(reference, 'symbol', undefined, { ...identity, repoId: `repo_${index}` })),
    );
    await full;
    assert.equal(started, limit);
    release();
    await Promise.all(requests);
    assert.equal(maxActive, limit);
    assert.equal(started, limit + 1);
  }
  for (const invalid of [0, 33, 1.5, Number.NaN]) {
    assert.throws(() => new ImageCodeGraphClient(backend(), undefined, invalid), /concurrency/i);
  }
});

test('a confirmed cancellation does not drain another repository query', async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let closes = 0;
  const client = new ImageCodeGraphClient(
    backend({
      explore: async ({ repoId }) => {
        if (repoId === 'repo_1') {
          await entered;
          throw new ImageRuntimeRequestError('cancelled after cleanup');
        }
        started();
        await gate;
        return 'unaffected';
      },
      close: async () => {
        closes++;
      },
    }),
  );
  const first = client.withQuery((explore) => explore(reference, 'symbol', undefined, identity));
  const second = client.withQuery((explore) =>
    explore(reference, 'symbol', undefined, { ...identity, repoId: 'repo_2' }),
  );
  await assert.rejects(first, /cancelled/);
  assert.equal(closes, 0);
  release();
  assert.equal(await second, 'unaffected');
});

test('a cancelled queued query releases its place without starting a container', async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const both = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let count = 0;
  const seen: string[] = [];
  const client = new ImageCodeGraphClient(
    backend({
      explore: async ({ repoId }) => {
        seen.push(repoId);
        if (++count === 2) entered();
        await gate;
        return 'ok';
      },
    }),
    undefined,
    2,
  );
  const run = (repoId: string, signal?: AbortSignal) =>
    client.withQuery((explore) => explore(reference, 'symbol', signal, { ...identity, repoId }), signal);
  const first = run('repo_1');
  const second = run('repo_2');
  await both;
  const abort = new AbortController();
  const waiting = run('cancelled', abort.signal);
  abort.abort();
  await assert.rejects(waiting, /cancelled/);
  const third = run('repo_3');
  release();
  await Promise.all([first, second, third]);
  assert.ok(!seen.includes('cancelled'));
  assert.ok(seen.includes('repo_3'));
});

test('cancelled health checks leave no backlog and a full read queue cannot reject publication', async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const both = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let started = 0;
  let probes = 0;
  let published = false;
  const client = new ImageCodeGraphClient(
    backend({
      explore: async () => {
        if (++started === 2) entered();
        await gate;
        return 'ok';
      },
      probe: async () => {
        probes++;
      },
    }),
    undefined,
    2,
  );
  const run = () => client.withQuery((explore) => explore(reference, 'symbol', undefined, identity));
  const active = [run(), run()];
  await both;
  const abort = new AbortController();
  const readiness = client.probe(abort.signal);
  abort.abort();
  await assert.rejects(readiness, /cancelled/);
  assert.equal(probes, 0);
  const waiting = Array.from({ length: 64 }, () => run());
  await assert.rejects(run(), /queue is full/);
  const publication = client.withExclusive(async () => {
    published = true;
  });
  release();
  await Promise.all([...active, ...waiting, publication]);
  assert.equal(published, true);
  assert.equal(probes, 0);
});

test('confirmed cancellation finishes before a waiting publication', async () => {
  const events: string[] = [];
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const client = new ImageCodeGraphClient(
    backend({
      explore: async ({ signal }) => {
        events.push('query');
        entered();
        return await new Promise<string>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new ImageRuntimeCancelledError()), { once: true }),
        );
      },
      close: async () => {
        events.push('close');
      },
    }),
  );
  const abort = new AbortController();
  const running = client.withQuery((explore) => explore(reference, 'symbol', abort.signal, identity));
  await started;
  const next = client.withExclusive(async () => {
    events.push('publish');
  });
  abort.abort();
  await assert.rejects(running);
  await next;
  assert.deepEqual(events, ['query', 'close', 'publish', 'close']);
});

test('failed cleanup permanently fails closed until the process is restarted', async () => {
  let queries = 0;
  const client = new ImageCodeGraphClient(
    backend({
      explore: async () => {
        queries++;
        throw new Error('query failed');
      },
      close: async () => {
        throw new Error('cannot stop container');
      },
    }),
  );
  await assert.rejects(
    client.withQuery((explore) => explore(reference, 'symbol', undefined, identity)),
    /shutdown failed/,
  );
  await assert.rejects(
    client.withQuery((explore) => explore(reference, 'symbol', undefined, identity)),
    /restart required/,
  );
  assert.equal(queries, 1);
});

test('overlarge upstream responses are discarded and cleaned up', async () => {
  let closed = 0;
  const client = new ImageCodeGraphClient(
    backend({
      explore: async () => 'x'.repeat(1024 * 1024 + 1),
      close: async () => {
        closed++;
      },
    }),
  );
  await assert.rejects(
    client.withQuery((explore) => explore(reference, 'symbol', undefined, identity)),
    /Invalid image query result/,
  );
  assert.equal(closed, 1);
});
