import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { CodeGraphToolCall } from '../src/codegraph-tools.js';
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

const toolCalls: CodeGraphToolCall[] = [
  { name: 'codegraph_search', arguments: { query: 'auth', kind: 'function', limit: 7 } },
  { name: 'codegraph_callers', arguments: { symbol: 'login', file: 'src/auth.ts', limit: 8 } },
  { name: 'codegraph_callees', arguments: { symbol: 'login', file: 'src/auth.ts', limit: 9 } },
  { name: 'codegraph_impact', arguments: { symbol: 'login', file: 'src/auth.ts', depth: 3 } },
  { name: 'codegraph_node', arguments: { symbol: 'login', file: 'src/auth.ts', includeCode: true, line: 20 } },
  { name: 'codegraph_node', arguments: { file: 'src/auth.ts', offset: 10, limit: 12, symbolsOnly: false } },
  { name: 'codegraph_explore', arguments: { query: 'auth login', maxFiles: 6 } },
  {
    name: 'codegraph_files',
    arguments: { path: 'src', pattern: '**/*.ts', format: 'flat', includeMetadata: false, maxDepth: 4 },
  },
];

test('image client forwards every tool argument with immutable identity and sanitizes every result', async () => {
  const requests: unknown[] = [];
  const client = new ImageCodeGraphClient(
    backend({
      callTool: async (request) => {
        requests.push(request.call);
        assert.equal(request.digest, digest);
        assert.equal(request.repoId, identity.repoId);
        assert.equal(request.commit, identity.commit);
        assert.equal(request.projectPath, IMAGE_PROJECT_PATH);
        assert.equal(request.readOnlyRoot, true);
        return `${IMAGE_PROJECT_PATH}/src/auth.ts ${reference}`;
      },
      explore: async () => {
        throw new Error('legacy path must not drop arguments');
      },
    }),
  );
  for (const call of toolCalls) {
    assert.equal(
      await client.withToolQuery((query) => query(reference, call, undefined, identity)),
      '[repository]/src/auth.ts [repository]',
    );
  }
  await client.withQuery((explore) => explore(reference, 'legacy', undefined, identity));
  assert.deepEqual(requests, [...toolCalls, { name: 'codegraph_explore', arguments: { query: 'legacy' } }]);
});

test('invalid image tool names, injected paths and arguments never reach the backend or fence it', async () => {
  let calls = 0;
  let closes = 0;
  const client = new ImageCodeGraphClient(
    backend({
      callTool: async () => {
        calls++;
        return 'ok';
      },
      close: async () => {
        closes++;
      },
    }),
  );
  const invalid = [
    { name: 'codegraph_status', arguments: {} },
    { name: 'shell', arguments: {} },
    { name: 'codegraph_explore', arguments: { query: 'auth', projectPath: IMAGE_PROJECT_PATH } },
    { name: 'codegraph_explore', arguments: { query: 'auth', other: true } },
    { name: 'codegraph_explore', arguments: { query: 'auth', maxFiles: 0 } },
    { name: 'codegraph_search', arguments: { query: 'auth', limit: 1.5 } },
    { name: 'codegraph_node', arguments: {} },
    { name: 'codegraph_node', arguments: { file: '../secret' } },
    { name: 'codegraph_callers', arguments: { symbol: 'auth', file: '/etc/passwd' } },
    { name: 'codegraph_files', arguments: { path: 'src/../../secret' } },
    { name: 'codegraph_files', arguments: { pattern: '..\\secret' } },
  ];
  for (const call of invalid) {
    await assert.rejects(
      client.withToolQuery((query) => query(reference, call as CodeGraphToolCall, undefined, identity)),
      /Invalid CodeGraph tool call/,
    );
  }
  await assert.rejects(
    client.withToolQuery((query) => query('/tmp/repo', toolCalls[0], undefined, identity)),
    /Invalid repository image reference/,
  );
  await assert.rejects(
    client.withToolQuery((query) => query(reference, toolCalls[0])),
    /identity required/,
  );
  assert.equal(calls, 0);
  assert.equal(closes, 0);
  assert.equal(client.isUnsafe(), false);
});

test('legacy image adapters support query-only explore and reject rather than drop new arguments', async () => {
  const queries: string[] = [];
  const client = new ImageCodeGraphClient(
    backend({
      explore: async ({ query }) => {
        queries.push(query);
        return 'ok';
      },
    }),
  );
  assert.equal(
    await client.withToolQuery((query) =>
      query(reference, { name: 'codegraph_explore', arguments: { query: 'legacy' } }, undefined, identity),
    ),
    'ok',
  );
  for (const call of toolCalls) {
    await assert.rejects(
      client.withToolQuery((query) => query(reference, call, undefined, identity)),
      /does not support/,
    );
  }
  await assert.rejects(
    client.withQuery((explore) =>
      explore(reference, { query: 'legacy', maxFiles: 2 } as unknown as string, undefined, identity),
    ),
    /Invalid query/,
  );
  assert.deepEqual(queries, ['legacy']);
  assert.equal(client.isUnsafe(), false);
});

test('tool cancellation inherits the operation signal and holds the shared lock until cleanup before publication', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cleanup!: () => void;
  const cleanupGate = new Promise<void>((resolve) => {
    cleanup = resolve;
  });
  let aborted!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const events: string[] = [];
  const client = new ImageCodeGraphClient(
    backend({
      callTool: async ({ signal }) => {
        entered();
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted();
              resolve();
            },
            { once: true },
          ),
        );
        await cleanupGate;
        events.push('cleaned');
        throw new ImageRuntimeCancelledError();
      },
      close: async () => {
        events.push('close');
      },
      explore: async () => {
        events.push('legacy');
        return 'ok';
      },
    }),
    undefined,
    1,
  );
  const controller = new AbortController();
  const pending = client.withToolQuery(
    (query) => query(reference, toolCalls[0], undefined, identity),
    controller.signal,
  );
  const rejected = assert.rejects(pending, ImageRuntimeCancelledError);
  await started;
  const publication = client.withExclusive(async () => {
    events.push('publish');
  });
  controller.abort();
  await cancelled;
  assert.deepEqual(events, []);
  cleanup();
  await rejected;
  await publication;
  assert.deepEqual(events, ['cleaned', 'close', 'publish', 'close']);
  assert.equal(client.isUnsafe(), false);
});

test('uncertain tool cleanup and oversized tool responses fence the same image runtime', async () => {
  for (const oversized of [false, true]) {
    let closes = 0;
    const client = new ImageCodeGraphClient(
      backend({
        callTool: async () => {
          if (!oversized) throw new Error('transport lost');
          return 'x'.repeat(1024 * 1024 + 1);
        },
        close: async () => {
          closes++;
        },
      }),
    );
    await assert.rejects(
      client.withToolQuery((query) => query(reference, toolCalls[0], undefined, identity)),
      oversized ? /Invalid image query result/ : /transport lost/,
    );
    assert.equal(closes, 1);
    assert.equal(client.isUnsafe(), true);
    await assert.rejects(
      client.withQuery((explore) => explore(reference, 'legacy', undefined, identity)),
      /restart required/,
    );
  }
});
