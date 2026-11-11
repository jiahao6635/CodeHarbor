import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import * as tar from 'tar-stream';
import { executeFixedDockerBuild, type ImageBuildExecutor } from './image-builder.js';

const idPattern = /^sha256:[a-f0-9]{64}$/;
const repoPattern = /^[A-Za-z0-9_-]{1,128}$/;
const commitPattern = /^[a-f0-9]{40,64}$/;
const maxHeader = 8192;
const maxFiles = 50_000;
const defaultMaxBytes = 512 * 1024 * 1024;
const maxTrusted = 10_000;

export interface TrustedRepositoryImage { imageId: string; repositoryId: string; commit: string; runtimeImage: string }
export interface ImageBuilderSocketOptions { path: string; token: string; runtimeImage: `sha256:${string}`; timeoutMs?: number }

function validateOptions(options: ImageBuilderSocketOptions): void {
  if (!isAbsolute(options.path) || options.path.includes('\0') || !idPattern.test(options.runtimeImage) ||
      typeof options.token !== 'string' || Buffer.byteLength(options.token) < 32 || Buffer.byteLength(options.token) > 1024 ||
      (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1))) throw new Error('Invalid image builder configuration');
}
function equalToken(a: string, b: string): boolean {
  const hash = (x: string) => createHash('sha256').update(x).digest(); return timingSafeEqual(hash(a), hash(b));
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
      if ((item.mode & 0o022) !== 0 && !(item.uid === 0 && (item.mode & 0o1000) !== 0)) throw new Error('Writable image builder ancestor');
    }
  };
  await walk(path);
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) await walk(canonical);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 ||
      (expectedOwner !== undefined && info.uid !== expectedOwner)) throw new Error('Unsafe image builder directory');
}
async function protectedDatabase(path: string, expectedOwner?: number): Promise<void> {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Invalid allowlist path');
  await protectedDirectory(dirname(path), expectedOwner);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o027) !== 0 ||
      (expectedOwner !== undefined && info.uid !== expectedOwner)) throw new Error('Unsafe image allowlist');
}

/** Read-only lookup; caller must independently check active/candidate repository authorization. */
export async function getTrustedImage(path: string, imageId: string, expectedOwner: number): Promise<TrustedRepositoryImage | null> {
  if (!idPattern.test(imageId)) return null;
  if (!Number.isSafeInteger(expectedOwner) || expectedOwner < 0) throw new Error('Invalid image allowlist owner');
  await protectedDatabase(path, expectedOwner);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT image_id, repository_id, commit_id, runtime_image FROM images WHERE image_id = ?').get(imageId);
    if (!row || typeof row.image_id !== 'string' || typeof row.repository_id !== 'string' || typeof row.commit_id !== 'string' || typeof row.runtime_image !== 'string') return null;
    if (!idPattern.test(row.image_id) || !repoPattern.test(row.repository_id) || !commitPattern.test(row.commit_id) || !idPattern.test(row.runtime_image)) return null;
    return { imageId: row.image_id, repositoryId: row.repository_id, commit: row.commit_id, runtimeImage: row.runtime_image };
  } finally { db.close(); }
}

