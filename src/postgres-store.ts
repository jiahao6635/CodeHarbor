import pg from 'pg';
import { loadMigrations, migrate } from './migrate.js';
import {
  accessRowSchema,
  auditRowSchema,
  BUILD_DURATION_BUCKETS_MS,
  type JobMetrics,
  jobMetricsBucketSchema,
  jobMetricsRowSchema,
  jobRowSchema,
  keyRowSchema,
  repositoryRowSchema,
  type StoreAccess,
  type StoreBackend,
  userRowSchema,
} from './store.js';

type Row = Record<string, unknown>;
type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

const REPOSITORY_COLUMNS =
  'id, codeup_id, name, branch, owner, sync_owner, sync_credential_version, hook_hash, path, commit_sha AS "commit", previous_image, previous_commit, indexed_at, status, error';

const REPOSITORY_UPDATE_COLUMNS: Record<string, string> = {
  name: 'name',
  branch: 'branch',
  owner: 'owner',
  sync_owner: 'sync_owner',
  sync_credential_version: 'sync_credential_version',
  hook_hash: 'hook_hash',
  path: 'path',
  commit: 'commit_sha',
  previous_image: 'previous_image',
  previous_commit: 'previous_commit',
  indexed_at: 'indexed_at',
  status: 'status',
  error: 'error',
};
const JOB_UPDATE_COLUMNS = new Set(['status', 'error', 'queued_at', 'finished_at', 'build_duration_ms']);

const parseKey = (row: Row) => keyRowSchema.parse({ ...row, repos: JSON.parse(String(row.repos)) });
const userSummarySchema = userRowSchema.omit({ credential: true });
const optional =
  <T>(parse: (row: Row) => T) =>
  (row: Row | undefined) =>
    row === undefined ? undefined : parse(row);

/** Aggregates jobs finished inside [$1, $2] plus the current queue. */
const JOB_METRICS_SQL = `WITH finished AS (
    SELECT id, status, finished_at, build_duration_ms FROM jobs
    WHERE status IN ('succeeded', 'failed') AND finished_at >= $1 AND finished_at <= $2
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
    ${BUILD_DURATION_BUCKETS_MS.map(
      (bound, index) =>
        `SUM(CASE WHEN build_duration_ms IS NOT NULL AND build_duration_ms <= ${bound} THEN 1 ELSE 0 END) AS bucket_${index}`,
    ).join(',\n    ')}
  FROM finished`;

function parseJobMetrics(row: Row): JobMetrics {
  const parsed = jobMetricsRowSchema.parse(row);
  return {
    queued: parsed.queued,
    oldestQueuedAt: parsed.oldest_queued_at,
    completed24h: parsed.completed_24h,
    succeeded24h: parsed.succeeded_24h,
    failed24h: parsed.failed_24h,
    builds24h: parsed.builds_24h,
    buildDurationSumMs24h: parsed.build_duration_sum_ms_24h,
    buildDurationMaxMs24h: parsed.build_duration_max_ms_24h,
    buildDurationLastMs24h: parsed.build_duration_last_ms_24h,
    buildBuckets24h: BUILD_DURATION_BUCKETS_MS.map((_bound, index) =>
      jobMetricsBucketSchema.parse(row[`bucket_${index}`]),
    ),
  };
}

