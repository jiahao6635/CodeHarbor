import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { JobPhase } from './store.js';

/** The caller must obtain cloneUrl from Codeup, not from an API client. */
export interface IndexRequest {
  dataDir: string;
  repositoryId: string;
  branch: string;
  cloneUrl: string;
  allowedGitHosts: string[];
  gitUsername: string;
  token: string;
  codegraphBin?: string;
  timeoutMs?: number;
  onProgress?: (phase: Extract<JobPhase, 'cloning' | 'indexing' | 'packaging'>) => Promise<void>;
}

export interface IndexCandidate {
  path: string;
  commit: string;
  generation: string;
}

export class IndexError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'IndexError';
  }
}

export function validateRequest(request: IndexRequest): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(request.repositoryId)) {
    throw new IndexError('INVALID_REPOSITORY', 'Invalid repository ID');
  }
  // Git branch names have more constraints, checked by git check-ref-format below.
  if (!request.branch || request.branch.startsWith('-') || request.branch.length > 255) {
    throw new IndexError('INVALID_BRANCH', 'Invalid branch');
  }
  if (!request.gitUsername || !request.token || /[\r\n\0]/.test(request.gitUsername + request.token)) {
    throw new IndexError('INVALID_CREDENTIAL', 'Invalid Git credential');
  }
  let url: URL;
  try {
    url = new URL(request.cloneUrl);
  } catch {
    throw new IndexError('INVALID_REMOTE', 'Invalid Git remote');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !request.allowedGitHosts.some((host) => host.toLowerCase() === url.host.toLowerCase())
  ) {
    throw new IndexError('INVALID_REMOTE', 'Git remote is not an allowed HTTPS host');
  }
  return url.href;
}

function environment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: tmpdir(),
    LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    DO_NOT_TRACK: '1',
    CODEGRAPH_NO_DOWNLOAD: '1',
  };
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

const gitOptions = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'credential.helper=',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'http.followRedirects=false',
];
const generationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ownershipMarker = '.codeharbor-generation.json';

async function gitEnvironment(home: string, request: IndexRequest): Promise<NodeJS.ProcessEnv> {
  const askpass = join(home, 'askpass');
  await writeFile(
    askpass,
    '#!/bin/sh\ncase "$1" in *sername*) printf "%s\\n" "$CODEHARBOR_GIT_USERNAME" ;; *) printf "%s\\n" "$CODEHARBOR_GIT_TOKEN" ;; esac\n',
    { mode: 0o700, flag: 'wx' },
  );
  return {
    ...environment(home),
    GIT_ASKPASS: askpass,
    CODEHARBOR_GIT_USERNAME: request.gitUsername,
    CODEHARBOR_GIT_TOKEN: request.token,
  };
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  step: string,
): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
    });
    const killTree = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* The process may already have exited. */
      }
    };
    let output = '';
    let tooMuch = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 1024 * 1024) {
        tooMuch = true;
        killTree();
      } else output += chunk.toString();
    });
    // Never expose subprocess stderr: Git and CodeGraph can print sensitive data.
    child.stderr.resume();
    const timer = setTimeout(killTree, timeoutMs);
    timer.unref();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new IndexError('EXECUTION_FAILED', `${step} could not start`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 2 && step === 'git ls-remote')
        reject(new IndexError('BRANCH_NOT_FOUND', 'Remote branch does not exist'));
      else if (code !== 0 || tooMuch) reject(new IndexError('EXECUTION_FAILED', `${step} failed or timed out`));
      else resolveRun(output.trim());
    });
  });
}

async function rejectSymlinks(root: string): Promise<void> {
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === '.git') continue;
      const path = join(dir, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new IndexError('UNSAFE_TREE', 'Repository contains symbolic links');
      if (metadata.isDirectory()) pending.push(path);
    }
  }
}

function completeStatus(output: string): boolean {
  try {
    const status = JSON.parse(output);
    const pending = status.pendingChanges;
    return (
      status.initialized === true &&
      status.index?.state === 'complete' &&
      !!pending &&
      pending.added === 0 &&
      pending.modified === 0 &&
      pending.removed === 0 &&
      status.worktreeMismatch === null
    );
  } catch {
    return false;
  }
}

