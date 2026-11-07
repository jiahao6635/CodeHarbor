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
  error: string | null;
};

type RepoUpdate = Partial<Omit<RepositoryRecord, 'id' | 'codeup_id'>>;
type JobUpdate = Partial<Pick<JobRecord, 'status' | 'error'>>;

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
        error TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, created_at);
    `);
    const columns = this.db.prepare('PRAGMA table_info(repositories)').all();
    if (!columns.some((column) => column.name === 'sync_credential_version')) {
      // Existing credentials were never explicitly authorized for their current version.
      this.db.exec('ALTER TABLE repositories ADD COLUMN sync_credential_version INTEGER NOT NULL DEFAULT 0 CHECK(sync_credential_version >= 0)');
    }
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
      (id, codeup_id, name, branch, owner, sync_owner, sync_credential_version, hook_hash, path, commit_sha, indexed_at, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(repo.id, repo.codeup_id, repo.name, repo.branch, repo.owner, repo.sync_owner, repo.sync_credential_version, repo.hook_hash,
        repo.path, repo.commit, repo.indexed_at, repo.status, repo.error);
  }

  getRepository(id: string): RepositoryRecord | undefined {
    return this.db.prepare('SELECT id, codeup_id, name, branch, owner, sync_owner, sync_credential_version, hook_hash, path, commit_sha AS "commit", indexed_at, status, error FROM repositories WHERE id = ?')
      .get(id) as RepositoryRecord | undefined;
  }

  getRepositoryByCodeupId(id: string): RepositoryRecord | undefined {
    return this.db.prepare('SELECT id, codeup_id, name, branch, owner, sync_owner, sync_credential_version, hook_hash, path, commit_sha AS "commit", indexed_at, status, error FROM repositories WHERE codeup_id = ?')
      .get(id) as RepositoryRecord | undefined;
  }

  listRepositories(): RepositoryRecord[] {
    return this.db.prepare('SELECT id, codeup_id, name, branch, owner, sync_owner, sync_credential_version, hook_hash, path, commit_sha AS "commit", indexed_at, status, error FROM repositories ORDER BY id')
      .all() as RepositoryRecord[];
  }

  updateRepository(id: string, patch: RepoUpdate): void {
    const columns: Record<string, string> = {
      name: 'name', branch: 'branch', owner: 'owner', sync_owner: 'sync_owner', sync_credential_version: 'sync_credential_version', hook_hash: 'hook_hash',
      path: 'path', commit: 'commit_sha', indexed_at: 'indexed_at', status: 'status', error: 'error',
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
    this.db.prepare('INSERT INTO jobs (id, repo_id, status, reason, created_at, error) VALUES (?, ?, ?, ?, ?, ?)')
      .run(job.id, job.repo_id, job.status, job.reason, job.created_at, job.error);
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

  updateJob(id: string, patch: JobUpdate): void {
    const entries = Object.entries(patch).filter(([key, value]) => (key === 'status' || key === 'error') && value !== undefined);
    if (entries.length === 0) return;
    this.db.prepare(`UPDATE jobs SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value as string | null), id);
  }
}
