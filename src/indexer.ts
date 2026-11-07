import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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

function validateRequest(request: IndexRequest): string {
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
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !request.allowedGitHosts.some(host => host.toLowerCase() === url.host.toLowerCase())) {
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
  };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

const gitOptions = ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'http.followRedirects=false'];

async function gitEnvironment(home: string, request: IndexRequest): Promise<NodeJS.ProcessEnv> {
  const askpass = join(home, 'askpass');
  await writeFile(askpass,
    '#!/bin/sh\ncase "$1" in *sername*) printf "%s\\n" "$CODEHARBOR_GIT_USERNAME" ;; *) printf "%s\\n" "$CODEHARBOR_GIT_TOKEN" ;; esac\n',
    { mode: 0o700, flag: 'wx' });
  return { ...environment(home), GIT_ASKPASS: askpass, CODEHARBOR_GIT_USERNAME: request.gitUsername, CODEHARBOR_GIT_TOKEN: request.token };
}

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, step: string): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let output = '';
    let tooMuch = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 1024 * 1024) {
        tooMuch = true;
        child.kill('SIGKILL');
      } else output += chunk.toString();
    });
    // Never expose subprocess stderr: Git and CodeGraph can print sensitive data.
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref();
    child.on('error', () => { clearTimeout(timer); reject(new IndexError('EXECUTION_FAILED', `${step} could not start`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || tooMuch) reject(new IndexError('EXECUTION_FAILED', `${step} failed or timed out`));
      else resolveRun(output.trim());
    });
  });
}

async function rejectSymlinks(root: string): Promise<void> {
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === '.git') continue;
      const path = join(dir, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new IndexError('UNSAFE_TREE', 'Repository contains symbolic links');
      if (metadata.isDirectory()) pending.push(path);
    }
  }
}

async function readRemoteHead(git: (args: string[]) => Promise<string>, remote: string, branch: string): Promise<string> {
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
    const git = (args: string[]) => run('git', [...gitOptions, ...args], home, env, request.timeoutMs ?? 10 * 60_000, `git ${args[0]}`);
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
  const directory = join(resolve(request.dataDir), 'repositories', request.repositoryId, 'versions', generation);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const worktree = join(directory, 'worktree');
  const home = join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const baseEnv = environment(home);
  const gitEnv = await gitEnvironment(home, request);
  const timeout = request.timeoutMs ?? 10 * 60_000;
  const git = (args: string[], cwd = home) => run('git', [...gitOptions, ...args], cwd, gitEnv, timeout, `git ${args[0]}`);
  try {
    await git(['check-ref-format', '--branch', request.branch]);
    await git(['clone', '--no-checkout', '--single-branch', '--branch', request.branch, '--', remote, worktree]);
    const commit = await git(['rev-parse', 'HEAD^{commit}'], worktree);
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new IndexError('INVALID_COMMIT', 'Git returned an invalid commit');
    await git(['checkout', '--detach', commit, '--'], worktree);
    await rejectSymlinks(worktree);
    try {
      const existing = join(worktree, '.codegraph');
      const metadata = await lstat(existing);
      if (!metadata.isDirectory() || (await readdir(existing)).some(name => name !== '.gitignore')) {
        throw new IndexError('UNSAFE_TREE', 'Repository contains existing CodeGraph state');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const codegraph = request.codegraphBin ?? 'codegraph';
    await run(codegraph, ['init', worktree, '--yes'], home, baseEnv, timeout, 'CodeGraph init');
    const statusOutput = await run(codegraph, ['status', worktree, '--json'], home, baseEnv, timeout, 'CodeGraph status');
    try {
      const status = JSON.parse(statusOutput);
      const pending = status.pendingChanges;
      if (status.initialized !== true || status.index?.state !== 'complete' || !pending ||
          pending.added !== 0 || pending.modified !== 0 || pending.removed !== 0 || status.worktreeMismatch !== null) {
        throw new Error('incomplete');
      }
    } catch {
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
