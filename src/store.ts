import { DatabaseSync } from 'node:sqlite';

export type UserRecord = {
  id: string;
  username: string;
  credential: string;
  credential_version: number;
};

export type KeyRecord = {
  hash: string;
  prefix: string;
  owner: string;
  scope: 'read' | 'write';
  /** null means all repositories that the owner can currently access. */
  repos: string[] | null;
  expires_at: number | null;
  revoked: number;
};

export type RepositoryRecord = {
  id: string;
  codeup_id: string;
  name: string;
  branch: string;
  owner: string;
  sync_owner: string;
  sync_credential_version: number;
  hook_hash: string;
  path: string | null;
  commit: string | null;
  /** Last published OCI generation, absent for pre-image and older records. */
  previous_image?: string | null;
  previous_commit?: string | null;
  indexed_at: number | null;
  status: string;
  error: string | null;
};

export type JobRecord = {
  id: string;
  repo_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  reason: string;
  created_at: number;
  /** Waiting start is reset when an interrupted attempt is requeued. */
  queued_at?: number | null;
  /** Only newly completed tasks have a known completion time. */
  finished_at?: number | null;
  /** Monotonic elapsed time for the actual build; null if no build completed. */
  build_duration_ms?: number | null;
  error: string | null;
};

export const BUILD_DURATION_BUCKETS_MS = [1000, 5000, 10000, 30000, 60000, 120000, 300000, 600000, 1800000] as const;
export type JobMetrics = {
  queued: number;
  oldestQueuedAt: number | null;
  completed24h: number;
  succeeded24h: number;
  failed24h: number;
  builds24h: number;
  buildDurationSumMs24h: number;
  buildDurationMaxMs24h: number | null;
  buildDurationLastMs24h: number | null;
  buildBuckets24h: number[];
};

/** SQL aggregates only jobs finished in the window, plus the current queue. */
export function jobMetricsQuery(lower: string, upper: string): string {
  return `WITH finished AS (
    SELECT id, status, finished_at, build_duration_ms FROM jobs
    WHERE status IN ('succeeded', 'failed') AND finished_at >= ${lower} AND finished_at <= ${upper}
  ) SELECT
    (SELECT COUNT(*) FROM jobs WHERE status = 'queued') AS queued,
    (SELECT MIN(COALESCE(queued_at, created_at)) FROM jobs WHERE status = 'queued') AS oldest_queued_at,
    COUNT(*) AS completed_24h,
    SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_24h,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_24h,
    COUNT(build_duration_ms) AS builds_24h,
    SUM(build_duration_ms) AS build_duration_sum_ms_24h,
    MAX(build_duration_ms) AS build_duration_max_ms_24h,
    (SELECT build_duration_ms FROM finished WHERE build_duration_ms IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT 1) AS build_duration_last_ms_24h,
    ${BUILD_DURATION_BUCKETS_MS.map((bound, i) => `SUM(CASE WHEN build_duration_ms IS NOT NULL AND build_duration_ms <= ${bound} THEN 1 ELSE 0 END) AS bucket_${i}`).join(',\n    ')}
  FROM finished`;
}

export function parseJobMetrics(row: Record<string, unknown>): JobMetrics {
  const count = (key: string) => Number(row[key] ?? 0);
  const optional = (key: string) => row[key] == null ? null : Number(row[key]);
  return { queued: count('queued'), oldestQueuedAt: optional('oldest_queued_at'), completed24h: count('completed_24h'),
    succeeded24h: count('succeeded_24h'), failed24h: count('failed_24h'), builds24h: count('builds_24h'),
    buildDurationSumMs24h: count('build_duration_sum_ms_24h'), buildDurationMaxMs24h: optional('build_duration_max_ms_24h'),
    buildDurationLastMs24h: optional('build_duration_last_ms_24h'),
    buildBuckets24h: BUILD_DURATION_BUCKETS_MS.map((_bound, i) => count(`bucket_${i}`)) };
}

