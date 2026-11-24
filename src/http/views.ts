import type { InternalMcpRepository } from '../internal-mcp.js';
import type { McpRepository } from '../mcp.js';
import type { KeyRecord, RepositoryRecord } from '../store.js';

export function mcpRepository(repo: RepositoryRecord): McpRepository {
  return {
    id: repo.id,
    name: repo.name,
    status: repo.status,
    indexedCommit: repo.commit,
    indexedAt: repo.indexed_at === null ? null : new Date(repo.indexed_at).toISOString(),
    stale: repo.status !== 'ready',
    projectPath: repo.path,
  };
}

export function publicRepository(repo: RepositoryRecord) {
  const view = mcpRepository(repo);
  return {
    repo_id: view.id,
    codeup_id: repo.codeup_id,
    name: view.name,
    branch: repo.branch,
    status: view.status,
    indexed_commit: view.indexedCommit,
    indexed_at: view.indexedAt,
    stale: view.stale,
    error: repo.error,
    webhook_path: `/api/v1/hooks/codeup/${repo.id}`,
  };
}

/** Administrative view: adds ownership so operators can see who synchronises a repository. */
export function adminRepository(repo: RepositoryRecord) {
  return { ...publicRepository(repo), owner: repo.owner, sync_owner: repo.sync_owner };
}

export function internalRepository(repo: RepositoryRecord): InternalMcpRepository {
  const view = mcpRepository(repo);
  return {
    repo_id: view.id,
    name: view.name,
    status: view.status,
    indexed_commit: view.indexedCommit,
    indexed_at: view.indexedAt,
    stale: view.stale,
  };
}

/** Key hashes never leave the service. */
export function publicKey(key: KeyRecord) {
  return {
    prefix: key.prefix,
    scope: key.scope,
    repos: key.repos,
    expires_at: key.expires_at,
    revoked: !!key.revoked,
    legacy_pending: !!key.legacy_pending,
  };
}
