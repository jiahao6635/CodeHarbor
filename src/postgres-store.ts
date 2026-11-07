import pg from 'pg';
import { DatabaseSync } from 'node:sqlite';
import type { StoreAccess, StoreBackend } from './async-store.js';
import type { JobRecord, KeyRecord, RepositoryRecord, UserRecord } from './store.js';

type Run = <T>(fn: () => Promise<T>) => Promise<T>;

type Row = Record<string, unknown>;
const numberOrNull = (value: unknown): number | null => value === null ? null : Number(value);
const userRow = (row?: Row): UserRecord | undefined => row ? ({ ...row, credential_version: Number(row.credential_version) } as UserRecord) : undefined;
const keyRow = (row?: Row): KeyRecord | undefined => {
  if (!row) return undefined;
  const repos: unknown = JSON.parse(String(row.repos));
  if (repos !== null && (!Array.isArray(repos) || !repos.every(item => typeof item === 'string'))) throw new Error('Invalid stored key scope');
  return { ...row, repos, expires_at: numberOrNull(row.expires_at), revoked: Number(row.revoked) } as KeyRecord;
};
const repoRow = (row?: Row): RepositoryRecord | undefined => row ? ({ ...row, sync_credential_version: Number(row.sync_credential_version), indexed_at: numberOrNull(row.indexed_at) } as RepositoryRecord) : undefined;
const jobRow = (row?: Row): JobRecord | undefined => row ? ({ ...row, created_at: Number(row.created_at) } as JobRecord) : undefined;
const repoFields = 'id, codeup_id, name, branch, owner, sync_owner, sync_credential_version, hook_hash, path, commit_sha AS "commit", indexed_at, status, error';

