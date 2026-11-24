// Response shapes follow src/openapi.ts on the server. Keep both in sync.

export type Scope = 'read' | 'write';
export type AccountRole = 'member' | 'super_admin';
export type AccountStatus = 'active' | 'disabled';

export type RepositoryStatus =
  | 'pending'
  | 'indexing'
  | 'updating'
  | 'ready'
  | 'failed'
  | 'credential_required'
  | 'branch_deleted'
  | 'disabled'
  | (string & {});

export interface Me {
  id: string;
  username: string;
  role: AccountRole;
  has_pat: boolean;
}

export interface ConsoleConfig {
  mcp_url: string | null;
  public_mcp_disabled: boolean;
  default_sync_interval_minutes?: number;
}

export interface AdminSystemPerformance {
  health: {
    status: 'ok' | 'degraded';
    database: 'ok' | 'unavailable';
    indexRuntime: 'ok' | 'unavailable';
    fenced: Record<string, boolean>;
  };
  performance: {
    sampledAt: string;
    system: {
      cpuCount: number;
      cpuUsageRatio: number | null;
      loadAverage: { oneMinute: number; fiveMinutes: number; fifteenMinutes: number } | null;
      totalMemoryBytes: number;
      availableMemoryBytes: number;
      uptimeSeconds: number;
    };
    cgroup: {
      cpuUsageCores: number | null;
      cpuLimitCores: number | null;
      cpuSecondsTotal: number | null;
      memoryUsageBytes: number | null;
      memoryLimitBytes: number | null;
    } | null;
    process: {
      uptimeSeconds: number;
      residentMemoryBytes: number;
      cpuUsageCores: number | null;
      cpuSecondsTotal: number;
    };
    storage: { totalBytes: number; availableBytes: number } | null;
  };
}

export interface Repository {
  repo_id: string;
  codeup_id: string;
  name: string;
  branch: string;
  sync_interval_minutes: number | null;
  effective_sync_interval_minutes: number;
  status: RepositoryStatus;
  indexed_commit: string | null;
  indexed_at: string | null;
  stale: boolean;
  error: string | null;
  webhook_path: string;
  can_manage?: boolean;
  can_authorize_sync?: boolean;
}

export interface AdminRepository extends Repository {
  owner: string;
  sync_owner: string;
}

export interface CreatedRepository {
  repository: Repository;
  job_id: string;
  webhook_token: string;
  webhook_path: string;
}

export interface CodeupRepository {
  id: string;
  name: string;
  path: string;
  access_level: number | null;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type JobPhase = 'queued' | 'validating' | 'cloning' | 'indexing' | 'packaging' | 'publishing' | 'complete';

export interface Job {
  id: string;
  repo_id: string;
  status: JobStatus;
  phase: JobPhase | null;
  reason: string;
  created_at: number;
  queued_at: number | null;
  finished_at: number | null;
  build_duration_ms: number | null;
  error: string | null;
}

export interface KeyInfo {
  prefix: string;
  scope: Scope;
  repos: string[] | null;
  expires_at: number | null;
  revoked: boolean;
  legacy_pending?: boolean;
}

export interface AdminKeyInfo extends KeyInfo {
  owner: string;
  legacy_approvable?: boolean;
}

export interface CreatedKey {
  token: string;
  prefix: string;
  scope: Scope;
  repos: string[] | null;
  expires_at: number | null;
}

export interface UserSummary {
  id: string;
  username: string;
  codeup_user_id: string | null;
  role: AccountRole;
  status: AccountStatus;
  has_pat: boolean;
}

export interface AuditEvent {
  id: string;
  at: number;
  request_id: string;
  method: string;
  route: string;
  status: number;
  authentication: string | null;
  subject: string | null;
  key_prefix: string | null;
  repo_id: string | null;
  tool: string | null;
  tool_outcome: string | null;
  query_hash: string | null;
}