/** Verify a previously published checkout and its index before skipping a rebuild. */
export async function isPublishedIndexHealthy(
  request: IndexRequest,
  worktree: string,
  commit: string,
): Promise<boolean> {
  try {
    validateRequest(request);
    if (!/^[0-9a-f]{40,64}$/.test(commit)) return false;
    const versions = resolve(request.dataDir, 'repositories', request.repositoryId, 'versions');
    const parts = relative(versions, resolve(worktree)).split(/[\\/]/);
    if (parts.length !== 2 || !/^[0-9a-f-]{36}$/.test(parts[0]) || parts[1] !== 'worktree') return false;
    for (const path of [
      versions,
      join(versions, parts[0]),
      worktree,
      join(worktree, '.git'),
      join(worktree, '.codegraph'),
    ]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
    }
    const home = await mkdtemp(join(tmpdir(), 'codeharbor-status-'));
    try {
      const env = environment(home);
      const timeout = request.timeoutMs ?? 10 * 60_000;
      const git = (args: string[]) => run('git', [...gitOptions, ...args], worktree, env, timeout, `git ${args[0]}`);
      if ((await git(['rev-parse', 'HEAD^{commit}'])) !== commit) return false;
      if (await git(['status', '--porcelain', '--untracked-files=no'])) return false;
      const status = await run(
        request.codegraphBin ?? 'codegraph',
        ['status', worktree, '--json'],
        home,
        env,
        timeout,
        'CodeGraph status',
      );
      return completeStatus(status);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
}

async function readRemoteHead(
  git: (args: string[]) => Promise<string>,
  remote: string,
  branch: string,
): Promise<string> {
  const output = await git(['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`]);
  const lines = output.split('\n');
  const [commit, ref] = (lines[0] ?? '').split(/\s+/);
  if (lines.length !== 1 || !/^[0-9a-f]{40,64}$/.test(commit ?? '') || ref !== `refs/heads/${branch}`) {
    throw new IndexError('INVALID_COMMIT', 'Git returned an invalid branch HEAD');
  }
  return commit;
}

/** Check the remote branch using the same authenticated, constrained Git transport. */
export async function getRemoteHead(request: IndexRequest): Promise<string> {
  const remote = validateRequest(request);
  const home = await mkdtemp(join(tmpdir(), 'codeharbor-git-'));
  try {
    const env = await gitEnvironment(home, request);
    const git = (args: string[]) =>
      run('git', [...gitOptions, ...args], home, env, request.timeoutMs ?? 10 * 60_000, `git ${args[0]}`);
    await git(['check-ref-format', '--branch', request.branch]);
    return await readRemoteHead(git, remote, request.branch);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Build an isolated full-index candidate. Caller serializes jobs and handles publication,
 * session draining and metadata persistence. A successful candidate is not yet published.
 */
export async function buildIndexCandidate(request: IndexRequest): Promise<IndexCandidate> {
  const remote = validateRequest(request);
  const generation = randomUUID();
  const versions = join(resolve(request.dataDir), 'repositories', request.repositoryId, 'versions');
  const directory = join(versions, generation);
  await mkdir(versions, { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const worktree = join(directory, 'worktree');
  const home = join(directory, 'home');
  try {
    await writeFile(
      join(directory, ownershipMarker),
      JSON.stringify({ version: 1, repositoryId: request.repositoryId, generation }),
      { mode: 0o600, flag: 'wx' },
    );
    await mkdir(home, { mode: 0o700 });
    const baseEnv = environment(home);
    const gitEnv = await gitEnvironment(home, request);
    const timeout = request.timeoutMs ?? 10 * 60_000;
    const git = (args: string[], cwd = home) =>
      run('git', [...gitOptions, ...args], cwd, gitEnv, timeout, `git ${args[0]}`);
    await git(['check-ref-format', '--branch', request.branch]);
    await request.onProgress?.('cloning');
    await git(['clone', '--no-checkout', '--single-branch', '--branch', request.branch, '--', remote, worktree]);
    const commit = await git(['rev-parse', 'HEAD^{commit}'], worktree);
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new IndexError('INVALID_COMMIT', 'Git returned an invalid commit');
    await git(['checkout', '--detach', commit, '--'], worktree);
    await rejectSymlinks(worktree);
    try {
      const existing = join(worktree, '.codegraph');
      const metadata = await lstat(existing);
      if (!metadata.isDirectory() || (await readdir(existing)).some((name) => name !== '.gitignore')) {
        throw new IndexError('UNSAFE_TREE', 'Repository contains existing CodeGraph state');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const codegraph = request.codegraphBin ?? 'codegraph';
    await request.onProgress?.('indexing');
    await run(codegraph, ['init', worktree, '--yes'], home, baseEnv, timeout, 'CodeGraph init');
    const statusOutput = await run(
      codegraph,
      ['status', worktree, '--json'],
      home,
      baseEnv,
      timeout,
      'CodeGraph status',
    );
    if (!completeStatus(statusOutput)) {
      throw new IndexError('INDEX_INCOMPLETE', 'CodeGraph index is incomplete or stale');
    }
    const current = await readRemoteHead(git, remote, request.branch);
    if (current !== commit) throw new IndexError('REMOTE_CHANGED', 'Branch changed while index was building');
    await rm(home, { recursive: true, force: true });
    return { path: worktree, commit, generation };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof IndexError) throw error;
    throw new IndexError('INDEX_FAILED', 'Could not build repository index');
  }
}

/** Called only while queries and version publication are exclusively locked. */
export async function pruneIndexVersions(
  dataDir: string,
  repositoryId: string,
  retainedPaths: Array<string | null>,
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(repositoryId)) return;
  const versions = resolve(dataDir, 'repositories', repositoryId, 'versions');
  const retained = new Set(retainedPaths.filter((path): path is string => !!path).map((path) => resolve(path)));
  try {
    const root = await lstat(versions);
    if (!root.isDirectory() || root.isSymbolicLink()) return;
    for (const entry of await readdir(versions, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !generationPattern.test(entry.name)) continue;
      const generationDir = join(versions, entry.name);
      if (retained.has(resolve(generationDir, 'worktree'))) continue;
      try {
        const marker = join(generationDir, ownershipMarker);
        const info = await lstat(marker);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 512) continue;
        const owner = JSON.parse(await readFile(marker, 'utf8'));
        if (owner.version !== 1 || owner.repositoryId !== repositoryId || owner.generation !== entry.name) continue;
        await rm(generationDir, { recursive: true, force: true });
      } catch {
        /* Retain unrecognized or inaccessible directories. */
      }
    }
  } catch {
    /* Missing/inaccessible version storage must not break publication. */
  }
}

export interface WebhookInput {
  token: string | undefined;
  expectedToken: string;
  event: string | undefined;
  body: unknown;
  codeupRepositoryId: string;
  branch: string;
}

/** Validate a Codeup push notification. The returned SHA is only a hint. */
export function verifyPushWebhook(input: WebhookInput): 'enqueue' | 'branch_deleted' | 'ignore' {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!input.token || !input.expectedToken || !timingSafeEqual(digest(input.token), digest(input.expectedToken))) {
    throw new IndexError('INVALID_WEBHOOK_TOKEN', 'Invalid webhook token');
  }
  if (input.event !== 'Push Hook') return 'ignore';
  if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
    throw new IndexError('INVALID_WEBHOOK', 'Invalid webhook payload');
  }
  const body = input.body as Record<string, unknown>;
  if (body.object_kind !== 'push' || String(body.project_id) !== input.codeupRepositoryId) {
    throw new IndexError('INVALID_WEBHOOK', 'Webhook repository does not match');
  }
  if (body.ref !== `refs/heads/${input.branch}`) return 'ignore';
  if (typeof body.after !== 'string' || !/^[0-9a-f]{40,64}$/.test(body.after)) {
    throw new IndexError('INVALID_WEBHOOK', 'Invalid webhook commit');
  }
  return /^0+$/.test(body.after) ? 'branch_deleted' : 'enqueue';
}
