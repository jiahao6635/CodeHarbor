import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import type { IndexCandidate } from './indexer.js';

/** A local Docker image ID; registry manifest digests require a separate push step. */
export type LocalImageReference = `oci://sha256:${string}`;

export interface RepositoryImageRequest {
  dataDir: string;
  repositoryId: string;
  candidate: IndexCandidate;
  /** Trusted, preinstalled runtime image, pinned to a local Docker image ID. */
  runtimeImage: `sha256:${string}`;
  timeoutMs?: number;
}

export interface RepositoryImageBuildResult {
  image: LocalImageReference;
  commit: string;
  repositoryId: string;
  codegraphVersion: '1.6.2';
}

export class RepositoryImageError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RepositoryImageError'; }
}

/** Invoked without a shell and without Git credentials; output is deliberately suppressed. */
export type ImageBuildExecutor = (context: string, iidFile: string, tag: string, timeoutMs: number) => Promise<void>;

const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const generationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const imagePattern = /^sha256:[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40,64}$/;
const maxSourceBytes = 512 * 1024 * 1024;
const maxEntries = 50_000;
const maxDepth = 64;

type DockerResult = { code: number | null; stdout: string; stderr: string };
type ImageDetails = { id: string; os: string; arch: string; layers: string[]; env: unknown; user: unknown; entrypoint: unknown; cmd: unknown; workingDir: unknown; volumes: unknown };
const inspectFormat = '{"id":{{json .Id}},"os":{{json .Os}},"arch":{{json .Architecture}},"layers":{{json .RootFS.Layers}},"env":{{json .Config.Env}},"user":{{json .Config.User}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"workingDir":{{json .Config.WorkingDir}},"volumes":{{json (index .Config "Volumes")}}}';

/** Fixed arguments, bounded output, one overall deadline, and no inherited secrets. */
async function dockerCommand(args: string[], home: string, signal: AbortSignal): Promise<DockerResult> {
  if (signal.aborted) throw new RepositoryImageError('BUILD_FAILED', 'Image build failed or timed out');
  return await new Promise((resolveCommand, reject) => {
    const child = spawn('docker', args, { cwd: home, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
    let stdout = ''; let stderr = ''; let aborted = false;
    const stop = () => { aborted = true; try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already gone */ } };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length + chunk.length > 128 * 1024) stop(); else stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length + chunk.length > 128 * 1024) stop(); else stderr += chunk.toString(); });
    child.once('error', () => { signal.removeEventListener('abort', stop); reject(new RepositoryImageError('BUILD_FAILED', 'Image builder failed')); });
    child.once('close', code => {
      signal.removeEventListener('abort', stop);
      if (aborted) reject(new RepositoryImageError('BUILD_FAILED', 'Image build failed or timed out'));
      else resolveCommand({ code, stdout, stderr });
    });
  });
}

async function inspectImage(reference: string, home: string, signal: AbortSignal, allowMissing = false): Promise<ImageDetails | null> {
  const result = await dockerCommand(['image', 'inspect', '--format', inspectFormat, reference], home, signal);
  if (result.code !== 0) {
    if (allowMissing && /No such image:/i.test(result.stderr)) return null;
    throw new RepositoryImageError('BUILD_FAILED', 'Image inspection failed');
  }
  let value: ImageDetails;
  try { value = JSON.parse(result.stdout); } catch { throw new RepositoryImageError('BUILD_FAILED', 'Image inspection failed'); }
  if (!value || typeof value !== 'object' || !imagePattern.test(value.id) || value.os !== 'linux' ||
      !['amd64', 'arm64'].includes(value.arch) || !Array.isArray(value.layers) || value.layers.length === 0 ||
      value.layers.length > 256 || !value.layers.every(layer => typeof layer === 'string' && imagePattern.test(layer)) ||
      !(value.volumes === null || (typeof value.volumes === 'object' && !Array.isArray(value.volumes) && Object.keys(value.volumes).length === 0))) {
    throw new RepositoryImageError('BUILD_FAILED', 'Image inspection failed');
  }
  return value;
}

