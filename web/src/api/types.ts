// Response shapes follow src/openapi.ts on the server. Keep both in sync.

export type Scope = 'read' | 'write';

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
  key_scope: Scope;
  key_prefix: string;
  key_repos: string[] | null;
  key_expires_at: number | null;
  can_write: boolean;
  is_admin: boolean;
}

export interface ConsoleConfig {
  mcp_url: string | null;
  public_mcp_disabled: boolean;
}

export interface Repository {
  repo_id: string;
  codeup_id: string;
  name: string;
  branch: string;
  status: RepositoryStatus;
  indexed_commit: string | null;
  indexed_at: string | null;
  stale: boolean;
  error: string | null;
  webhook_path: string;
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

export interface Job {
  id: string;
  repo_id: string;
  status: JobStatus;
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
}

export interface AdminKeyInfo extends KeyInfo {
  owner: string;
}

export interface CreatedKey {
  token: string;
  prefix: string;
  scope: Scope;
  repos: string[] | null;
  expires_at: number | null;
}

export interface BootstrapSession {
  bootstrap_token: string;
  expires_in: number;
  user: { id: string; name: string };
}

export interface BootstrapKey {
  token: string;
  prefix: string;
  scope: Scope;
  expires_in: number | null;
}

export interface UserSummary {
  id: string;
  username: string;
  credential_version: number;
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
