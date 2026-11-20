import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import * as tar from 'tar-stream';
import {
  executeFixedDockerBuild,
  type ImageBuildExecutor,
  type OwnedRepositoryImage,
  removeOwnedRepositoryImage,
} from './image-builder.js';

const idPattern = /^sha256:[a-f0-9]{64}$/;
const repoPattern = /^[A-Za-z0-9_-]{1,128}$/;
const commitPattern = /^[a-f0-9]{40,64}$/;
const maxHeader = 4 * 1024 * 1024;
const maxFiles = 50_000;
const defaultMaxBytes = 512 * 1024 * 1024;
const storageMetadataBytes = maxFiles * 4096 + 1024 * 1024;
const defaultMaxTrusted = 512;
const defaultMaxRepositoryImages = 3;
const defaultMaxStorageBytes = 64 * 1024 * 1024 * 1024;

export interface TrustedRepositoryImage {
  imageId: string;
  repositoryId: string;
  commit: string;
  runtimeImage: string;
}
type StoredRepositoryImage = TrustedRepositoryImage & {
  storageBytes: number;
  active: boolean;
};
type ImageCapacityLimits = {
  maxTrusted: number;
  maxRepositoryImages: number;
  maxStorageBytes: number;
};
export interface ImageBuilderSocketOptions {
  path: string;
  token: string;
  runtimeImage: `sha256:${string}`;
  timeoutMs?: number;
}

export type RetainedImageReferences = {
  repositoryId: string;
  imageIds: string[];
};

function validateOptions(options: ImageBuilderSocketOptions): void {
  if (
    !isAbsolute(options.path) ||
    options.path.includes('\0') ||
    !idPattern.test(options.runtimeImage) ||
    typeof options.token !== 'string' ||
    Buffer.byteLength(options.token) < 32 ||
    Buffer.byteLength(options.token) > 1024 ||
    (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1))
  )
    throw new Error('Invalid image builder configuration');
}
function equalToken(a: string, b: string): boolean {
  const hash = (x: string) => createHash('sha256').update(x).digest();
  return timingSafeEqual(hash(a), hash(b));
}
async function protectedDirectory(path: string, expectedOwner?: number): Promise<void> {
  if (!isAbsolute(path) || expectedOwner === undefined) throw new Error('Invalid image builder directory');
  const walk = async (full: string) => {
    let current: string = sep;
    for (const part of resolve(full).split(sep).filter(Boolean)) {
      current = join(current, part);
      const item = await lstat(current);
      if (item.uid !== 0 && item.uid !== expectedOwner) throw new Error('Untrusted image builder ancestor');
      if (item.isSymbolicLink()) continue; // Its parent is checked, and the resolved chain is checked below.
      if (!item.isDirectory()) throw new Error('Invalid image builder ancestor');
      if ((item.mode & 0o022) !== 0 && !(item.uid === 0 && (item.mode & 0o1000) !== 0))
        throw new Error('Writable image builder ancestor');
    }
  };
  await walk(path);
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) await walk(canonical);
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o022) !== 0 ||
    (expectedOwner !== undefined && info.uid !== expectedOwner)
  )
    throw new Error('Unsafe image builder directory');
}
async function protectedDatabase(path: string, expectedOwner?: number): Promise<void> {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Invalid allowlist path');
  await protectedDirectory(dirname(path), expectedOwner);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (info.mode & 0o027) !== 0 ||
    (expectedOwner !== undefined && info.uid !== expectedOwner)
  )
    throw new Error('Unsafe image allowlist');
}

/** Read-only lookup; caller must independently check active/candidate repository authorization. */
export async function getTrustedImage(
  path: string,
  imageId: string,
  expectedOwner: number,
): Promise<TrustedRepositoryImage | null> {
  if (!idPattern.test(imageId)) return null;
  if (!Number.isSafeInteger(expectedOwner) || expectedOwner < 0) throw new Error('Invalid image allowlist owner');
  await protectedDatabase(path, expectedOwner);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare(
        'SELECT image_id, repository_id, commit_id, runtime_image FROM images WHERE image_id = ? AND active = 1',
      )
      .get(imageId);
    if (
      !row ||
      typeof row.image_id !== 'string' ||
      typeof row.repository_id !== 'string' ||
      typeof row.commit_id !== 'string' ||
      typeof row.runtime_image !== 'string'
    )
      return null;
    if (
      !idPattern.test(row.image_id) ||
      !repoPattern.test(row.repository_id) ||
      !commitPattern.test(row.commit_id) ||
      !idPattern.test(row.runtime_image)
    )
      return null;
    return {
      imageId: row.image_id,
      repositoryId: row.repository_id,
      commit: row.commit_id,
      runtimeImage: row.runtime_image,
    };
  } finally {
    db.close();
  }
}