/** BuildKit requires a local tag in FROM; it is pinned and checked before and after use. */
export async function executeFixedDockerBuild(context: string, iidFile: string, tag: string, timeoutMs: number,
  runtimeImage: string, signal?: AbortSignal): Promise<void> {
  if (!imagePattern.test(runtimeImage) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !/^codeharbor-repo:[a-f0-9]{20}-[a-f0-9-]{36}$/.test(tag)) throw new RepositoryImageError('BUILD_FAILED', 'Invalid image build arguments');
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  // Docker Desktop installs buildx outside the system search path; use a fresh
  // config containing only that official plugin directory, never user credentials.
  if (process.platform === 'darwin') {
    const pluginDirectory = '/Applications/Docker.app/Contents/Resources/cli-plugins';
    try { await access(join(pluginDirectory, 'docker-buildx'), constants.X_OK); }
    catch { throw new RepositoryImageError('BUILD_FAILED', 'Docker buildx is unavailable'); }
    const dockerConfig = join(context, '.docker');
    await mkdir(dockerConfig, { mode: 0o700 });
    await writeFile(join(dockerConfig, 'config.json'), JSON.stringify({ cliPluginsExtraDirs: [pluginDirectory] }), { mode: 0o600, flag: 'wx' });
  }
  const baseline = await inspectImage(runtimeImage, context, combined);
  if (!baseline || baseline.id !== runtimeImage) throw new RepositoryImageError('BUILD_FAILED', 'Runtime image mismatch');
  const runtimeTag = `codeharbor-runtime:sha-${runtimeImage.slice(7)}`;
  const existing = await inspectImage(runtimeTag, context, combined, true);
  if (existing && existing.id !== runtimeImage) throw new RepositoryImageError('BUILD_FAILED', 'Runtime image tag mismatch');
  if (!existing) {
    const tagged = await dockerCommand(['image', 'tag', runtimeImage, runtimeTag], context, combined);
    if (tagged.code !== 0) throw new RepositoryImageError('BUILD_FAILED', 'Runtime image tag failed');
  }
  const before = await inspectImage(runtimeTag, context, combined);
  if (!before || before.id !== runtimeImage) throw new RepositoryImageError('BUILD_FAILED', 'Runtime image tag mismatch');
  const dockerfilePath = join(context, 'Dockerfile');
  const dockerfile = await readFile(dockerfilePath, 'utf8');
  if (!dockerfile.startsWith(`FROM ${runtimeImage}\n`)) throw new RepositoryImageError('BUILD_FAILED', 'Invalid runtime image');
  await writeFile(dockerfilePath, `FROM ${runtimeTag}\n${dockerfile.slice(`FROM ${runtimeImage}\n`.length)}`, { mode: 0o600 });
  const result = await dockerCommand(['build', '--platform', `linux/${baseline.arch}`, '--network=none', '--pull=false', '--iidfile', iidFile, '--tag', tag, context], context, combined);
  if (result.code !== 0) throw new RepositoryImageError('BUILD_FAILED', 'Image build failed');
  const imageId = (await readFile(iidFile, 'utf8')).trim();
  if (!imagePattern.test(imageId)) throw new RepositoryImageError('BUILD_FAILED', 'Image builder returned an invalid image ID');
  const after = await inspectImage(runtimeTag, context, combined);
  const built = await inspectImage(imageId, context, combined);
  if (!after || after.id !== runtimeImage || !built || built.id !== imageId || built.os !== baseline.os || built.arch !== baseline.arch ||
      built.layers.length < baseline.layers.length || baseline.layers.some((layer, index) => built.layers[index] !== layer) ||
      ['env', 'user', 'entrypoint', 'cmd', 'workingDir'].some(key => JSON.stringify(built[key as keyof ImageDetails]) !== JSON.stringify(baseline[key as keyof ImageDetails]))) {
    throw new RepositoryImageError('BUILD_FAILED', 'Image provenance verification failed');
  }
}

