ALTER TABLE repositories
  ADD COLUMN sync_interval_minutes INTEGER CHECK (sync_interval_minutes BETWEEN 1 AND 1440);

CREATE INDEX jobs_repository_created_idx ON jobs (repo_id, created_at);