type RepoUpdate = Partial<Omit<RepositoryRecord, 'id' | 'codeup_id'>>;
type JobUpdate = Partial<Pick<JobRecord, 'status' | 'error' | 'queued_at' | 'finished_at' | 'build_duration_ms'>>;

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        credential TEXT NOT NULL,
        credential_version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE TABLE IF NOT EXISTS keys (
        hash TEXT PRIMARY KEY,
        prefix TEXT NOT NULL,
        owner TEXT NOT NULL REFERENCES users(id),
        scope TEXT NOT NULL CHECK(scope IN ('read', 'write')),
        repos TEXT NOT NULL,
        expires_at INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS keys_owner_idx ON keys(owner);
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        codeup_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        branch TEXT NOT NULL,
        owner TEXT NOT NULL REFERENCES users(id),
        sync_owner TEXT NOT NULL REFERENCES users(id),
        sync_credential_version INTEGER NOT NULL DEFAULT 0 CHECK(sync_credential_version >= 0),
        hook_hash TEXT NOT NULL,
        path TEXT,
        commit_sha TEXT,
        previous_image TEXT,
        previous_commit TEXT,
        indexed_at INTEGER,
        status TEXT NOT NULL,
        error TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed')),
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        queued_at INTEGER,
        finished_at INTEGER,
        build_duration_ms INTEGER,
        error TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, created_at);
    `);
    const columns = this.db.prepare('PRAGMA table_info(repositories)').all();
    if (!columns.some((column) => column.name === 'sync_credential_version')) {
      // Existing credentials were never explicitly authorized for their current version.
      this.db.exec('ALTER TABLE repositories ADD COLUMN sync_credential_version INTEGER NOT NULL DEFAULT 0 CHECK(sync_credential_version >= 0)');
    }
    if (!columns.some((column) => column.name === 'previous_image')) this.db.exec('ALTER TABLE repositories ADD COLUMN previous_image TEXT');
    if (!columns.some((column) => column.name === 'previous_commit')) this.db.exec('ALTER TABLE repositories ADD COLUMN previous_commit TEXT');
    const jobColumns = this.db.prepare('PRAGMA table_info(jobs)').all();
    if (!jobColumns.some(column => column.name === 'queued_at')) this.db.exec('ALTER TABLE jobs ADD COLUMN queued_at INTEGER');
    if (!jobColumns.some(column => column.name === 'finished_at')) this.db.exec('ALTER TABLE jobs ADD COLUMN finished_at INTEGER');
    if (!jobColumns.some(column => column.name === 'build_duration_ms')) this.db.exec('ALTER TABLE jobs ADD COLUMN build_duration_ms INTEGER');
    this.db.exec('CREATE INDEX IF NOT EXISTS jobs_finished_idx ON jobs(finished_at)');
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = await fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createUser(user: UserRecord): void {
    this.db.prepare('INSERT INTO users (id, username, credential, credential_version) VALUES (?, ?, ?, ?)')
      .run(user.id, user.username, user.credential, user.credential_version);
  }

  getUser(id: string): UserRecord | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRecord | undefined;
  }

  updateUserCredential(id: string, username: string, credential: string): void {
    this.db.prepare('UPDATE users SET username = ?, credential = ?, credential_version = credential_version + 1 WHERE id = ?')
      .run(username, credential, id);
  }

  createKey(key: KeyRecord): void {
    this.db.prepare('INSERT INTO keys (hash, prefix, owner, scope, repos, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(key.hash, key.prefix, key.owner, key.scope, JSON.stringify(key.repos), key.expires_at, key.revoked);
  }

  private readKey(row: Record<string, unknown> | undefined): KeyRecord | undefined {
    if (!row) return undefined;
    const repos: unknown = JSON.parse(row.repos as string);
    if (repos !== null && (!Array.isArray(repos) || !repos.every((item) => typeof item === 'string'))) throw new Error('Invalid stored key scope');
    return { ...row, repos } as KeyRecord;
  }

  getKey(hash: string): KeyRecord | undefined {
    return this.readKey(this.db.prepare('SELECT * FROM keys WHERE hash = ?').get(hash));
  }

  listKeys(owner: string): KeyRecord[] {
    return this.db.prepare('SELECT * FROM keys WHERE owner = ? ORDER BY prefix').all(owner)
      .map((row) => this.readKey(row)!);
  }

  revokeKey(hash: string): void {
    this.db.prepare('UPDATE keys SET revoked = 1 WHERE hash = ?').run(hash);
  }

  revokeUserKeys(owner: string): void {
    this.db.prepare('UPDATE keys SET revoked = 1 WHERE owner = ?').run(owner);
  }

  createRepository(repo: RepositoryRecord): void {
    this.db.prepare(`INSERT INTO repositories
      (id, codeup_id, name, branch, owner, sync_owner, sync_credential_version, hook_hash, path, commit_sha, previous_image, previous_commit, indexed_at, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(repo.id, repo.codeup_id, repo.name, repo.branch, repo.owner, repo.sync_owner, repo.sync_credential_version, repo.hook_hash,
        repo.path, repo.commit, repo.previous_image ?? null, repo.previous_commit ?? null, repo.indexed_at, repo.status, repo.error);
  }

  getRepository(id: string): RepositoryRecord | undefined {
    return this.db.prepare('SELECT id, codeup_id, name, branch, owner, sync_owner, sync_credential_version, hook_hash, path, commit_sha AS "commit", previous_image, previous_commit, indexed_at, status, error FROM repositories WHERE id = ?')
      .get(id) as RepositoryRecord | undefined;
  }

  getRepositoryByCodeupId(id: string): RepositoryRecord | undefined {
    return this.db.prepare('SELECT id, codeup_id, name, branch, owner, sync_owner, sync_credential_version, hook_hash, path, commit_sha AS "commit", previous_image, previous_commit, indexed_at, status, error FROM repositories WHERE codeup_id = ?')
      .get(id) as RepositoryRecord | undefined;
  }

  listRepositories(): RepositoryRecord[] {
    return this.db.prepare('SELECT id, codeup_id, name, branch, owner, sync_owner, sync_credential_version, hook_hash, path, commit_sha AS "commit", previous_image, previous_commit, indexed_at, status, error FROM repositories ORDER BY id')
      .all() as RepositoryRecord[];
  }

  updateRepository(id: string, patch: RepoUpdate): void {
    const columns: Record<string, string> = {
      name: 'name', branch: 'branch', owner: 'owner', sync_owner: 'sync_owner', sync_credential_version: 'sync_credential_version', hook_hash: 'hook_hash',
      path: 'path', commit: 'commit_sha', previous_image: 'previous_image', previous_commit: 'previous_commit', indexed_at: 'indexed_at', status: 'status', error: 'error',
    };
    const entries = Object.entries(patch).filter(([key, value]) => Object.hasOwn(columns, key) && value !== undefined);
    if (entries.length === 0) return;
    const assignments = entries.map(([key]) => `${columns[key]} = ?`).join(', ');
    this.db.prepare(`UPDATE repositories SET ${assignments} WHERE id = ?`)
      .run(...entries.map(([, value]) => value as string | number | null), id);
  }

  deleteRepository(id: string): void {
    this.db.prepare('DELETE FROM repositories WHERE id = ?').run(id);
  }

  createJob(job: JobRecord): void {
    this.db.prepare('INSERT INTO jobs (id, repo_id, status, reason, created_at, queued_at, finished_at, build_duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(job.id, job.repo_id, job.status, job.reason, job.created_at, job.queued_at ?? job.created_at,
        job.finished_at ?? null, job.build_duration_ms ?? null, job.error);
  }

  getJob(id: string): JobRecord | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRecord | undefined;
  }

  listJobs(repoId: string): JobRecord[] {
    return this.db.prepare('SELECT * FROM jobs WHERE repo_id = ? ORDER BY created_at, id').all(repoId) as JobRecord[];
  }

  listPendingJobs(): JobRecord[] {
    return this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at, id").all() as JobRecord[];
  }

  jobMetrics(nowMs: number): JobMetrics {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('Invalid metrics time');
    const row = this.db.prepare(jobMetricsQuery('?', '?')).get(nowMs - 86_400_000, nowMs);
    if (!row) throw new Error('Job metrics unavailable');
    return parseJobMetrics(row);
  }

  updateJob(id: string, patch: JobUpdate): void {
    const entries = Object.entries(patch).filter(([key, value]) => ['status', 'error', 'queued_at', 'finished_at', 'build_duration_ms'].includes(key) && value !== undefined);
    if (entries.length === 0) return;
    this.db.prepare(`UPDATE jobs SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value as string | number | null), id);
  }
}