async function directory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new RepositoryImageError('UNSAFE_TREE', 'Unsafe candidate directory');
}

async function verifyCandidate(input: RepositoryImageRequest): Promise<void> {
  if (!idPattern.test(input.repositoryId) || !generationPattern.test(input.candidate.generation) ||
      !commitPattern.test(input.candidate.commit) || !imagePattern.test(input.runtimeImage)) {
    throw new RepositoryImageError('INVALID_ARGUMENT', 'Invalid image build arguments');
  }
  const versions = resolve(input.dataDir, 'repositories', input.repositoryId, 'versions');
  const generation = join(versions, input.candidate.generation);
  if (resolve(input.candidate.path) !== join(generation, 'worktree')) {
    throw new RepositoryImageError('UNSAFE_TREE', 'Candidate is outside the repository generation');
  }
  for (const p of [resolve(input.dataDir), join(resolve(input.dataDir), 'repositories'),
    dirname(versions), versions, generation, input.candidate.path, join(input.candidate.path, '.codegraph')]) await directory(p);
  const marker = join(generation, '.codeharbor-generation.json');
  const markerInfo = await lstat(marker);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 512) throw new RepositoryImageError('UNSAFE_TREE', 'Invalid candidate marker');
  const metadata = JSON.parse(await readFile(marker, 'utf8'));
  if (metadata.version !== 1 || metadata.repositoryId !== input.repositoryId || metadata.generation !== input.candidate.generation) {
    throw new RepositoryImageError('UNSAFE_TREE', 'Candidate ownership does not match');
  }
}

