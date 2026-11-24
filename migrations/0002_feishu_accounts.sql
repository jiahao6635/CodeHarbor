CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  feishu_tenant_key TEXT NOT NULL,
  feishu_open_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'super_admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  codeup_user_id TEXT UNIQUE REFERENCES users(id),
  UNIQUE (feishu_tenant_key, feishu_open_id)
);

CREATE TABLE browser_sessions (
  hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX browser_sessions_account_idx ON browser_sessions (account_id);
CREATE INDEX browser_sessions_expiry_idx ON browser_sessions (expires_at);

CREATE TABLE feishu_oauth_states (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX feishu_oauth_states_expiry_idx ON feishu_oauth_states (expires_at);