function access(db: Queryable, guard: () => void): StoreAccess {
  const q = async (sql: string, params: unknown[] = []): Promise<pg.QueryResult<Row>> => {
    guard();
    return db.query(sql, params);
  };
  const one = async <T>(parse: (row: Row) => T, sql: string, params: unknown[] = []) =>
    optional(parse)((await q(sql, params)).rows[0]);
  const many = async <T>(parse: (row: Row) => T, sql: string, params: unknown[] = []) =>
    (await q(sql, params)).rows.map(parse);

  return {
    async createUser(user) {
      await q('INSERT INTO users(id, username, credential, credential_version) VALUES($1, $2, $3, $4)', [
        user.id,
        user.username,
        user.credential,
        user.credential_version,
      ]);
    },
    getUser: (id) => one(userRowSchema.parse, 'SELECT * FROM users WHERE id = $1', [id]),
    async updateUserCredential(id, username, credential) {
      await q(
        'UPDATE users SET username = $1, credential = $2, credential_version = credential_version + 1 WHERE id = $3',
        [username, credential, id],
      );
    },
    listUsers: () => many(userSummarySchema.parse, 'SELECT id, username, credential_version FROM users ORDER BY id'),

    async createKey(key) {
      await q(
        'INSERT INTO keys(hash, prefix, owner, scope, repos, expires_at, revoked) VALUES($1, $2, $3, $4, $5, $6, $7)',
        [key.hash, key.prefix, key.owner, key.scope, JSON.stringify(key.repos), key.expires_at, key.revoked],
      );
    },
    getKey: (hash) => one(parseKey, 'SELECT * FROM keys WHERE hash = $1', [hash]),
    listKeys: (owner) => many(parseKey, 'SELECT * FROM keys WHERE owner = $1 ORDER BY prefix', [owner]),
    listAllKeys: (owner, limit, offset) =>
      owner === undefined
        ? many(parseKey, 'SELECT * FROM keys ORDER BY owner, prefix LIMIT $1 OFFSET $2', [limit, offset])
        : many(parseKey, 'SELECT * FROM keys WHERE owner = $1 ORDER BY prefix LIMIT $2 OFFSET $3', [
            owner,
            limit,
            offset,
          ]),
    getKeysByPrefix: (prefix) => many(parseKey, 'SELECT * FROM keys WHERE prefix = $1', [prefix]),
    async revokeKey(hash) {
      await q('UPDATE keys SET revoked = 1 WHERE hash = $1', [hash]);
    },
    async revokeUserKeys(owner) {
      await q('UPDATE keys SET revoked = 1 WHERE owner = $1', [owner]);
    },

    async createRepository(repo) {
      await q(
        `INSERT INTO repositories(id, codeup_id, name, branch, owner, sync_owner, sync_credential_version, hook_hash, path, commit_sha, previous_image, previous_commit, indexed_at, status, error)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          repo.id,
          repo.codeup_id,
          repo.name,
          repo.branch,
          repo.owner,
          repo.sync_owner,
          repo.sync_credential_version,
          repo.hook_hash,
          repo.path,
          repo.commit,
          repo.previous_image ?? null,
          repo.previous_commit ?? null,
          repo.indexed_at,
          repo.status,
          repo.error,
        ],
      );
    },
    getRepository: (id) =>
      one(repositoryRowSchema.parse, `SELECT ${REPOSITORY_COLUMNS} FROM repositories WHERE id = $1`, [id]),
    getRepositoryByCodeupId: (codeupId) =>
      one(repositoryRowSchema.parse, `SELECT ${REPOSITORY_COLUMNS} FROM repositories WHERE codeup_id = $1`, [codeupId]),
    getRepositoriesByIds: (ids) =>
      ids.length === 0
        ? Promise.resolve([])
        : many(
            repositoryRowSchema.parse,
            `SELECT ${REPOSITORY_COLUMNS} FROM repositories WHERE id = ANY($1) ORDER BY id`,
            [ids],
          ),
    listRepositories: () =>
      many(repositoryRowSchema.parse, `SELECT ${REPOSITORY_COLUMNS} FROM repositories ORDER BY id`),
    async updateRepository(id, patch) {
      const entries = Object.entries(patch).filter(
        ([key, value]) => Object.hasOwn(REPOSITORY_UPDATE_COLUMNS, key) && value !== undefined,
      );
      if (entries.length === 0) return;
      const assignments = entries.map(([key], index) => `${REPOSITORY_UPDATE_COLUMNS[key]} = $${index + 1}`).join(', ');
      await q(`UPDATE repositories SET ${assignments} WHERE id = $${entries.length + 1}`, [
        ...entries.map(([, value]) => value),
        id,
      ]);
    },
    async deleteRepository(id) {
      await q('DELETE FROM repositories WHERE id = $1', [id]);
    },

    async createJob(job) {
      await q(
        'INSERT INTO jobs(id, repo_id, status, reason, created_at, queued_at, finished_at, build_duration_ms, error) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [
          job.id,
          job.repo_id,
          job.status,
          job.reason,
          job.created_at,
          job.queued_at ?? job.created_at,
          job.finished_at ?? null,
          job.build_duration_ms ?? null,
          job.error,
        ],
      );
    },
    getJob: (id) => one(jobRowSchema.parse, 'SELECT * FROM jobs WHERE id = $1', [id]),
    listJobs: (repoId) =>
      many(jobRowSchema.parse, 'SELECT * FROM jobs WHERE repo_id = $1 ORDER BY created_at, id', [repoId]),
    listPendingJobs: () =>
      many(jobRowSchema.parse, "SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at, id"),
    async updateJob(id, patch) {
      const entries = Object.entries(patch).filter(
        ([key, value]) => JOB_UPDATE_COLUMNS.has(key) && value !== undefined,
      );
      if (entries.length === 0) return;
      const assignments = entries.map(([key], index) => `${key} = $${index + 1}`).join(', ');
      await q(`UPDATE jobs SET ${assignments} WHERE id = $${entries.length + 1}`, [
        ...entries.map(([, value]) => value),
        id,
      ]);
    },
    async jobMetrics(nowMs) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('Invalid metrics time');
      const row = (await q(JOB_METRICS_SQL, [nowMs - 86_400_000, nowMs])).rows[0];
      if (!row) throw new Error('Job metrics unavailable');
      return parseJobMetrics(row);
    },

    getAccess: (userId, repoId) =>
      one(accessRowSchema.parse, 'SELECT * FROM repository_access WHERE user_id = $1 AND repo_id = $2', [
        userId,
        repoId,
      ]),
    listAccess: (userId) => many(accessRowSchema.parse, 'SELECT * FROM repository_access WHERE user_id = $1', [userId]),
    async upsertAccess(row) {
      await q(
        `INSERT INTO repository_access(user_id, repo_id, allowed, verified_at) VALUES($1, $2, $3, $4)
         ON CONFLICT(user_id, repo_id) DO UPDATE SET allowed = EXCLUDED.allowed, verified_at = EXCLUDED.verified_at`,
        [row.user_id, row.repo_id, row.allowed, row.verified_at],
      );
    },
    listStaleAccess: (before, limit) =>
      many(
        accessRowSchema.parse,
        'SELECT * FROM repository_access WHERE verified_at < $1 ORDER BY verified_at LIMIT $2',
        [before, limit],
      ),

    async appendAuditEvents(rows) {
      for (const row of rows) {
        await q(
          `INSERT INTO audit_events(id, at, request_id, method, route, status, authentication, subject, key_prefix, repo_id, tool, tool_outcome, query_hash)
           VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            row.id,
            row.at,
            row.request_id,
            row.method,
            row.route,
            row.status,
            row.authentication,
            row.subject,
            row.key_prefix,
            row.repo_id,
            row.tool,
            row.tool_outcome,
            row.query_hash,
          ],
        );
      }
    },
    listAuditEvents(filter) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.subject !== undefined) {
        params.push(filter.subject);
        where.push(`subject = $${params.length}`);
      }
      if (filter.repo_id !== undefined) {
        params.push(filter.repo_id);
        where.push(`repo_id = $${params.length}`);
      }
      if (filter.since !== undefined) {
        params.push(filter.since);
        where.push(`at >= $${params.length}`);
      }
      params.push(filter.limit);
      const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      return many(
        auditRowSchema.parse,
        `SELECT * FROM audit_events${clause} ORDER BY at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
    },
    async purgeAuditEvents(before) {
      return (await q('DELETE FROM audit_events WHERE at < $1', [before])).rowCount ?? 0;
    },
  };
}

export const LOCK_APPLICATION_NAME = 'codeharbor-lock';
export const POOL_APPLICATION_NAME = 'codeharbor';

export type PostgresStoreOptions = {
  /** Upper bound on pooled connections for queries and transactions. */
  poolSize?: number;
  migrationsDir?: string;
};

/**
 * One service instance per database. A dedicated session holds the instance
 * advisory lock; if that session drops, every operation fails closed until restart.
 */
export async function openPostgresStore(
  connectionString: string,
  options: PostgresStoreOptions = {},
): Promise<StoreBackend> {
  const lock = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    application_name: LOCK_APPLICATION_NAME,
  });
  let broken = false;
  // Register before connect so a failed connection never surfaces as an unhandled error.
  lock.on('error', () => {
    broken = true;
  });
  lock.on('end', () => {
    broken = true;
  });
  try {
    await lock.connect();
    const result = await lock.query(
      "SELECT pg_try_advisory_lock(hashtext('codeharbor'), hashtext('single-instance')) AS acquired",
    );
    if (!result.rows[0]?.acquired) throw new Error('Another CodeHarbor instance is using this database');
    await migrate(lock, await loadMigrations(options.migrationsDir));
  } catch (error) {
    await lock.end().catch(() => {});
    throw error;
  }

  const pool = new pg.Pool({
    connectionString,
    max: options.poolSize ?? 10,
    connectionTimeoutMillis: 10_000,
    application_name: POOL_APPLICATION_NAME,
  });
  pool.on('error', () => {});
  const guard = () => {
    if (broken) throw new Error('Database lock session is unavailable');
  };

  return {
    ...access(pool, guard),
    async transaction(fn) {
      guard();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        try {
          const value = await fn(access(client, guard));
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      } finally {
        client.release();
      }
    },
    async checkHealth() {
      guard();
      await lock.query('SELECT 1');
      await pool.query('SELECT 1');
    },
    async close() {
      broken = true;
      await pool.end().catch(() => {});
      await lock.end().catch(() => {});
    },
  };
}