async function initializeAllowlist(path: string, legacyStorageBytes: number): Promise<void> {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Invalid allowlist path');
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Image builder requires a Unix user');
  await protectedDirectory(dirname(path), uid);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe image allowlist');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    // Exclusive creation prevents following a preexisting link. The directory is builder-owned.
    await writeFile(path, '', { mode: 0o640, flag: 'wx' });
  }
  await protectedDatabase(path, process.getuid?.());
  const db = new DatabaseSync(path);
  try {
    db.exec(
      `PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS images (image_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, commit_id TEXT NOT NULL, runtime_image TEXT NOT NULL, storage_bytes INTEGER NOT NULL DEFAULT ${legacyStorageBytes}, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))); CREATE TABLE IF NOT EXISTS builder_state (id INTEGER PRIMARY KEY CHECK(id=1), uncertain INTEGER NOT NULL CHECK(uncertain IN (0,1))); INSERT OR IGNORE INTO builder_state(id, uncertain) VALUES (1, 0)`,
    );
    const columns = db.prepare('PRAGMA table_info(images)').all();
    if (!columns.some((column) => column.name === 'storage_bytes'))
      db.exec(`ALTER TABLE images ADD COLUMN storage_bytes INTEGER NOT NULL DEFAULT ${legacyStorageBytes}`);
    if (!columns.some((column) => column.name === 'active'))
      db.exec('ALTER TABLE images ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
    db.exec(
      'CREATE INDEX IF NOT EXISTS images_repository_active ON images(repository_id, active); CREATE INDEX IF NOT EXISTS images_active ON images(active)',
    );
    if (db.prepare('SELECT uncertain FROM builder_state WHERE id=1').get()?.uncertain !== 0)
      throw new Error('Image builder requires operator recovery');
  } finally {
    db.close();
  }
  await chmod(path, 0o640);
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function ensureBuildCapacity(
  path: string,
  repositoryId: string,
  reservationBytes: number,
  limits: ImageCapacityLimits,
): Promise<void> {
  await protectedDatabase(path, process.getuid?.());
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const totals = db.prepare('SELECT count(*) AS n, COALESCE(sum(storage_bytes), 0) AS bytes FROM images').get();
    const repository = db.prepare('SELECT count(*) AS n FROM images WHERE repository_id = ?').get(repositoryId);
    const count = numeric(totals?.n);
    const bytes = numeric(totals?.bytes);
    const repositoryCount = numeric(repository?.n);
    if (
      count === null ||
      bytes === null ||
      repositoryCount === null ||
      count >= limits.maxTrusted ||
      repositoryCount >= limits.maxRepositoryImages ||
      bytes > limits.maxStorageBytes - reservationBytes
    )
      throw new Error('Image capacity is unavailable');
  } finally {
    db.close();
  }
}