async function initializeAllowlist(path: string): Promise<void> {
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
    db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS images (image_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, commit_id TEXT NOT NULL, runtime_image TEXT NOT NULL); CREATE TABLE IF NOT EXISTS builder_state (id INTEGER PRIMARY KEY CHECK(id=1), uncertain INTEGER NOT NULL CHECK(uncertain IN (0,1))); INSERT OR IGNORE INTO builder_state(id, uncertain) VALUES (1, 0)');
    if (db.prepare('SELECT uncertain FROM builder_state WHERE id=1').get()?.uncertain !== 0) throw new Error('Image builder requires operator recovery');
  } finally { db.close(); }
  await chmod(path, 0o640);
}
async function trustImage(path: string, record: TrustedRepositoryImage): Promise<void> {
  await protectedDatabase(path, process.getuid?.());
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const count = db.prepare('SELECT count(*) AS n FROM images').get()?.n;
      const old = db.prepare('SELECT repository_id, commit_id, runtime_image FROM images WHERE image_id = ?').get(record.imageId);
      if (old && (old.repository_id !== record.repositoryId || old.commit_id !== record.commit || old.runtime_image !== record.runtimeImage)) throw new Error('Conflicting image identity');
      if (!old && (typeof count !== 'number' || count >= maxTrusted)) throw new Error('Image allowlist is full');
      db.prepare('INSERT OR IGNORE INTO images(image_id, repository_id, commit_id, runtime_image) VALUES (?, ?, ?, ?)').run(record.imageId, record.repositoryId, record.commit, record.runtimeImage);
      db.exec('UPDATE builder_state SET uncertain=0 WHERE id=1');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

/** Durable fence: an interrupted daemon build requires explicit operator recovery. */
async function setRecoveryRequired(path: string): Promise<void> {
  await protectedDatabase(path, process.getuid?.());
  const db = new DatabaseSync(path);
  try {
    const result = db.prepare('UPDATE builder_state SET uncertain=1 WHERE id=1 AND uncertain=0').run();
    if (result.changes !== 1) throw new Error('Image builder requires operator recovery');
  } finally { db.close(); }
}
async function clearRecoveryRequired(path: string): Promise<void> {
  await protectedDatabase(path, process.getuid?.());
  const db = new DatabaseSync(path);
  try { db.exec('UPDATE builder_state SET uncertain=0 WHERE id=1'); } finally { db.close(); }
}

function readLine(socket: net.Socket): Promise<string> {
  return new Promise((ok, fail) => {
    let data = Buffer.alloc(0);
    const clear = () => { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); socket.off('end', onClose); };
    const onError = () => { clear(); fail(new Error('Image builder unavailable')); };
    const onClose = () => { clear(); fail(new Error('Image builder connection closed')); };
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > maxHeader) { clear(); return fail(new Error('Invalid image builder response')); }
      const end = data.indexOf(10); if (end < 0) return;
      if (end !== data.length - 1) { clear(); return fail(new Error('Invalid image builder response')); }
      clear(); ok(data.subarray(0, end).toString('utf8'));
    };
    socket.on('data', onData); socket.once('error', onError); socket.once('close', onClose); socket.once('end', onClose);
  });
}

async function addDirectory(pack: tar.Pack, path: string, name: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe build context');
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === '.git') throw new Error('Git metadata is not permitted');
    const absolute = join(path, entry.name); const relative = `${name}/${entry.name}`;
    const item = await lstat(absolute);
    if (item.isSymbolicLink()) throw new Error('Symbolic links are not permitted');
    if (item.isDirectory()) { await addDirectory(pack, absolute, relative); continue; }
    if (!item.isFile()) throw new Error('Non-regular context entry');
    const target = pack.entry({ name: relative, type: 'file', mode: 0o644, size: item.size });
    await pipeline(createReadStream(absolute), target);
  }
}

/** Narrow authenticated client; only a sanitized workspace is uploaded. */
export class SocketImageBuildExecutor {
  constructor(private readonly options: ImageBuilderSocketOptions) { validateOptions(options); }
  readonly execute: ImageBuildExecutor = async (context, iidFile, tag, timeoutMs) => {
    const dockerfile = await readFile(join(context, 'Dockerfile'), 'utf8');
    const match = /^FROM (sha256:[a-f0-9]{64})\nCOPY --chown=1000:1000 repo \/workspace\/repo\nLABEL io\.codeharbor\.repository-id="([A-Za-z0-9_-]{1,128})"\nLABEL io\.codeharbor\.commit="([a-f0-9]{40,64})"\nLABEL io\.codeharbor\.codegraph-version="1\.6\.2"\n$/.exec(dockerfile);
    if (!match || match[1] !== this.options.runtimeImage || !/^codeharbor-repo:[a-f0-9]{20}-[a-f0-9-]{36}$/.test(tag) ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid repository image build');
    const socket = net.createConnection({ path: this.options.path, allowHalfOpen: true });
    const timer = setTimeout(() => socket.destroy(), Math.min(timeoutMs, this.options.timeoutMs ?? timeoutMs)); timer.unref();
    try {
      await new Promise<void>((ok, fail) => { socket.once('connect', ok); socket.once('error', fail); });
      const ready = readLine(socket);
      socket.write(`${JSON.stringify({ op: 'build', token: this.options.token, runtimeImage: match[1], repositoryId: match[2], commit: match[3] })}\n`);
      if (await ready !== '{"ok":true,"ready":true}') throw new Error('Image builder rejected request');
      const response = readLine(socket);
      void response.catch(() => {});
      const pack = tar.pack();
      pack.on('error', () => socket.destroy());
      const frames = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (chunk.length > 1024 * 1024) return callback(new Error('Image build frame too large'));
          const length = Buffer.allocUnsafe(4); length.writeUInt32BE(chunk.length);
          this.push(length); this.push(chunk); callback();
        },
        flush(callback) { this.push(Buffer.alloc(4)); callback(); },
      });
      frames.on('error', () => socket.destroy());
      pack.pipe(frames); frames.pipe(socket, { end: false });
      await addDirectory(pack, join(context, 'repo'), 'repo');
      pack.finalize();
      const parsed: unknown = JSON.parse(await response);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
          Object.keys(parsed).sort().join(',') !== 'imageId,ok' || (parsed as {ok: unknown}).ok !== true ||
          typeof (parsed as {imageId: unknown}).imageId !== 'string' || !idPattern.test((parsed as {imageId: string}).imageId)) throw new Error('Invalid image builder response');
      await writeFile(iidFile, (parsed as {imageId: string}).imageId, { mode: 0o600, flag: 'wx' });
    } finally { clearTimeout(timer); socket.destroy(); }
  };
}

