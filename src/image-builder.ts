import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
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
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryImageError';
  }
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
type ImageDetails = {
  id: string;
  os: string;
  arch: string;
  layers: string[];
  env: unknown;
  user: unknown;
  entrypoint: unknown;
  cmd: unknown;
  workingDir: unknown;
  volumes: unknown;
};
const inspectFormat =
  '{"id":{{json .Id}},"os":{{json .Os}},"arch":{{json .Architecture}},"layers":{{json .RootFS.Layers}},"env":{{json .Config.Env}},"user":{{json .Config.User}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"workingDir":{{json .Config.WorkingDir}},"volumes":{{json (index .Config "Volumes")}}}';

/** Fixed arguments, bounded output, one overall deadline, and no inherited secrets. */
async function dockerCommand(args: string[], home: string, signal: AbortSignal): Promise<DockerResult> {
  if (signal.aborted) throw new RepositoryImageError('BUILD_FAILED', 'Image build failed or timed out');
  return await new Promise((resolveCommand, reject) => {
    const child = spawn('docker', args, {
      cwd: home,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    const stop = () => {
      aborted = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > 128 * 1024) stop();
      else stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length + chunk.length > 128 * 1024) stop();
      else stderr += chunk.toString();
    });
    child.once('error', () => {
      signal.removeEventListener('abort', stop);
      reject(new RepositoryImageError('BUILD_FAILED', 'Image builder failed'));
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', stop);
      if (aborted) reject(new RepositoryImageError('BUILD_FAILED', 'Image build failed or timed out'));
      else resolveCommand({ code, stdout, stderr });
    });
  });
}

type OwnedImageDetails = {
  id: string;
  labels: Record<string, unknown>;
  repoTags: string[] | null;
  size: number;
};
const ownedInspectFormat =
  '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"repoTags":{{json .RepoTags}},"size":{{json .Size}}}';

async function inspectOwnedImage(
  reference: string,
  home: string,
  signal: AbortSignal,
  allowMissing = false,
): Promise<OwnedImageDetails | null> {
  const result = await dockerCommand(['image', 'inspect', '--format', ownedInspectFormat, reference], home, signal);
  if (result.code !== 0) {
    if (allowMissing && /No such image:/i.test(result.stderr) && !result.stdout.trim()) return null;
    throw new RepositoryImageError('BUILD_FAILED', 'Repository image inspection failed');
  }
  let value: OwnedImageDetails;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new RepositoryImageError('BUILD_FAILED', 'Repository image inspection failed');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !imagePattern.test(value.id) ||
    !value.labels ||
    typeof value.labels !== 'object' ||
    Array.isArray(value.labels) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    !(value.repoTags === null || (Array.isArray(value.repoTags) && value.repoTags.every((tag) => typeof tag === 'string')))
  )
    throw new RepositoryImageError('BUILD_FAILED', 'Repository image inspection failed');
  return value;
}

export type OwnedRepositoryImage = {
  imageId: string;
  repositoryId: string;
  commit: string;
};

/** Removes only an immutable image whose platform-authored identity and every local tag still match. */
export async function removeOwnedRepositoryImage(
  image: OwnedRepositoryImage,
  home: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (
    !imagePattern.test(image.imageId) ||
    !idPattern.test(image.repositoryId) ||
    !commitPattern.test(image.commit) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  )
    throw new RepositoryImageError('BUILD_FAILED', 'Invalid repository image cleanup');
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const details = await inspectOwnedImage(image.imageId, home, combined, true);
  if (!details) return;
  const expectedTag = `codeharbor-repo:${createHash('sha256').update(image.repositoryId).digest('hex').slice(0, 20)}-`;
  if (
    details.id !== image.imageId ||
    details.labels['io.codeharbor.repository-id'] !== image.repositoryId ||
    details.labels['io.codeharbor.commit'] !== image.commit ||
    details.labels['io.codeharbor.codegraph-version'] !== '1.6.2' ||
    details.repoTags?.some(
      (tag) => !tag.startsWith(expectedTag) || !/^[a-f0-9-]{36}$/.test(tag.slice(expectedTag.length)),
    )
  )
    throw new RepositoryImageError('BUILD_FAILED', 'Repository image ownership changed');
  for (const tag of details.repoTags ?? []) {
    const removedTag = await dockerCommand(['image', 'rm', tag], home, combined);
    if (removedTag.code !== 0 && !/No such image:/i.test(removedTag.stderr))
      throw new RepositoryImageError('BUILD_FAILED', 'Repository image cleanup failed');
  }
  if (await inspectOwnedImage(image.imageId, home, combined, true)) {
    const removedImage = await dockerCommand(['image', 'rm', image.imageId], home, combined);
    if (removedImage.code !== 0)
      throw new RepositoryImageError('BUILD_FAILED', 'Repository image cleanup failed');
  }
  if (await inspectOwnedImage(image.imageId, home, combined, true))
    throw new RepositoryImageError('BUILD_FAILED', 'Repository image cleanup failed');
}

