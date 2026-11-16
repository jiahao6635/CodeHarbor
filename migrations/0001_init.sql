-- CodeHarbor platform metadata. Consolidated initial schema.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  credential TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE keys (
  hash TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  owner TEXT NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  -- JSON array of repository ids, or 'null' for owner-wide access.
  repos TEXT NOT NULL,
  expires_at BIGINT,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);
CREATE INDEX keys_owner_idx ON keys (owner);

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  codeup_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  owner TEXT NOT NULL REFERENCES users(id),
  sync_owner TEXT NOT NULL REFERENCES users(id),
  sync_credential_version INTEGER NOT NULL DEFAULT 0 CHECK (sync_credential_version >= 0),
  hook_hash TEXT NOT NULL,
  path TEXT,
  commit_sha TEXT,
  previous_image TEXT,
  previous_commit TEXT,
  indexed_at BIGINT,
  status TEXT NOT NULL,
  error TEXT
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  queued_at BIGINT,
  finished_at BIGINT,
  build_duration_ms BIGINT,
  error TEXT
);
CREATE INDEX jobs_queue_idx ON jobs (status, created_at);
CREATE INDEX jobs_finished_idx ON jobs (finished_at);

CREATE TABLE repository_access (
  user_id TEXT NOT NULL REFERENCES users(id),
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  verified_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, repo_id)
);
CREATE INDEX repository_access_verified_idx ON repository_access (verified_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  request_id TEXT NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  status INTEGER NOT NULL,
  authentication TEXT,
  subject TEXT,
  key_prefix TEXT,
  repo_id TEXT,
  tool TEXT,
  tool_outcome TEXT,
  query_hash TEXT
);
CREATE INDEX audit_events_at_idx ON audit_events (at);
CREATE INDEX audit_events_subject_idx ON audit_events (subject, at);
CREATE INDEX audit_events_repo_idx ON audit_events (repo_id, at);