async function executeDocker(context: string, iidFile: string, tag: string, timeoutMs: number, signal: AbortSignal, runtimeImage: string): Promise<void> {
  await executeFixedDockerBuild(context, iidFile, tag, timeoutMs, runtimeImage, signal);
}

export async function serveImageBuilder(options: ImageBuilderSocketOptions & {
  allowlistPath: string; socketMode?: 0o600 | 0o660; maxBytes?: number;
  workDir?: string;
  maxConnections?: number; handshakeTimeoutMs?: number;
  /** Test-only hooks; production uses the fixed executor and cleanup. */
  execute?: ImageBuildExecutor;
  cleanup?: (path: string) => Promise<void>;
}): Promise<{ close(): Promise<void> }> {
  validateOptions(options);
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024 * 1024) throw new Error('Invalid image build size limit');
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Image builder requires a Unix user');
  await protectedDirectory(dirname(options.path), uid);
  await initializeAllowlist(options.allowlistPath);
  const workDir = options.workDir ?? dirname(options.allowlistPath);
  await protectedDirectory(workDir, uid);
  const maxConnections = options.maxConnections ?? 4;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 64 ||
      !Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1 || handshakeTimeoutMs > 30_000) throw new Error('Invalid image builder limits');
  let busy = false; let poisoned = false;
  const clients = new Set<net.Socket>();
  const tasks = new Set<Promise<void>>();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    if (clients.size >= maxConnections || poisoned) { socket.destroy(); return; }
    clients.add(socket); let context: string | undefined; let claimed = false; let fence = false; let startedBuild = false;
    let responseId: string | undefined;
    let extract: tar.Extract | undefined;
    const abort = new AbortController();
    const handshake = setTimeout(() => socket.destroy(), handshakeTimeoutMs); handshake.unref();
    const timeout = setTimeout(() => socket.destroy(), options.timeoutMs ?? 10 * 60_000); timeout.unref();
    socket.on('error', () => {});
    // Clients keep the write side open until the result. EOF before that means
    // the request was abandoned even though allowHalfOpen delays `close`.
    socket.once('end', () => { abort.abort(); extract?.destroy(new Error('Disconnected')); });
    socket.once('close', () => { abort.abort(); extract?.destroy(new Error('Disconnected')); clearTimeout(handshake); clearTimeout(timeout); clients.delete(socket); });
    const task = (async () => {
      try {
        const raw = await readLine(socket);
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        const input = parsed as Record<string, unknown>;
        if (Object.keys(input).sort().join(',') !== 'commit,op,repositoryId,runtimeImage,token' || input.op !== 'build' ||
            typeof input.token !== 'string' || !equalToken(input.token, options.token) || input.runtimeImage !== options.runtimeImage ||
            typeof input.repositoryId !== 'string' || !repoPattern.test(input.repositoryId) || typeof input.commit !== 'string' || !commitPattern.test(input.commit) || busy || poisoned) throw new Error();
        clearTimeout(handshake);
        busy = true; claimed = true;
        await setRecoveryRequired(options.allowlistPath); fence = true;
        context = await mkdtemp(join(workDir, 'codeharbor-builder-context-'));
        await mkdir(join(context, 'repo'), { mode: 0o700 });
        extract = tar.extract(); let bytes = 0; let files = 0; let sawDatabase = false; let sawGitignore = false;
        const extractor = extract;
        const root = context;
        extractor.on('entry', (header, stream, next) => {
          void (async () => {
            const name = header.name;
            if (typeof name !== 'string' || Buffer.byteLength(name) > 4096 || name.includes('\\') || name.includes('\0') ||
                name.startsWith('/') || !name.startsWith('repo/') || name.split('/').some(p => !p || p === '.' || p === '..' || p === '.git') ||
                (name.split('/').includes('.codegraph') && name !== 'repo/.codegraph/codegraph.db' && name !== 'repo/.codegraph/.gitignore') ||
                name.split('/').length > 66 ||
                header.type !== 'file' || !Number.isSafeInteger(header.size) || header.size < 0 || ++files > maxFiles || (bytes += header.size) > maxBytes) throw new Error();
            const destination = resolve(root, name);
            if (!destination.startsWith(join(root, 'repo') + sep)) throw new Error();
            if (name === 'repo/.codegraph/codegraph.db') sawDatabase = true;
            if (name === 'repo/.codegraph/.gitignore') {
              if (header.size !== 2) throw new Error();
              sawGitignore = true;
            }
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
            await pipeline(stream, createWriteStream(destination, { mode: 0o600, flags: 'wx' }));
            next();
          })().catch(() => { stream.destroy(); extractor.destroy(new Error('Invalid archive')); });
        });
        const done = finished(extractor);
        let transferred = 0; let buffered = Buffer.alloc(0); let complete = false;
        const frames = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          if (complete) return callback(new Error('Unexpected frame'));
          buffered = Buffer.concat([buffered, chunk]);
          while (buffered.length >= 4) {
            const length = buffered.readUInt32BE(0);
            if (length > 1024 * 1024) return callback(new Error('Frame exceeds limit'));
            if (buffered.length < length + 4) break;
            if (length === 0) {
              buffered = buffered.subarray(4); complete = true;
              if (buffered.length) return callback(new Error('Unexpected trailing bytes'));
              this.push(null); break;
            }
            transferred += length;
            if (transferred > maxBytes + maxFiles * 4096 + 1024 * 1024) return callback(new Error('Archive exceeds limit'));
            this.push(buffered.subarray(4, 4 + length)); buffered = buffered.subarray(4 + length);
          }
          callback();
        } });
        frames.on('error', () => extractor.destroy(new Error('Invalid archive')));
        socket.write('{"ok":true,"ready":true}\n');
        socket.pipe(frames).pipe(extractor);
        await done;
        if (!complete || !sawDatabase || !sawGitignore || abort.signal.aborted ||
            await readFile(join(root, 'repo', '.codegraph', '.gitignore'), 'utf8') !== '*\n') throw new Error();
        const dockerfile = [`FROM ${options.runtimeImage}`, 'COPY --chown=1000:1000 repo /workspace/repo',
          `LABEL io.codeharbor.repository-id="${input.repositoryId}"`, `LABEL io.codeharbor.commit="${input.commit}"`,
          'LABEL io.codeharbor.codegraph-version="1.6.2"', ''].join('\n');
        await writeFile(join(context, 'Dockerfile'), dockerfile, { mode: 0o600, flag: 'wx' });
        const iidFile = join(context, 'image.id');
        const tag = `codeharbor-repo:${createHash('sha256').update(input.repositoryId).digest('hex').slice(0, 20)}-${randomUUID()}`;
        startedBuild = true;
        if (options.execute) await options.execute(context, iidFile, tag, options.timeoutMs ?? 10 * 60_000);
        else await executeDocker(context, iidFile, tag, options.timeoutMs ?? 10 * 60_000, abort.signal, options.runtimeImage);
        if (abort.signal.aborted) throw new Error();
        const imageId = (await readFile(iidFile, 'utf8')).trim();
        if (!idPattern.test(imageId)) throw new Error();
        await (options.cleanup ?? (p => rm(p, { recursive: true, force: true })))(context);
        context = undefined;
        await trustImage(options.allowlistPath, { imageId, repositoryId: input.repositoryId, commit: input.commit, runtimeImage: options.runtimeImage });
        fence = false; responseId = imageId;
      } catch { /* Fixed failure response avoids leaking source and credentials. */ }
      finally {
        if (context) {
          try { await (options.cleanup ?? (p => rm(p, { recursive: true, force: true })))(context); }
          catch { poisoned = true; }
        }
        if (fence) {
          if (!startedBuild && !poisoned) {
            try { await clearRecoveryRequired(options.allowlistPath); fence = false; }
            catch { poisoned = true; }
          } else poisoned = true;
        }
        if (claimed) busy = false;
        if (!socket.destroyed) socket.end(responseId && !poisoned ? `${JSON.stringify({ ok: true, imageId: responseId })}\n` : '{"ok":false}\n');
      }
    })();
    tasks.add(task);
    void task.then(() => tasks.delete(task), () => tasks.delete(task));
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(options.path, () => { server.off('error', fail); ok(); }); });
  await chmod(options.path, options.socketMode ?? 0o600);
  const identity = await lstat(options.path);
  return { async close() {
    const stopped = new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok()));
    for (const socket of clients) socket.destroy();
    await stopped;
    await Promise.allSettled([...tasks]);
    try { const current = await lstat(options.path); if (current.isSocket() && current.ino === identity.ino && current.dev === identity.dev) await unlink(options.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } };
}