async function inspectImage(
  reference: string,
  home: string,
  signal: AbortSignal,
  allowMissing = false,
): Promise<ImageDetails | null> {
  const result = await dockerCommand(['image', 'inspect', '--format', inspectFormat, reference], home, signal);
  if (result.code !== 0) {
    if (allowMissing && /No such image:/i.test(result.stderr)) return null;
    throw new RepositoryImageError('BUILD_FAILED', 'Image inspection failed');
  }
  let value: ImageDetails;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new RepositoryImageError('BUILD_FAILED', 'Image inspection failed');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !imagePattern.test(value.id) ||
    value.os !== 'linux' ||
    !['amd64', 'arm64'].includes(value.arch) ||
    !Array.isArray(value.layers) ||
    value.layers.length === 0 ||
    value.layers.length > 256 ||
    !value.layers.every((layer) => typeof layer === 'string' && imagePattern.test(layer)) ||
    !(
      value.volumes === null ||
      (typeof value.volumes === 'object' && !Array.isArray(value.volumes) && Object.keys(value.volumes).length === 0)
    )
  ) {
    throw new RepositoryImageError('BUILD_FAILED', 'Image inspection failed');
  }
  return value;
}

/** Creates one repository layer without invoking Docker's persistent build cache. */
export async function executeFixedDockerBuild(
  context: string,
  iidFile: string,
  tag: string,
  timeoutMs: number,
  runtimeImage: string,
  signal?: AbortSignal,
): Promise<void> {
  if (
    !imagePattern.test(runtimeImage) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !/^codeharbor-repo:[a-f0-9]{20}-[a-f0-9-]{36}$/.test(tag)
  )
    throw new RepositoryImageError('BUILD_FAILED', 'Invalid image build arguments');
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const baseline = await inspectImage(runtimeImage, context, combined);
  if (!baseline || baseline.id !== runtimeImage || baseline.workingDir !== '/workspace/repo')
    throw new RepositoryImageError('BUILD_FAILED', 'Runtime image mismatch');
  const dockerfilePath = join(context, 'Dockerfile');
  const dockerfile = await readFile(dockerfilePath, 'utf8');
  const instructions =
    /^FROM (sha256:[a-f0-9]{64})\nCOPY --chown=1000:1000 repo \/workspace\/repo\nLABEL io\.codeharbor\.repository-id="([A-Za-z0-9_-]{1,128})"\nLABEL io\.codeharbor\.commit="([a-f0-9]{40,64})"\nLABEL io\.codeharbor\.codegraph-version="1\.6\.2"\n$/.exec(
      dockerfile,
    );
  if (!instructions || instructions[1] !== runtimeImage)
    throw new RepositoryImageError('BUILD_FAILED', 'Invalid runtime image');
  const repositoryId = instructions[2];
  const commit = instructions[3];
  const containerName = `codeharbor-build-${randomUUID()}`;
  let containerId: string | undefined;
  try {
    const created = await dockerCommand(
      [
        'container',
        'create',
        '--name',
        containerName,
        '--network',
        'none',
        '--label',
        'io.codeharbor.image-build-kind=repository',
        '--label',
        `io.codeharbor.repository-id=${repositoryId}`,
        '--label',
        `io.codeharbor.image-build-request=${tag.slice('codeharbor-repo:'.length)}`,
        runtimeImage,
      ],
      context,
      combined,
    );
    containerId = created.stdout.trim();
    if (created.code !== 0 || !/^[a-f0-9]{64}$/.test(containerId))
      throw new RepositoryImageError('BUILD_FAILED', 'Repository image container creation failed');
    const copied = await dockerCommand(
      ['container', 'cp', `${join(context, 'repo')}${sep}.`, `${containerId}:/workspace/repo`],
      context,
      combined,
    );
    if (copied.code !== 0) throw new RepositoryImageError('BUILD_FAILED', 'Repository image copy failed');
    const committed = await dockerCommand(
      [
        'container',
        'commit',
        '--change',
        `LABEL io.codeharbor.repository-id="${repositoryId}"`,
        '--change',
        `LABEL io.codeharbor.commit="${commit}"`,
        '--change',
        'LABEL io.codeharbor.codegraph-version="1.6.2"',
        containerId,
      ],
      context,
      combined,
    );
    const imageId = committed.stdout.trim();
    if (committed.code !== 0 || !imagePattern.test(imageId))
      throw new RepositoryImageError('BUILD_FAILED', 'Image builder returned an invalid image ID');
    const after = await inspectImage(runtimeImage, context, combined);
    const built = await inspectImage(imageId, context, combined);
    const owned = await inspectOwnedImage(imageId, context, combined);
    if (
      !after ||
      after.id !== runtimeImage ||
      !built ||
      built.id !== imageId ||
      !owned ||
      owned.id !== imageId ||
      owned.labels['io.codeharbor.repository-id'] !== repositoryId ||
      owned.labels['io.codeharbor.commit'] !== commit ||
      owned.labels['io.codeharbor.codegraph-version'] !== '1.6.2' ||
      (owned.repoTags !== null && owned.repoTags.length !== 0) ||
      built.os !== baseline.os ||
      built.arch !== baseline.arch ||
      built.layers.length !== baseline.layers.length + 1 ||
      baseline.layers.some((layer, index) => built.layers[index] !== layer) ||
      ['env', 'user', 'entrypoint', 'cmd', 'workingDir'].some(
        (key) =>
          JSON.stringify(built[key as keyof ImageDetails]) !== JSON.stringify(baseline[key as keyof ImageDetails]),
      )
    )
      throw new RepositoryImageError('BUILD_FAILED', 'Image provenance verification failed');
    await writeFile(iidFile, imageId, { mode: 0o600, flag: 'wx' });
  } finally {
    if (containerId) {
      const removed = await dockerCommand(['container', 'rm', containerId], context, combined);
      if (removed.code !== 0)
        throw new RepositoryImageError('BUILD_FAILED', 'Repository image container cleanup failed');
    }
  }
}