async function trustImage(
  path: string,
  record: TrustedRepositoryImage,
  storageBytes: number,
  limits: ImageCapacityLimits,
): Promise<void> {
  await protectedDatabase(path, process.getuid?.());
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const totals = db.prepare('SELECT count(*) AS n, COALESCE(sum(storage_bytes), 0) AS bytes FROM images').get();
      const repositoryCount = db
        .prepare('SELECT count(*) AS n FROM images WHERE repository_id = ?')
        .get(record.repositoryId)?.n;
      const old = db
        .prepare('SELECT repository_id, commit_id, runtime_image, active FROM images WHERE image_id = ?')
        .get(record.imageId);
      if (
        old &&
        (old.repository_id !== record.repositoryId ||
          old.commit_id !== record.commit ||
          old.runtime_image !== record.runtimeImage ||
          old.active !== 1)
      )
        throw new Error('Conflicting image identity');
      const count = numeric(totals?.n);
      const bytes = numeric(totals?.bytes);
      const perRepository = numeric(repositoryCount);
      if (
        !old &&
        (count === null ||
          bytes === null ||
          perRepository === null ||
          count >= limits.maxTrusted ||
          perRepository >= limits.maxRepositoryImages ||
          bytes > limits.maxStorageBytes - storageBytes)
      )
        throw new Error('Image capacity is unavailable');
      db.prepare(
        'INSERT OR IGNORE INTO images(image_id, repository_id, commit_id, runtime_image, storage_bytes, active) VALUES (?, ?, ?, ?, ?, 1)',
      ).run(record.imageId, record.repositoryId, record.commit, record.runtimeImage, storageBytes);
      db.exec('UPDATE builder_state SET uncertain=0 WHERE id=1');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

function storedImage(row: Record<string, unknown>): StoredRepositoryImage {
  if (
    typeof row.image_id !== 'string' ||
    !idPattern.test(row.image_id) ||
    typeof row.repository_id !== 'string' ||
    !repoPattern.test(row.repository_id) ||
    typeof row.commit_id !== 'string' ||
    !commitPattern.test(row.commit_id) ||
    typeof row.runtime_image !== 'string' ||
    !idPattern.test(row.runtime_image) ||
    numeric(row.storage_bytes) === null ||
    (row.active !== 0 && row.active !== 1)
  )
    throw new Error('Invalid image allowlist state');
  return {
    imageId: row.image_id,
    repositoryId: row.repository_id,
    commit: row.commit_id,
    runtimeImage: row.runtime_image,
    storageBytes: row.storage_bytes as number,
    active: row.active === 1,
  };
}

function verifyRetainedImages(
  db: DatabaseSync,
  repositoryId: string,
  imageIds: readonly string[],
): void {
  for (const imageId of imageIds) {
    const row = db
      .prepare('SELECT repository_id, active FROM images WHERE image_id = ?')
      .get(imageId) as Record<string, unknown> | undefined;
    if (!row || row.repository_id !== repositoryId || row.active !== 1)
      throw new Error('Retained image is not trusted');
  }
}

async function reconcileRepositoryImages(path: string, repositoryId: string, imageIds: string[]): Promise<void> {
  await protectedDatabase(path, process.getuid?.());
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      verifyRetainedImages(db, repositoryId, imageIds);
      db.prepare('UPDATE images SET active=0 WHERE repository_id = ?').run(repositoryId);
      const retain = db.prepare('UPDATE images SET active=1 WHERE image_id = ? AND repository_id = ?');
      for (const imageId of imageIds) retain.run(imageId, repositoryId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

async function reconcileAllImages(
  path: string,
  repositories: Array<{ repositoryId: string; imageIds: string[] }>,
): Promise<void> {
  await protectedDatabase(path, process.getuid?.());
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const repository of repositories)
        verifyRetainedImages(db, repository.repositoryId, repository.imageIds);
      db.exec('UPDATE images SET active=0');
      const retain = db.prepare('UPDATE images SET active=1 WHERE image_id = ? AND repository_id = ?');
      for (const repository of repositories)
        for (const imageId of repository.imageIds) retain.run(imageId, repository.repositoryId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

async function cleanupRetiredImages(
  path: string,
  removeImage: (image: OwnedRepositoryImage) => Promise<void>,
): Promise<void> {
  await protectedDatabase(path, process.getuid?.());
  const read = new DatabaseSync(path, { readOnly: true });
  let retired: StoredRepositoryImage[];
  try {
    retired = read
      .prepare(
        'SELECT image_id, repository_id, commit_id, runtime_image, storage_bytes, active FROM images WHERE active=0 ORDER BY repository_id, image_id',
      )
      .all()
      .map((row) => storedImage(row));
  } finally {
    read.close();
  }
  for (const image of retired) {
    await removeImage(image);
    await protectedDatabase(path, process.getuid?.());
    const db = new DatabaseSync(path);
    try {
      db.prepare('DELETE FROM images WHERE image_id = ? AND active=0').run(image.imageId);
    } finally {
      db.close();
    }
  }
}

/** Durable fence: an interrupted daemon build requires explicit operator recovery. */
async function setRecoveryRequired(path: string): Promise<void> {
  await protectedDatabase(path, process.getuid?.());
  const db = new DatabaseSync(path);
  try {
    const result = db.prepare('UPDATE builder_state SET uncertain=1 WHERE id=1 AND uncertain=0').run();
    if (result.changes !== 1) throw new Error('Image builder requires operator recovery');
  } finally {
    db.close();
  }
}
async function clearRecoveryRequired(path: string): Promise<void> {
  await protectedDatabase(path, process.getuid?.());
  const db = new DatabaseSync(path);
  try {
    db.exec('UPDATE builder_state SET uncertain=0 WHERE id=1');
  } finally {
    db.close();
  }
}

function readLine(socket: net.Socket): Promise<string> {
  return new Promise((ok, fail) => {
    let data = Buffer.alloc(0);
    const clear = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('end', onClose);
    };
    const onError = () => {
      clear();
      fail(new Error('Image builder unavailable'));
    };
    const onClose = () => {
      clear();
      fail(new Error('Image builder connection closed'));
    };
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > maxHeader) {
        clear();
        return fail(new Error('Invalid image builder response'));
      }
      const end = data.indexOf(10);
      if (end < 0) return;
      if (end !== data.length - 1) {
        clear();
        return fail(new Error('Invalid image builder response'));
      }
      clear();
      ok(data.subarray(0, end).toString('utf8'));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('end', onClose);
  });
}

async function addDirectory(pack: tar.Pack, path: string, name: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe build context');
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === '.git') throw new Error('Git metadata is not permitted');
    const absolute = join(path, entry.name);
    const relative = `${name}/${entry.name}`;
    const item = await lstat(absolute);
    if (item.isSymbolicLink()) throw new Error('Symbolic links are not permitted');
    if (item.isDirectory()) {
      await addDirectory(pack, absolute, relative);
      continue;
    }
    if (!item.isFile()) throw new Error('Non-regular context entry');
    const target = pack.entry({ name: relative, type: 'file', mode: 0o644, size: item.size });
    await pipeline(createReadStream(absolute), target);
  }
}

