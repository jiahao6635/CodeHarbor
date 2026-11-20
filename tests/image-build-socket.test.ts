import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Transform } from 'node:stream';
import test from 'node:test';
import * as tar from 'tar-stream';
import { getTrustedImage, SocketImageBuildExecutor, serveImageBuilder } from '../src/image-build-socket.js';
import { buildRepositoryImage, type RepositoryImageRequest } from '../src/image-builder.js';

const generation = '53cae6f9-cb91-4f03-9615-ce744a6046cf';
const runtimeImage = `sha256:${'b'.repeat(64)}` as const;
const imageId = `sha256:${'c'.repeat(64)}`;
const commit = 'a'.repeat(40);
const token = 'test-only-token-'.repeat(3);
const builderUid = process.getuid!();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codeharbor-builder-socket-'));
  const generationDir = join(root, 'data', 'repositories', 'repo-1', 'versions', generation);
  const worktree = join(generationDir, 'worktree');
  await mkdir(join(worktree, '.codegraph'), { recursive: true });
  await writeFile(
    join(generationDir, '.codeharbor-generation.json'),
    JSON.stringify({ version: 1, repositoryId: 'repo-1', generation }),
  );
  await writeFile(join(worktree, 'main.ts'), 'export const answer = 42;\n');
  await writeFile(join(worktree, 'Dockerfile'), 'RUN never-use-this-file\n');
  const db = new DatabaseSync(join(worktree, '.codegraph', 'codegraph.db'));
  db.exec("CREATE TABLE markers (content TEXT); INSERT INTO markers VALUES ('fixture')");
  db.close();
  const request: RepositoryImageRequest = {
    dataDir: join(root, 'data'),
    repositoryId: 'repo-1',
    candidate: { path: worktree, generation, commit },
    runtimeImage,
  };
  return { root, request, socket: join(root, 'builder.sock'), allowlist: join(root, 'allowlist.sqlite') };
}