async function directory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new RepositoryImageError('UNSAFE_TREE', 'Unsafe candidate directory');
}

async function verifyCandidate(input: RepositoryImageRequest): Promise<void> {
  if (
    !idPattern.test(input.repositoryId) ||
    !generationPattern.test(input.candidate.generation) ||
    !commitPattern.test(input.candidate.commit) ||
    !imagePattern.test(input.runtimeImage)
  ) {
    throw new RepositoryImageError('INVALID_ARGUMENT', 'Invalid image build arguments');
  }
  const versions = resolve(input.dataDir, 'repositories', input.repositoryId, 'versions');
  const generation = join(versions, input.candidate.generation);
  if (resolve(input.candidate.path) !== join(generation, 'worktree')) {
    throw new RepositoryImageError('UNSAFE_TREE', 'Candidate is outside the repository generation');
  }
  for (const p of [
    resolve(input.dataDir),
    join(resolve(input.dataDir), 'repositories'),
    dirname(versions),
    versions,
    generation,
    input.candidate.path,
    join(input.candidate.path, '.codegraph'),
  ])
    await directory(p);
  const marker = join(generation, '.codeharbor-generation.json');
  const markerInfo = await lstat(marker);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 512)
    throw new RepositoryImageError('UNSAFE_TREE', 'Invalid candidate marker');
  const metadata = JSON.parse(await readFile(marker, 'utf8'));
  if (
    metadata.version !== 1 ||
    metadata.repositoryId !== input.repositoryId ||
    metadata.generation !== input.candidate.generation
  ) {
    throw new RepositoryImageError('UNSAFE_TREE', 'Candidate ownership does not match');
  }
}