/** Narrow authenticated client; only a sanitized workspace is uploaded. */
export class SocketImageBuildExecutor {
  constructor(private readonly options: ImageBuilderSocketOptions) {
    validateOptions(options);
  }

  private async control(input: Record<string, unknown>): Promise<void> {
    const socket = net.createConnection({ path: this.options.path, allowHalfOpen: true });
    const timer = setTimeout(() => socket.destroy(), this.options.timeoutMs ?? 30_000);
    timer.unref();
    try {
      await new Promise<void>((ok, fail) => {
        socket.once('connect', ok);
        socket.once('error', fail);
      });
      const response = readLine(socket);
      socket.end(`${JSON.stringify({ ...input, token: this.options.token })}\n`);
      if ((await response) !== '{"ok":true}') throw new Error('Image builder rejected reconciliation');
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  }

  async reconcileRepository(repositoryId: string, imageIds: string[]): Promise<void> {
    if (
      !repoPattern.test(repositoryId) ||
      imageIds.length > 2 ||
      new Set(imageIds).size !== imageIds.length ||
      imageIds.some((imageId) => !idPattern.test(imageId))
    )
      throw new Error('Invalid repository image reconciliation');
    await this.control({ op: 'reconcile_repository', repositoryId, imageIds });
  }

  async reconcileAll(repositories: RetainedImageReferences[]): Promise<void> {
    const ids = repositories.flatMap((repository) => repository.imageIds);
    if (
      repositories.length > 10_000 ||
      ids.length > 10_000 ||
      new Set(repositories.map((repository) => repository.repositoryId)).size !== repositories.length ||
      new Set(ids).size !== ids.length ||
      repositories.some(
        (repository) =>
          !repoPattern.test(repository.repositoryId) ||
          repository.imageIds.length > 2 ||
          repository.imageIds.some((imageId) => !idPattern.test(imageId)),
      )
    )
      throw new Error('Invalid global image reconciliation');
    await this.control({ op: 'reconcile_all', repositories });
  }

  readonly execute: ImageBuildExecutor = async (context, iidFile, tag, timeoutMs) => {
    const dockerfile = await readFile(join(context, 'Dockerfile'), 'utf8');
    const match =
      /^FROM (sha256:[a-f0-9]{64})\nCOPY --chown=1000:1000 repo \/workspace\/repo\nLABEL io\.codeharbor\.repository-id="([A-Za-z0-9_-]{1,128})"\nLABEL io\.codeharbor\.commit="([a-f0-9]{40,64})"\nLABEL io\.codeharbor\.codegraph-version="1\.6\.2"\n$/.exec(
        dockerfile,
      );
    if (
      !match ||
      match[1] !== this.options.runtimeImage ||
      !/^codeharbor-repo:[a-f0-9]{20}-[a-f0-9-]{36}$/.test(tag) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1
    )
      throw new Error('Invalid repository image build');
    const socket = net.createConnection({ path: this.options.path, allowHalfOpen: true });
    const timer = setTimeout(() => socket.destroy(), Math.min(timeoutMs, this.options.timeoutMs ?? timeoutMs));
    timer.unref();
    try {
      await new Promise<void>((ok, fail) => {
        socket.once('connect', ok);
        socket.once('error', fail);
      });
      const ready = readLine(socket);
      socket.write(
        `${JSON.stringify({ op: 'build', token: this.options.token, runtimeImage: match[1], repositoryId: match[2], commit: match[3] })}\n`,
      );
      if ((await ready) !== '{"ok":true,"ready":true}') throw new Error('Image builder rejected request');
      const response = readLine(socket);
      void response.catch(() => {});
      const pack = tar.pack();
      pack.on('error', () => socket.destroy());
      const frames = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (chunk.length > 1024 * 1024) return callback(new Error('Image build frame too large'));
          const length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(chunk.length);
          this.push(length);
          this.push(chunk);
          callback();
        },
        flush(callback) {
          this.push(Buffer.alloc(4));
          callback();
        },
      });
      frames.on('error', () => socket.destroy());
      pack.pipe(frames);
      frames.pipe(socket, { end: false });
      await addDirectory(pack, join(context, 'repo'), 'repo');
      pack.finalize();
      const parsed: unknown = JSON.parse(await response);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(',') !== 'imageId,ok' ||
        (parsed as { ok: unknown }).ok !== true ||
        typeof (parsed as { imageId: unknown }).imageId !== 'string' ||
        !idPattern.test((parsed as { imageId: string }).imageId)
      )
        throw new Error('Invalid image builder response');
      await writeFile(iidFile, (parsed as { imageId: string }).imageId, { mode: 0o600, flag: 'wx' });
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  };
}

