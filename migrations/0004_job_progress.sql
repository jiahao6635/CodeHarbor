ALTER TABLE jobs
  ADD COLUMN phase TEXT CHECK (phase IN ('queued', 'validating', 'cloning', 'indexing', 'packaging', 'publishing', 'complete'));