/** Copies regular source files only; Git internals and generated index state are handled separately. */
async function copySources(
  source: string,
  target: string,
  budget = { entries: 0, bytes: 0 },
  depth = 0,
): Promise<void> {
  if (depth > maxDepth) throw new RepositoryImageError('CONTEXT_TOO_LARGE', 'Repository tree is too deep');
  await mkdir(target, { mode: 0o755 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.codegraph') continue;
    if (++budget.entries > maxEntries)
      throw new RepositoryImageError('CONTEXT_TOO_LARGE', 'Repository has too many entries');
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new RepositoryImageError('UNSAFE_TREE', 'Symbolic links cannot be packaged');
    if (info.isDirectory()) await copySources(from, to, budget, depth + 1);
    else if (info.isFile()) {
      budget.bytes += info.size;
      if (!Number.isSafeInteger(budget.bytes) || budget.bytes > maxSourceBytes)
        throw new RepositoryImageError('CONTEXT_TOO_LARGE', 'Repository source is too large');
      if (info.size === 0) await writeFile(to, '', { mode: 0o644, flag: 'wx' });
      else {
        const handle = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await pipeline(
            handle.createReadStream({ end: info.size - 1 }),
            createWriteStream(to, { flags: 'wx', mode: 0o644 }),
          );
        } finally {
          await handle.close().catch(() => {});
        }
        if ((await lstat(to)).size !== info.size)
          throw new RepositoryImageError('UNSAFE_TREE', 'Repository changed while packaging');
      }
    } else throw new RepositoryImageError('UNSAFE_TREE', 'Non-regular repository entry cannot be packaged');
  }
}

/** SQLite backup copies a consistent database, including committed WAL contents, without copying WAL/SHM files. */
async function snapshotIndex(source: string, target: string, budget: { bytes: number }): Promise<void> {
  const dbPath = join(source, '.codegraph', 'codegraph.db');
  const info = await lstat(dbPath);
  if (!info.isFile() || info.isSymbolicLink())
    throw new RepositoryImageError('INVALID_INDEX', 'CodeGraph index is unavailable');
  let walSize = 0;
  try {
    const wal = await lstat(`${dbPath}-wal`);
    if (!wal.isFile() || wal.isSymbolicLink()) throw new RepositoryImageError('UNSAFE_TREE', 'Invalid index WAL');
    walSize = wal.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (budget.bytes + info.size + walSize > maxSourceBytes)
    throw new RepositoryImageError('CONTEXT_TOO_LARGE', 'Repository index is too large');
  await mkdir(join(target, '.codegraph'), { mode: 0o755 });
  await writeFile(join(target, '.codegraph', '.gitignore'), '*\n', { mode: 0o644, flag: 'wx' });
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    await backup(database, join(target, '.codegraph', 'codegraph.db'));
  } finally {
    database.close();
  }
  await chmod(join(target, '.codegraph', 'codegraph.db'), 0o644);
  if (budget.bytes + (await lstat(join(target, '.codegraph', 'codegraph.db'))).size > maxSourceBytes)
    throw new RepositoryImageError('CONTEXT_TOO_LARGE', 'Repository index is too large');
  // A readonly snapshot must not depend on WAL/SHM sidecars being writable or
  // present. Conversion happens on the isolated snapshot, never the candidate.
  const snapshot = new DatabaseSync(join(target, '.codegraph', 'codegraph.db'));
  try {
    const mode = snapshot.prepare('PRAGMA journal_mode=DELETE').get();
    if (mode?.journal_mode !== 'delete')
      throw new RepositoryImageError('INVALID_INDEX', 'Cannot finalize index snapshot');
    const check = snapshot.prepare('PRAGMA quick_check').get();
    if (check?.quick_check !== 'ok')
      throw new RepositoryImageError('INVALID_INDEX', 'Index snapshot failed integrity check');
  } finally {
    snapshot.close();
  }
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
export async function buildRepositoryImage(
  input: RepositoryImageRequest,
  execute: ImageBuildExecutor = runDocker,
): Promise<RepositoryImageBuildResult> {
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
    if (!imagePattern.test(imageId))
      throw new RepositoryImageError('BUILD_FAILED', 'Image builder returned an invalid image ID');
    return {
      image: `oci://sha256:${imageId.slice(7)}`,
      commit: input.candidate.commit,
      repositoryId: input.repositoryId,
      codegraphVersion: '1.6.2',
    };
  } catch (error) {
    if (error instanceof RepositoryImageError) throw error;
    throw new RepositoryImageError('BUILD_FAILED', 'Repository image could not be built');
  } finally {
    if (context) await rm(context, { recursive: true, force: true });
  }
}