async function executeDocker(
  context: string,
  iidFile: string,
  tag: string,
  timeoutMs: number,
  signal: AbortSignal,
  runtimeImage: string,
): Promise<void> {
  await executeFixedDockerBuild(context, iidFile, tag, timeoutMs, runtimeImage, signal);
}

export async function serveImageBuilder(
  options: ImageBuilderSocketOptions & {
    allowlistPath: string;
    socketMode?: 0o600 | 0o660;
    maxBytes?: number;
    workDir?: string;
    maxConnections?: number;
    handshakeTimeoutMs?: number;
    maxTrustedImages?: number;
    maxRepositoryImages?: number;
    maxStorageBytes?: number;
    /** Test-only hooks; production uses the fixed executor and cleanup. */
    execute?: ImageBuildExecutor;
    cleanup?: (path: string) => Promise<void>;
    removeImage?: (image: OwnedRepositoryImage) => Promise<void>;
  },
): Promise<{ close(): Promise<void> }> {
  validateOptions(options);
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024 * 1024)
    throw new Error('Invalid image build size limit');
  const imageReservationBytes = maxBytes + storageMetadataBytes;
  const buildReservationBytes = imageReservationBytes * 2;
  const limits: ImageCapacityLimits = {
    maxTrusted: options.maxTrustedImages ?? defaultMaxTrusted,
    maxRepositoryImages: options.maxRepositoryImages ?? defaultMaxRepositoryImages,
    maxStorageBytes: options.maxStorageBytes ?? defaultMaxStorageBytes,
  };
  if (
    !Number.isSafeInteger(limits.maxTrusted) ||
    limits.maxTrusted < 1 ||
    limits.maxTrusted > 10_000 ||
    !Number.isSafeInteger(limits.maxRepositoryImages) ||
    limits.maxRepositoryImages < 1 ||
    limits.maxRepositoryImages > 3 ||
    limits.maxRepositoryImages > limits.maxTrusted ||
    !Number.isSafeInteger(limits.maxStorageBytes) ||
    limits.maxStorageBytes < buildReservationBytes
  )
    throw new Error('Invalid image storage limits');
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Image builder requires a Unix user');
  await protectedDirectory(dirname(options.path), uid);
  await initializeAllowlist(options.allowlistPath, imageReservationBytes);
  const workDir = options.workDir ?? dirname(options.allowlistPath);
  await protectedDirectory(workDir, uid);
  const removeImage =
    options.removeImage ??
    ((image: OwnedRepositoryImage) =>
      removeOwnedRepositoryImage(image, workDir, options.timeoutMs ?? 10 * 60_000));
  // Retirement is durable before Docker cleanup, so interrupted cleanup can be retried safely.
  await cleanupRetiredImages(options.allowlistPath, removeImage).catch(() => {});
  const maxConnections = options.maxConnections ?? 4;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5000;
  if (
    !Number.isSafeInteger(maxConnections) ||
    maxConnections < 1 ||
    maxConnections > 64 ||
    !Number.isSafeInteger(handshakeTimeoutMs) ||
    handshakeTimeoutMs < 1 ||
    handshakeTimeoutMs > 30_000
  )
    throw new Error('Invalid image builder limits');
  let busy = false;
  let poisoned = false;
  const clients = new Set<net.Socket>();
  const tasks = new Set<Promise<void>>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (clients.size >= maxConnections || poisoned) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    let context: string | undefined;
    let claimed = false;
    let fence = false;
    let startedBuild = false;
    let responseId: string | undefined;
    let controlResponse = false;
    let extract: tar.Extract | undefined;
    const abort = new AbortController();
    const handshake = setTimeout(() => socket.destroy(), handshakeTimeoutMs);
    handshake.unref();
    const timeout = setTimeout(() => socket.destroy(), options.timeoutMs ?? 10 * 60_000);
    timeout.unref();
    socket.on('error', () => {});
    // Clients keep the write side open until the result. EOF before that means
    // the request was abandoned even though allowHalfOpen delays `close`.
    socket.once('end', () => {
      abort.abort();
      extract?.destroy(new Error('Disconnected'));
    });
    socket.once('close', () => {
      abort.abort();
      extract?.destroy(new Error('Disconnected'));
      clearTimeout(handshake);
      clearTimeout(timeout);
      clients.delete(socket);
    });
    const task = (async () => {
      try {
        const raw = await readLine(socket);
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        const input = parsed as Record<string, unknown>;
        if (
          typeof input.token !== 'string' ||
          !equalToken(input.token, options.token) ||
          busy ||
          poisoned
        )
          throw new Error();
        clearTimeout(handshake);
        busy = true;
        claimed = true;
        if (input.op === 'reconcile_repository') {
          if (
            Object.keys(input).sort().join(',') !== 'imageIds,op,repositoryId,token' ||
            typeof input.repositoryId !== 'string' ||
            !repoPattern.test(input.repositoryId) ||
            !Array.isArray(input.imageIds) ||
            input.imageIds.length > 2 ||
            new Set(input.imageIds).size !== input.imageIds.length ||
            input.imageIds.some((imageId) => typeof imageId !== 'string' || !idPattern.test(imageId))
          )
            throw new Error();
          await reconcileRepositoryImages(options.allowlistPath, input.repositoryId, input.imageIds as string[]);
          // A failed Docker removal remains durably inactive and counts against
          // admission until a later maintenance/build request can retry it.
          await cleanupRetiredImages(options.allowlistPath, removeImage).catch(() => {});
          controlResponse = true;
          return;
        }
        if (input.op === 'reconcile_all') {
          if (
            Object.keys(input).sort().join(',') !== 'op,repositories,token' ||
            !Array.isArray(input.repositories) ||
            input.repositories.length > 10_000
          )
            throw new Error();
          const repositories: RetainedImageReferences[] = [];
          for (const item of input.repositories) {
            if (
              !item ||
              typeof item !== 'object' ||
              Array.isArray(item) ||
              Object.keys(item).sort().join(',') !== 'imageIds,repositoryId'
            )
              throw new Error();
            const repository = item as Record<string, unknown>;
            if (
              typeof repository.repositoryId !== 'string' ||
              !repoPattern.test(repository.repositoryId) ||
              !Array.isArray(repository.imageIds) ||
              repository.imageIds.length > 2 ||
              new Set(repository.imageIds).size !== repository.imageIds.length ||
              repository.imageIds.some((imageId) => typeof imageId !== 'string' || !idPattern.test(imageId))
            )
              throw new Error();
            repositories.push({
              repositoryId: repository.repositoryId,
              imageIds: repository.imageIds as string[],
            });
          }
          const retained = repositories.flatMap((repository) => repository.imageIds);
          if (
            retained.length > 10_000 ||
            new Set(repositories.map((repository) => repository.repositoryId)).size !== repositories.length ||
            new Set(retained).size !== retained.length
          )
            throw new Error();
          await reconcileAllImages(options.allowlistPath, repositories);
          await cleanupRetiredImages(options.allowlistPath, removeImage).catch(() => {});
          controlResponse = true;
          return;
        }
        if (
          Object.keys(input).sort().join(',') !== 'commit,op,repositoryId,runtimeImage,token' ||
          input.op !== 'build' ||
          input.runtimeImage !== options.runtimeImage ||
          typeof input.repositoryId !== 'string' ||
          !repoPattern.test(input.repositoryId) ||
          typeof input.commit !== 'string' ||
          !commitPattern.test(input.commit)
        )
          throw new Error();
        await cleanupRetiredImages(options.allowlistPath, removeImage);
        await ensureBuildCapacity(options.allowlistPath, input.repositoryId, buildReservationBytes, limits);
        await setRecoveryRequired(options.allowlistPath);
        fence = true;
        context = await mkdtemp(join(workDir, 'codeharbor-builder-context-'));
        await mkdir(join(context, 'repo'), { mode: 0o755 });
        extract = tar.extract();
        let bytes = 0;
        let files = 0;
        let sawDatabase = false;
        let sawGitignore = false;
        const extractor = extract;
        const root = context;
        extractor.on('entry', (header, stream, next) => {
          void (async () => {
            const name = header.name;
            if (
              typeof name !== 'string' ||
              Buffer.byteLength(name) > 4096 ||
              name.includes('\\') ||
              name.includes('\0') ||
              name.startsWith('/') ||
              !name.startsWith('repo/') ||
              name.split('/').some((p) => !p || p === '.' || p === '..' || p === '.git') ||
              (name.split('/').includes('.codegraph') &&
                name !== 'repo/.codegraph/codegraph.db' &&
                name !== 'repo/.codegraph/.gitignore') ||
              name.split('/').length > 66 ||
              header.type !== 'file' ||
              !Number.isSafeInteger(header.size) ||
              header.size < 0
            )
              throw new Error();
            files += 1;
            bytes += header.size;
            if (files > maxFiles || bytes > maxBytes) throw new Error();
            const destination = resolve(root, name);
            if (!destination.startsWith(join(root, 'repo') + sep)) throw new Error();
            if (name === 'repo/.codegraph/codegraph.db') sawDatabase = true;
            if (name === 'repo/.codegraph/.gitignore') {
              if (header.size !== 2) throw new Error();
              sawGitignore = true;
            }
            await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
            await pipeline(stream, createWriteStream(destination, { mode: 0o644, flags: 'wx' }));
            next();
          })().catch(() => {
            stream.destroy();
            extractor.destroy(new Error('Invalid archive'));
          });
        });
        const done = finished(extractor);
        let transferred = 0;
        let buffered = Buffer.alloc(0);
        let complete = false;
        const frames = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            if (complete) return callback(new Error('Unexpected frame'));
            buffered = Buffer.concat([buffered, chunk]);
            while (buffered.length >= 4) {
              const length = buffered.readUInt32BE(0);
              if (length > 1024 * 1024) return callback(new Error('Frame exceeds limit'));
              if (buffered.length < length + 4) break;
              if (length === 0) {
                buffered = buffered.subarray(4);
                complete = true;
                if (buffered.length) return callback(new Error('Unexpected trailing bytes'));
                this.push(null);
                break;
              }
              transferred += length;
              if (transferred > maxBytes + maxFiles * 4096 + 1024 * 1024)
                return callback(new Error('Archive exceeds limit'));
              this.push(buffered.subarray(4, 4 + length));
              buffered = buffered.subarray(4 + length);
            }
            callback();
          },
        });
        frames.on('error', () => extractor.destroy(new Error('Invalid archive')));
        socket.write('{"ok":true,"ready":true}\n');
        socket.pipe(frames).pipe(extractor);
        await done;
        if (
          !complete ||
          !sawDatabase ||
          !sawGitignore ||
          abort.signal.aborted ||
          (await readFile(join(root, 'repo', '.codegraph', '.gitignore'), 'utf8')) !== '*\n'
        )
          throw new Error();
        const dockerfile = [
          `FROM ${options.runtimeImage}`,
          'COPY --chown=1000:1000 repo /workspace/repo',
          `LABEL io.codeharbor.repository-id="${input.repositoryId}"`,
          `LABEL io.codeharbor.commit="${input.commit}"`,
          'LABEL io.codeharbor.codegraph-version="1.6.2"',
          '',
        ].join('\n');
        await writeFile(join(context, 'Dockerfile'), dockerfile, { mode: 0o600, flag: 'wx' });
        const iidFile = join(context, 'image.id');
        const tag = `codeharbor-repo:${createHash('sha256').update(input.repositoryId).digest('hex').slice(0, 20)}-${randomUUID()}`;
        startedBuild = true;
        if (options.execute) await options.execute(context, iidFile, tag, options.timeoutMs ?? 10 * 60_000);
        else
          await executeDocker(
            context,
            iidFile,
            tag,
            options.timeoutMs ?? 10 * 60_000,
            abort.signal,
            options.runtimeImage,
          );
        if (abort.signal.aborted) throw new Error();
        const imageId = (await readFile(iidFile, 'utf8')).trim();
        if (!idPattern.test(imageId)) throw new Error();
        await (options.cleanup ?? ((p) => rm(p, { recursive: true, force: true })))(context);
        context = undefined;
        await trustImage(
          options.allowlistPath,
          {
            imageId,
            repositoryId: input.repositoryId,
            commit: input.commit,
            runtimeImage: options.runtimeImage,
          },
          bytes + files * 4096 + 1024 * 1024,
          limits,
        );
        fence = false;
        responseId = imageId;
      } catch {
        /* Fixed failure response avoids leaking source and credentials. */
      } finally {
        if (context) {
          try {
            await (options.cleanup ?? ((p) => rm(p, { recursive: true, force: true })))(context);
          } catch {
            poisoned = true;
          }
        }
        if (fence) {
          if (!startedBuild && !poisoned) {
            try {
              await clearRecoveryRequired(options.allowlistPath);
              fence = false;
            } catch {
              poisoned = true;
            }
          } else poisoned = true;
        }
        if (claimed) busy = false;
        if (!socket.destroyed)
          socket.end(
            responseId && !poisoned
              ? `${JSON.stringify({ ok: true, imageId: responseId })}\n`
              : controlResponse && !poisoned
                ? '{"ok":true}\n'
                : '{"ok":false}\n',
          );
      }
    })();
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    );
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(options.path, () => {
      server.off('error', fail);
      ok();
    });
  });
  await chmod(options.path, options.socketMode ?? 0o600);
  const identity = await lstat(options.path);
  return {
    async close() {
      const stopped = new Promise<void>((ok, fail) => server.close((error) => (error ? fail(error) : ok())));
      for (const socket of clients) socket.destroy();
      await stopped;
      await Promise.allSettled([...tasks]);
      try {
        const current = await lstat(options.path);
        if (current.isSocket() && current.ino === identity.ino && current.dev === identity.dev)
          await unlink(options.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}