function access(client: pg.Client, run: Run): StoreAccess {
  const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
  return {
    createUser: user => run(async () => { await q('INSERT INTO users(id, username, credential, credential_version) VALUES($1,$2,$3,$4)', [user.id, user.username, user.credential, user.credential_version]); }),
    getUser: id => run(async () => userRow((await q('SELECT * FROM users WHERE id = $1', [id])).rows[0])),
    updateUserCredential: (id, username, credential) => run(async () => { await q('UPDATE users SET username=$1, credential=$2, credential_version=credential_version+1 WHERE id=$3', [username, credential, id]); }),
    createKey: key => run(async () => { await q('INSERT INTO keys(hash,prefix,owner,scope,repos,expires_at,revoked) VALUES($1,$2,$3,$4,$5,$6,$7)', [key.hash,key.prefix,key.owner,key.scope,JSON.stringify(key.repos),key.expires_at,key.revoked]); }),
    getKey: hash => run(async () => keyRow((await q('SELECT * FROM keys WHERE hash=$1', [hash])).rows[0])),
    listKeys: owner => run(async () => (await q('SELECT * FROM keys WHERE owner=$1 ORDER BY prefix', [owner])).rows.map(keyRow) as KeyRecord[]),
    revokeKey: hash => run(async () => { await q('UPDATE keys SET revoked=1 WHERE hash=$1', [hash]); }),
    revokeUserKeys: owner => run(async () => { await q('UPDATE keys SET revoked=1 WHERE owner=$1', [owner]); }),
    createRepository: repo => run(async () => { await q('INSERT INTO repositories(id,codeup_id,name,branch,owner,sync_owner,sync_credential_version,hook_hash,path,commit_sha,indexed_at,status,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [repo.id,repo.codeup_id,repo.name,repo.branch,repo.owner,repo.sync_owner,repo.sync_credential_version,repo.hook_hash,repo.path,repo.commit,repo.indexed_at,repo.status,repo.error]); }),
    getRepository: id => run(async () => repoRow((await q(`SELECT ${repoFields} FROM repositories WHERE id=$1`, [id])).rows[0])),
    getRepositoryByCodeupId: id => run(async () => repoRow((await q(`SELECT ${repoFields} FROM repositories WHERE codeup_id=$1`, [id])).rows[0])),
    listRepositories: () => run(async () => (await q(`SELECT ${repoFields} FROM repositories ORDER BY id`)).rows.map(repoRow) as RepositoryRecord[]),
    updateRepository: (id, patch) => run(async () => {
      const columns: Record<string, string> = { name:'name',branch:'branch',owner:'owner',sync_owner:'sync_owner',sync_credential_version:'sync_credential_version',hook_hash:'hook_hash',path:'path',commit:'commit_sha',indexed_at:'indexed_at',status:'status',error:'error' };
      const entries = Object.entries(patch).filter(([key,value]) => Object.hasOwn(columns,key) && value !== undefined);
      if (entries.length) await q(`UPDATE repositories SET ${entries.map(([key], i) => `${columns[key]}=$${i+1}`).join(',')} WHERE id=$${entries.length+1}`, [...entries.map(([,v]) => v),id]);
    }),
    deleteRepository: id => run(async () => { await q('DELETE FROM repositories WHERE id=$1', [id]); }),
    createJob: job => run(async () => { await q('INSERT INTO jobs(id,repo_id,status,reason,created_at,error) VALUES($1,$2,$3,$4,$5,$6)', [job.id,job.repo_id,job.status,job.reason,job.created_at,job.error]); }),
    getJob: id => run(async () => jobRow((await q('SELECT * FROM jobs WHERE id=$1', [id])).rows[0])),
    listJobs: id => run(async () => (await q('SELECT * FROM jobs WHERE repo_id=$1 ORDER BY created_at,id', [id])).rows.map(jobRow) as JobRecord[]),
    listPendingJobs: () => run(async () => (await q("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at,id")).rows.map(jobRow) as JobRecord[]),
    updateJob: (id, patch) => run(async () => {
      const entries = Object.entries(patch).filter(([key,value]) => (key === 'status' || key === 'error') && value !== undefined);
      if (entries.length) await q(`UPDATE jobs SET ${entries.map(([key],i)=>`${key}=$${i+1}`).join(',')} WHERE id=$${entries.length+1}`, [...entries.map(([,v]) => v),id]);
    }),
  };
}

const schema = `
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL, credential TEXT NOT NULL, credential_version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS keys(hash TEXT PRIMARY KEY, prefix TEXT NOT NULL, owner TEXT NOT NULL REFERENCES users(id), scope TEXT NOT NULL CHECK(scope IN ('read','write')), repos TEXT NOT NULL, expires_at BIGINT, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)));
CREATE INDEX IF NOT EXISTS keys_owner_idx ON keys(owner);
CREATE TABLE IF NOT EXISTS repositories(id TEXT PRIMARY KEY, codeup_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, branch TEXT NOT NULL, owner TEXT NOT NULL REFERENCES users(id), sync_owner TEXT NOT NULL REFERENCES users(id), sync_credential_version INTEGER NOT NULL DEFAULT 0 CHECK(sync_credential_version >= 0), hook_hash TEXT NOT NULL, path TEXT, commit_sha TEXT, indexed_at BIGINT, status TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')), reason TEXT NOT NULL, created_at BIGINT NOT NULL, error TEXT);
CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status,created_at);
`;

/** One service instance per database. The session holding the lock runs every query. */
export class PostgresStore implements StoreBackend {
  private tail: Promise<void> = Promise.resolve();
  private readonly access: StoreAccess;
  private broken = false;
  private constructor(private readonly client: pg.Client) {
    client.on('error', () => { this.broken = true; });
    client.on('end', () => { this.broken = true; });
    this.access = access(client, fn => this.serialize(fn));
  }
  static async open(connectionString: string): Promise<PostgresStore> {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
    // Register before connect to avoid an unhandled error on failure.
    client.on('error', () => {});
    try {
      await client.connect();
      const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('codeharbor'), hashtext('single-instance')) AS acquired");
      if (!lock.rows[0]?.acquired) throw new Error('Another CodeHarbor instance is using this database');
      await client.query(schema);
      return new PostgresStore(client);
    } catch (error) { await client.end().catch(() => {}); throw error; }
  }
  private async serialize<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (this.broken) throw new Error('Database lock session is unavailable');
      return await fn();
    } finally { release(); }
  }
  createUser: StoreAccess['createUser'] = (...a) => this.access.createUser(...a);
  getUser: StoreAccess['getUser'] = (...a) => this.access.getUser(...a);
  updateUserCredential: StoreAccess['updateUserCredential'] = (...a) => this.access.updateUserCredential(...a);
  createKey: StoreAccess['createKey'] = (...a) => this.access.createKey(...a);
  getKey: StoreAccess['getKey'] = (...a) => this.access.getKey(...a);
  listKeys: StoreAccess['listKeys'] = (...a) => this.access.listKeys(...a);
  revokeKey: StoreAccess['revokeKey'] = (...a) => this.access.revokeKey(...a);
  revokeUserKeys: StoreAccess['revokeUserKeys'] = (...a) => this.access.revokeUserKeys(...a);
  createRepository: StoreAccess['createRepository'] = (...a) => this.access.createRepository(...a);
  getRepository: StoreAccess['getRepository'] = (...a) => this.access.getRepository(...a);
  getRepositoryByCodeupId: StoreAccess['getRepositoryByCodeupId'] = (...a) => this.access.getRepositoryByCodeupId(...a);
  listRepositories: StoreAccess['listRepositories'] = (...a) => this.access.listRepositories(...a);
  updateRepository: StoreAccess['updateRepository'] = (...a) => this.access.updateRepository(...a);
  deleteRepository: StoreAccess['deleteRepository'] = (...a) => this.access.deleteRepository(...a);
  createJob: StoreAccess['createJob'] = (...a) => this.access.createJob(...a);
  getJob: StoreAccess['getJob'] = (...a) => this.access.getJob(...a);
  listJobs: StoreAccess['listJobs'] = (...a) => this.access.listJobs(...a);
  listPendingJobs: StoreAccess['listPendingJobs'] = (...a) => this.access.listPendingJobs(...a);
  updateJob: StoreAccess['updateJob'] = (...a) => this.access.updateJob(...a);
  transaction<T>(fn: (tx: StoreAccess) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      await this.client.query('BEGIN');
      try {
        const value = await fn(access(this.client, op => op()));
        await this.client.query('COMMIT');
        return value;
      } catch (error) { await this.client.query('ROLLBACK').catch(() => {}); throw error; }
    });
  }
  checkHealth(): Promise<void> { return this.serialize(async () => { await this.client.query('SELECT 1'); }); }
  /** Offline migration: source must be stopped/backed up; the destination must be empty. */
  importSqlite(path: string): Promise<void> {
    return this.serialize(async () => {
      const source = new DatabaseSync(path, { readOnly: true });
      try {
        // A read transaction keeps all source tables on the same SQLite snapshot.
        source.exec('BEGIN');
        const users = source.prepare('SELECT * FROM users').all() as UserRecord[];
        const keys = source.prepare('SELECT * FROM keys').all() as unknown as Array<Omit<KeyRecord, 'repos'> & { repos: string }>;
        const columns = source.prepare('PRAGMA table_info(repositories)').all();
        const version = columns.some(col => col.name === 'sync_credential_version') ? 'sync_credential_version' : '0 AS sync_credential_version';
        const repositories = source.prepare(`SELECT id,codeup_id,name,branch,owner,sync_owner,${version},hook_hash,path,commit_sha AS "commit",indexed_at,status,error FROM repositories`).all() as RepositoryRecord[];
        const jobs = source.prepare('SELECT * FROM jobs').all() as JobRecord[];
        source.exec('COMMIT');
        await this.client.query('BEGIN');
        try {
          const result = await this.client.query('SELECT (SELECT count(*) FROM users)+(SELECT count(*) FROM keys)+(SELECT count(*) FROM repositories)+(SELECT count(*) FROM jobs) AS count');
          if (Number(result.rows[0].count) !== 0) throw new Error('PostgreSQL destination is not empty');
          const target = access(this.client, op => op());
          for (const user of users) await target.createUser(user);
          for (const row of keys) {
            const repos: unknown = JSON.parse(row.repos);
            if (repos !== null && (!Array.isArray(repos) || !repos.every(item => typeof item === 'string'))) throw new Error('Invalid stored key scope');
            await target.createKey({ ...row, repos: repos as string[] | null });
          }
          for (const repo of repositories) await target.createRepository(repo);
          for (const job of jobs) await target.createJob({ ...job, status: job.status === 'running' ? 'queued' : job.status });
          await this.client.query('COMMIT');
        } catch (error) { await this.client.query('ROLLBACK').catch(() => {}); throw error; }
      } finally { source.close(); }
    });
  }
  async close(): Promise<void> {
    await this.tail;
    this.broken = true;
    await this.client.end().catch(() => {});
  }
}