/** Copies regular source files only; Git internals and generated index state are handled separately. */
async function copySources(source: string, target: string, budget = { entries: 0, bytes: 0 }, depth = 0): Promise<void> {
  if (depth > maxDepth) throw new RepositoryImageError('CONTEXT_TOO_LARGE', 'Repository tree is too deep');
  await mkdir(target, { mode: 0o755 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.codegraph') continue;
    if (++budget.entries > maxEntries) throw new RepositoryImageError('CONTEXT_TOO_LARGE', 'Repository has too many entries');
    const from = join(source, entry.name); const to = join(target, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new RepositoryImageError('UNSAFE_TREE', 'Symbolic links cannot be packaged');
    if (info.isDirectory()) await copySources(from, to, budget, depth + 1);
    else if (info.isFile()) {
      budget.bytes += info.size;
      if (!Number.isSafeInteger(budget.bytes) || budget.bytes > maxSourceBytes) throw new RepositoryImageError('CONTEXT_TOO_LARGE', 'Repository source is too large');
      if (info.size === 0) await writeFile(to, '', { mode: 0o644, flag: 'wx' });
      else {
        const handle = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await pipeline(handle.createReadStream({ end: info.size - 1 }), createWriteStream(to, { flags: 'wx', mode: 0o644 })); }
        finally { await handle.close().catch(() => {}); }
        if ((await lstat(to)).size !== info.size) throw new RepositoryImageError('UNSAFE_TREE', 'Repository changed while packaging');
      }
    }
    else throw new RepositoryImageError('UNSAFE_TREE', 'Non-regular repository entry cannot be packaged');
  }
}

/** SQLite backup copies a consistent database, including committed WAL contents, without copying WAL/SHM files. */
async function snapshotIndex(source: string, target: string, budget: { bytes: number }): Promise<void> {
  const dbPath = join(source, '.codegraph', 'codegraph.db');
  const info = await lstat(dbPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new RepositoryImageError('INVALID_INDEX', 'CodeGraph index is unavailable');
  let walSize = 0;
  try {
    const wal = await lstat(`${dbPath}-wal`);
    if (!wal.isFile() || wal.isSymbolicLink()) throw new RepositoryImageError('UNSAFE_TREE', 'Invalid index WAL');
    walSize = wal.size;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (budget.bytes + info.size + walSize > maxSourceBytes) throw new RepositoryImageError('CONTEXT_TOO_LARGE', 'Repository index is too large');
  await mkdir(join(target, '.codegraph'), { mode: 0o755 });
  await writeFile(join(target, '.codegraph', '.gitignore'), '*\n', { mode: 0o644, flag: 'wx' });
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try { await backup(database, join(target, '.codegraph', 'codegraph.db')); }
  finally { database.close(); }
  if (budget.bytes + (await lstat(join(target, '.codegraph', 'codegraph.db'))).size > maxSourceBytes) throw new RepositoryImageError('CONTEXT_TOO_LARGE', 'Repository index is too large');
  // A readonly snapshot must not depend on WAL/SHM sidecars being writable or
  // present. Conversion happens on the isolated snapshot, never the candidate.
  const snapshot = new DatabaseSync(join(target, '.codegraph', 'codegraph.db'));
  try {
    const mode = snapshot.prepare('PRAGMA journal_mode=DELETE').get();
    if (mode?.journal_mode !== 'delete') throw new RepositoryImageError('INVALID_INDEX', 'Cannot finalize index snapshot');
    const check = snapshot.prepare('PRAGMA quick_check').get();
    if (check?.quick_check !== 'ok') throw new RepositoryImageError('INVALID_INDEX', 'Index snapshot failed integrity check');
  } finally { snapshot.close(); }
}

const runDocker: ImageBuildExecutor = async (context, iidFile, tag, timeoutMs) => {
  const dockerfile = await readFile(join(context, 'Dockerfile'), 'utf8');
  const match = /^FROM (sha256:[a-f0-9]{64})\n/.exec(dockerfile);
  if (!match) throw new RepositoryImageError('BUILD_FAILED', 'Invalid runtime image');
  await executeFixedDockerBuild(context, iidFile, tag, timeoutMs, match[1]);
};

/**
 * Packages a validated index candidate using platform-authored instructions only.
 * The runtime image must already contain the readonly CodeGraph query adapter.
 * Candidate input is owned by the index worker; no credential is accepted here.
 */
export async function buildRepositoryImage(input: RepositoryImageRequest, execute: ImageBuildExecutor = runDocker): Promise<RepositoryImageBuildResult> {
  let context: string | undefined;
  try {
    await verifyCandidate(input);
    context = await mkdtemp(join(tmpdir(), 'codeharbor-image-build-'));
    const repoDir = join(context, 'repo');
    const budget = { entries: 0, bytes: 0 };
    await copySources(input.candidate.path, repoDir, budget);
    await snapshotIndex(input.candidate.path, repoDir, budget);
    const dockerfile = [
      `FROM ${input.runtimeImage}`,
      'COPY --chown=1000:1000 repo /workspace/repo',
      `LABEL io.codeharbor.repository-id="${input.repositoryId}"`,
      `LABEL io.codeharbor.commit="${input.candidate.commit}"`,
      'LABEL io.codeharbor.codegraph-version="1.6.2"',
      '',
    ].join('\n');
    await writeFile(join(context, 'Dockerfile'), dockerfile, { mode: 0o600, flag: 'wx' });
    const iidFile = join(context, 'image.id');
    const tag = `codeharbor-repo:${createHash('sha256').update(input.repositoryId).digest('hex').slice(0, 20)}-${input.candidate.generation}`;
    await execute(context, iidFile, tag, input.timeoutMs ?? 10 * 60_000);
    const imageId = (await readFile(iidFile, 'utf8')).trim();
    if (!imagePattern.test(imageId)) throw new RepositoryImageError('BUILD_FAILED', 'Image builder returned an invalid image ID');
    return { image: `oci://sha256:${imageId.slice(7)}`, commit: input.candidate.commit, repositoryId: input.repositoryId, codegraphVersion: '1.6.2' };
  } catch (error) {
    if (error instanceof RepositoryImageError) throw error;
    throw new RepositoryImageError('BUILD_FAILED', 'Repository image could not be built');
  } finally {
    if (context) await rm(context, { recursive: true, force: true });
  }
}
