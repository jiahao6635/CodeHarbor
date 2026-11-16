import { z } from 'zod';

const integer = z.coerce.number().int();
const nullableInteger = z.union([z.null(), integer]);
const nullableText = z.union([z.null(), z.string()]);

export const userRowSchema = z.object({
  id: z.string(),
  username: z.string(),
  credential: z.string(),
  credential_version: integer,
});
export type UserRecord = z.infer<typeof userRowSchema>;

export const keyRowSchema = z.object({
  hash: z.string(),
  prefix: z.string(),
  owner: z.string(),
  scope: z.enum(['read', 'write']),
  /** null means all repositories that the owner can currently access. */
  repos: z.union([z.null(), z.array(z.string())]),
  expires_at: nullableInteger,
  revoked: integer,
});
export type KeyRecord = z.infer<typeof keyRowSchema>;

export const repositoryRowSchema = z.object({
  id: z.string(),
  codeup_id: z.string(),
  name: z.string(),
  branch: z.string(),
  owner: z.string(),
  sync_owner: z.string(),
  sync_credential_version: integer,
  hook_hash: z.string(),
  path: nullableText,
  commit: nullableText,
  /** Last published OCI generation, null for pre-image and older records. */
  previous_image: nullableText,
  previous_commit: nullableText,
  indexed_at: nullableInteger,
  status: z.string(),
  error: nullableText,
});
export type RepositoryRecord = z.infer<typeof repositoryRowSchema>;
export type RepositoryInput = Omit<RepositoryRecord, 'previous_image' | 'previous_commit'> &
  Partial<Pick<RepositoryRecord, 'previous_image' | 'previous_commit'>>;

export const jobRowSchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  reason: z.string(),
  created_at: integer,
  /** Waiting start is reset when an interrupted attempt is requeued. */
  queued_at: nullableInteger,
  /** Only newly completed tasks have a known completion time. */
  finished_at: nullableInteger,
  /** Monotonic elapsed time for the actual build; null if no build completed. */
  build_duration_ms: nullableInteger,
  error: nullableText,
});
export type JobRecord = z.infer<typeof jobRowSchema>;
export type JobInput = Omit<JobRecord, 'queued_at' | 'finished_at' | 'build_duration_ms'> &
  Partial<Pick<JobRecord, 'queued_at' | 'finished_at' | 'build_duration_ms'>>;

/** Cached Codeup repository permission for a bound user; refreshed on demand and by the worker. */
export const accessRowSchema = z.object({
  user_id: z.string(),
  repo_id: z.string(),
  allowed: integer,
  verified_at: integer,
});
export type AccessRecord = z.infer<typeof accessRowSchema>;

export const auditRowSchema = z.object({
  id: z.string(),
  at: integer,
  request_id: z.string(),
  method: z.string(),
  route: z.string(),
  status: integer,
  authentication: nullableText,
  subject: nullableText,
  key_prefix: nullableText,
  repo_id: nullableText,
  tool: nullableText,
  tool_outcome: nullableText,
  query_hash: nullableText,
});
export type AuditRecord = z.infer<typeof auditRowSchema>;

export type AuditFilter = { subject?: string; repo_id?: string; since?: number; limit: number };

export const BUILD_DURATION_BUCKETS_MS = [1000, 5000, 10000, 30000, 60000, 120000, 300000, 600000, 1800000] as const;

export const jobMetricsRowSchema = z.object({
  queued: integer,
  oldest_queued_at: nullableInteger,
  completed_24h: integer,
  succeeded_24h: integer,
  failed_24h: integer,
  builds_24h: integer,
  build_duration_sum_ms_24h: z.union([z.null(), integer]).transform((value) => value ?? 0),
  build_duration_max_ms_24h: nullableInteger,
  build_duration_last_ms_24h: nullableInteger,
});
export const jobMetricsBucketSchema = integer;

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

export type RepositoryUpdate = Partial<Omit<RepositoryRecord, 'id' | 'codeup_id'>>;
export type JobUpdate = Partial<
  Pick<JobRecord, 'status' | 'error' | 'queued_at' | 'finished_at' | 'build_duration_ms'>
>;
export type UserSummary = Pick<UserRecord, 'id' | 'username' | 'credential_version'>;

/** Every store operation; transaction callbacks must exclusively use the supplied tx object. */
export interface StoreAccess {
  createUser(user: UserRecord): Promise<void>;
  getUser(id: string): Promise<UserRecord | undefined>;
  updateUserCredential(id: string, username: string, credential: string): Promise<void>;
  listUsers(): Promise<UserSummary[]>;

  createKey(key: KeyRecord): Promise<void>;
  getKey(hash: string): Promise<KeyRecord | undefined>;
  listKeys(owner: string): Promise<KeyRecord[]>;
  /** Administrative listing across owners; hashes are never returned to callers. */
  listAllKeys(owner: string | undefined, limit: number, offset: number): Promise<KeyRecord[]>;
  getKeysByPrefix(prefix: string): Promise<KeyRecord[]>;
  revokeKey(hash: string): Promise<void>;
  revokeUserKeys(owner: string): Promise<void>;

  createRepository(repo: RepositoryInput): Promise<void>;
  getRepository(id: string): Promise<RepositoryRecord | undefined>;
  getRepositoryByCodeupId(codeupId: string): Promise<RepositoryRecord | undefined>;
  getRepositoriesByIds(ids: string[]): Promise<RepositoryRecord[]>;
  listRepositories(): Promise<RepositoryRecord[]>;
  updateRepository(id: string, patch: RepositoryUpdate): Promise<void>;
  deleteRepository(id: string): Promise<void>;

  createJob(job: JobInput): Promise<void>;
  getJob(id: string): Promise<JobRecord | undefined>;
  listJobs(repoId: string): Promise<JobRecord[]>;
  listPendingJobs(): Promise<JobRecord[]>;
  updateJob(id: string, patch: JobUpdate): Promise<void>;
  jobMetrics(nowMs: number): Promise<JobMetrics>;

  getAccess(userId: string, repoId: string): Promise<AccessRecord | undefined>;
  listAccess(userId: string): Promise<AccessRecord[]>;
  upsertAccess(row: AccessRecord): Promise<void>;
  listStaleAccess(before: number, limit: number): Promise<AccessRecord[]>;

  appendAuditEvents(rows: AuditRecord[]): Promise<void>;
  listAuditEvents(filter: AuditFilter): Promise<AuditRecord[]>;
  purgeAuditEvents(before: number): Promise<number>;
}

export interface StoreBackend extends StoreAccess {
  transaction<T>(fn: (tx: StoreAccess) => Promise<T>): Promise<T>;
  checkHealth(): Promise<void>;
  close(): Promise<void>;
}