test('builder socket streams a sanitized context, authorizes the image and persists trust across restart', async () => {
  const f = await fixture();
  let service: Awaited<ReturnType<typeof serveImageBuilder>> | undefined;
  let observed = 0;
  const execute = async (context: string, iidFile: string, tag: string) => {
    observed++;
    assert.match(tag, /^codeharbor-repo:[a-f0-9]{20}-[a-f0-9-]+$/);
    const dockerfile = await readFile(join(context, 'Dockerfile'), 'utf8');
    assert.ok(dockerfile.startsWith(`FROM ${runtimeImage}\n`));
    assert.ok(!dockerfile.includes('never-use-this-file'));
    assert.equal(await readFile(join(context, 'repo', 'main.ts'), 'utf8'), 'export const answer = 42;\n');
    assert.equal((await lstat(join(context, 'repo'))).mode & 0o777, 0o755);
    assert.equal((await lstat(join(context, 'repo', 'main.ts'))).mode & 0o777, 0o644);
    await assert.rejects(lstat(join(context, 'repo', '.git')), { code: 'ENOENT' });
    await writeFile(iidFile, imageId);
  };
  try {
    service = await serveImageBuilder({ path: f.socket, token, runtimeImage, allowlistPath: f.allowlist, execute });
    const client = new SocketImageBuildExecutor({ path: f.socket, token, runtimeImage });
    const result = await buildRepositoryImage(f.request, client.execute);
    assert.equal(result.image, `oci://${imageId}`);
    assert.equal(observed, 1);
    assert.deepEqual(await getTrustedImage(f.allowlist, imageId, builderUid), {
      imageId,
      repositoryId: 'repo-1',
      commit,
      runtimeImage,
    });
    assert.equal(await getTrustedImage(f.allowlist, `sha256:${'d'.repeat(64)}`, builderUid), null);
    await assert.rejects(getTrustedImage(f.allowlist, imageId, builderUid + 1), /(Unsafe|Untrusted) image/);
    assert.equal((await lstat(f.allowlist)).mode & 0o777, 0o640);
    await service.close();
    service = undefined;
    service = await serveImageBuilder({ path: f.socket, token, runtimeImage, allowlistPath: f.allowlist, execute });
    assert.ok(await getTrustedImage(f.allowlist, imageId, builderUid));
  } finally {
    await service?.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('repository reconciliation retains two live generations and retires the obsolete owned image', async () => {
  const f = await fixture();
  const imageIds = ['c', 'd', 'e'].map((value) => `sha256:${value.repeat(64)}`);
  const removed: string[] = [];
  let builds = 0;
  const service = await serveImageBuilder({
    path: f.socket,
    token,
    runtimeImage,
    allowlistPath: f.allowlist,
    execute: async (_context, iidFile) => {
      await writeFile(iidFile, imageIds[builds++]);
    },
    removeImage: async (image) => {
      removed.push(image.imageId);
    },
  });
  try {
    const client = new SocketImageBuildExecutor({ path: f.socket, token, runtimeImage });
    for (const expected of imageIds)
      assert.equal((await buildRepositoryImage(f.request, client.execute)).image, `oci://${expected}`);
    await client.reconcileRepository('repo-1', imageIds.slice(1));
    assert.equal(await getTrustedImage(f.allowlist, imageIds[0], builderUid), null);
    assert.ok(await getTrustedImage(f.allowlist, imageIds[1], builderUid));
    assert.ok(await getTrustedImage(f.allowlist, imageIds[2], builderUid));
    assert.deepEqual(removed, [imageIds[0]]);
  } finally {
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('failed Docker retirement stays untrusted and blocks further Docker work without fencing', async () => {
  const f = await fixture();
  const imageIds = ['c', 'd', 'e', 'f'].map((value) => `sha256:${value.repeat(64)}`);
  let builds = 0;
  const options = {
    path: f.socket,
    token,
    runtimeImage,
    allowlistPath: f.allowlist,
    execute: async (_context: string, iidFile: string) => {
      await writeFile(iidFile, imageIds[builds++]);
    },
    removeImage: async () => {
      throw new Error('injected Docker cleanup failure');
    },
  };
  let service: Awaited<ReturnType<typeof serveImageBuilder>> | undefined;
  try {
    service = await serveImageBuilder(options);
    const client = new SocketImageBuildExecutor({ path: f.socket, token, runtimeImage });
    for (const expected of imageIds.slice(0, 3))
      assert.equal((await buildRepositoryImage(f.request, client.execute)).image, `oci://${expected}`);
    await client.reconcileRepository('repo-1', imageIds.slice(1, 3));
    assert.equal(await getTrustedImage(f.allowlist, imageIds[0], builderUid), null);
    await assert.rejects(buildRepositoryImage(f.request, client.execute));
    assert.equal(builds, 3);
    await service.close();
    service = undefined;
    service = await serveImageBuilder(options);
  } finally {
    await service?.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('capacity rejection happens before Docker work and does not leave a recovery fence', async () => {
  const f = await fixture();
  let calls = 0;
  const options = {
    path: f.socket,
    token,
    runtimeImage,
    allowlistPath: f.allowlist,
    maxTrustedImages: 1,
    maxRepositoryImages: 1,
    execute: async (_context: string, iidFile: string) => {
      calls++;
      await writeFile(iidFile, imageId);
    },
  };
  let service: Awaited<ReturnType<typeof serveImageBuilder>> | undefined;
  try {
    service = await serveImageBuilder(options);
    const client = new SocketImageBuildExecutor({ path: f.socket, token, runtimeImage });
    assert.equal((await buildRepositoryImage(f.request, client.execute)).image, `oci://${imageId}`);
    await assert.rejects(buildRepositoryImage(f.request, client.execute));
    assert.equal(calls, 1);
    await service.close();
    service = undefined;
    service = await serveImageBuilder(options);
    assert.ok(await getTrustedImage(f.allowlist, imageId, builderUid));
  } finally {
    await service?.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('builder rejects incorrect credentials and runtime image without executing Docker', async () => {
  const f = await fixture();
  let called = 0;
  const service = await serveImageBuilder({
    path: f.socket,
    token,
    runtimeImage,
    allowlistPath: f.allowlist,
    execute: async () => {
      called++;
    },
  });
  try {
    const wrong = new SocketImageBuildExecutor({ path: f.socket, token: 'wrong-token-'.repeat(5), runtimeImage });
    await assert.rejects(buildRepositoryImage(f.request, wrong.execute));
    const different = `sha256:${'e'.repeat(64)}` as const;
    const other = new SocketImageBuildExecutor({ path: f.socket, token, runtimeImage: different });
    await assert.rejects(buildRepositoryImage({ ...f.request, runtimeImage: different }, other.execute));
    assert.equal(called, 0);
    assert.equal(await getTrustedImage(f.allowlist, imageId, builderUid), null);
  } finally {
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('builder rejects malicious tar traversal and never records an image', async () => {
  const f = await fixture();
  let called = 0;
  const service = await serveImageBuilder({
    path: f.socket,
    token,
    runtimeImage,
    allowlistPath: f.allowlist,
    execute: async () => {
      called++;
    },
  });
  try {
    const socket = net.createConnection({ path: f.socket, allowHalfOpen: true });
    await new Promise<void>((ok, fail) => {
      socket.once('connect', ok);
      socket.once('error', fail);
    });
    socket.write(`${JSON.stringify({ op: 'build', token, runtimeImage, repositoryId: 'repo-1', commit })}\n`);
    const ack = await new Promise<string>((ok, fail) => {
      socket.once('data', (x) => ok(x.toString()));
      socket.once('error', fail);
    });
    assert.equal(ack, '{"ok":true,"ready":true}\n');
    const result = new Promise<string>((ok, fail) => {
      socket.once('data', (x) => ok(x.toString()));
      socket.once('error', fail);
    });
    const pack = tar.pack();
    const frames = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(chunk.length);
        this.push(header);
        this.push(chunk);
        callback();
      },
      flush(callback) {
        this.push(Buffer.alloc(4));
        callback();
      },
    });
    pack.pipe(frames);
    frames.pipe(socket, { end: false });
    pack.entry({ name: 'repo/../../escaped', type: 'file' }, 'bad');
    pack.finalize();
    assert.equal(await result, '{"ok":false}\n');
    assert.equal(called, 0);
    assert.equal(await getTrustedImage(f.allowlist, imageId, builderUid), null);
    await assert.rejects(lstat(join(f.root, 'escaped')), { code: 'ENOENT' });
  } finally {
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('builder requires the exact platform-generated CodeGraph gitignore', async () => {
  const f = await fixture();
  let called = 0;
  const service = await serveImageBuilder({
    path: f.socket,
    token,
    runtimeImage,
    allowlistPath: f.allowlist,
    execute: async () => {
      called++;
    },
  });
  try {
    for (const gitignore of [undefined, 'x\n', 'secret']) {
      const socket = net.createConnection({ path: f.socket, allowHalfOpen: true });
      await new Promise<void>((ok, fail) => {
        socket.once('connect', ok);
        socket.once('error', fail);
      });
      socket.write(`${JSON.stringify({ op: 'build', token, runtimeImage, repositoryId: 'repo-1', commit })}\n`);
      const ack = await new Promise<string>((ok, fail) => {
        socket.once('data', (x) => ok(x.toString()));
        socket.once('error', fail);
      });
      assert.equal(ack, '{"ok":true,"ready":true}\n');
      const result = new Promise<string>((ok, fail) => {
        socket.once('data', (x) => ok(x.toString()));
        socket.once('error', fail);
      });
      const pack = tar.pack();
      const frames = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          const header = Buffer.alloc(4);
          header.writeUInt32BE(chunk.length);
          this.push(header);
          this.push(chunk);
          callback();
        },
        flush(callback) {
          this.push(Buffer.alloc(4));
          callback();
        },
      });
      pack.pipe(frames);
      frames.pipe(socket, { end: false });
      pack.entry({ name: 'repo/.codegraph/codegraph.db', type: 'file' }, 'test');
      if (gitignore !== undefined) pack.entry({ name: 'repo/.codegraph/.gitignore', type: 'file' }, gitignore);
      pack.finalize();
      assert.equal(await result, '{"ok":false}\n');
      socket.destroy();
    }
    assert.equal(called, 0);
    assert.equal(await getTrustedImage(f.allowlist, imageId, builderUid), null);
  } finally {
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('failed or uncertain Docker build stays fenced across builder restart', async () => {
  const f = await fixture();
  let calls = 0;
  const options = {
    path: f.socket,
    token,
    runtimeImage,
    allowlistPath: f.allowlist,
    execute: async () => {
      calls++;
      throw new Error('private output');
    },
  };
  const service = await serveImageBuilder(options);
  try {
    const client = new SocketImageBuildExecutor({ path: f.socket, token, runtimeImage });
    await assert.rejects(buildRepositoryImage(f.request, client.execute));
    await assert.rejects(buildRepositoryImage(f.request, client.execute));
    assert.equal(calls, 1);
    assert.equal(await getTrustedImage(f.allowlist, imageId, builderUid), null);
    await service.close();
    await assert.rejects(serveImageBuilder(options), /operator recovery/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('client timeout during a build leaves a durable recovery fence', async () => {
  const f = await fixture();
  let started = false;
  const options = {
    path: f.socket,
    token,
    runtimeImage,
    allowlistPath: f.allowlist,
    execute: async (_context: string, iidFile: string) => {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 150));
      await writeFile(iidFile, imageId);
    },
  };
  const service = await serveImageBuilder(options);
  try {
    const client = new SocketImageBuildExecutor({ path: f.socket, token, runtimeImage, timeoutMs: 50 });
    await assert.rejects(buildRepositoryImage(f.request, client.execute));
    assert.equal(started, true);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(await getTrustedImage(f.allowlist, imageId, builderUid), null);
    await service.close();
    await assert.rejects(serveImageBuilder(options), /operator recovery/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('cleanup failure prevents publishing and persists a recovery fence', async () => {
  const f = await fixture();
  let sourceDirectory = '';
  const options = {
    path: f.socket,
    token,
    runtimeImage,
    allowlistPath: f.allowlist,
    execute: async (_context: string, iidFile: string) => {
      await writeFile(iidFile, imageId);
    },
    cleanup: async (context: string) => {
      sourceDirectory = context;
      throw new Error('injected cleanup error');
    },
  };
  const service = await serveImageBuilder(options);
  try {
    const client = new SocketImageBuildExecutor({ path: f.socket, token, runtimeImage });
    await assert.rejects(buildRepositoryImage(f.request, client.execute));
    assert.equal(await getTrustedImage(f.allowlist, imageId, builderUid), null);
    await service.close();
    await assert.rejects(serveImageBuilder(options), /operator recovery/);
  } finally {
    if (sourceDirectory) await rm(sourceDirectory, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
  }
});

test('limits idle connections and closes incomplete handshakes', async () => {
  const f = await fixture();
  const service = await serveImageBuilder({
    path: f.socket,
    token,
    runtimeImage,
    allowlistPath: f.allowlist,
    maxConnections: 1,
    handshakeTimeoutMs: 100,
  });
  try {
    const first = net.createConnection({ path: f.socket });
    await new Promise<void>((ok, fail) => {
      first.once('connect', ok);
      first.once('error', fail);
    });
    const closedFirst = new Promise<void>((ok) => first.once('close', () => ok()));
    const second = net.createConnection({ path: f.socket });
    await new Promise<void>((ok) => {
      second.once('close', () => ok());
      second.on('error', () => {});
    });
    await closedFirst;
  } finally {
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('shutdown waits for in-flight work and keeps its interrupted build fenced', async () => {
  const f = await fixture();
  let release!: () => void;
  let notify!: () => void;
  const gate = new Promise<void>((ok) => {
    release = ok;
  });
  const started = new Promise<void>((ok) => {
    notify = ok;
  });
  const options = {
    path: f.socket,
    token,
    runtimeImage,
    allowlistPath: f.allowlist,
    execute: async (_context: string, iidFile: string) => {
      notify();
      await gate;
      await writeFile(iidFile, imageId);
    },
  };
  const service = await serveImageBuilder(options);
  try {
    const client = new SocketImageBuildExecutor({ path: f.socket, token, runtimeImage });
    const running = buildRepositoryImage(f.request, client.execute);
    void running.catch(() => {});
    await started;
    let stopped = false;
    const closing = service.close().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false);
    release();
    await closing;
    await assert.rejects(running);
    await assert.rejects(serveImageBuilder(options), /operator recovery/);
  } finally {
    release();
    await rm(f.root, { recursive: true, force: true });
  }
});
