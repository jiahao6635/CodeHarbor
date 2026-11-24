import type { CredentialCipher } from './auth.js';
import { hashAccessKey } from './auth.js';
import { type CodeupClient, CodeupError, hasRepositoryRole } from './codeup.js';
import { fail } from './http/errors.js';
import type { IndexRequest } from './indexer.js';
import type { AccessRecord, AccountRecord, KeyRecord, RepositoryRecord, StoreBackend, UserRecord } from './store.js';

export type Principal = KeyRecord;

export type AuthorizationOptions = {
  store: StoreBackend;
  codeup: Pick<CodeupClient, 'getRepository'>;
  cipher: CredentialCipher;
  writeUsers: string[];
  accessTtlMs: number;
  auditRetentionDays: number;
  enforceFeishu?: boolean;
  dataDir?: string;
  allowedGitHosts?: string[];
  probe?: (request: IndexRequest, signal?: AbortSignal) => Promise<boolean>;
};

const BEARER = /^Bearer (ch_[A-Za-z0-9_-]{43})$/;
const MAINTENANCE_BUDGET = 200;
/** Bounded on-demand verification keeps listing cost independent of repository count. */
const LIST_VERIFY_BUDGET = 20;
export const MAX_CODEUP_ACCESS_AGE_MS = 5 * 60_000;
const MAX_CODEUP_ACCESS_ENTRIES = 16_384;
const CODEUP_LIST_CONCURRENCY = 8;
const cloudAccessKey = (user: UserRecord, repo: RepositoryRecord, source: boolean) =>
  JSON.stringify([user.id, user.credential_version, repo.id, repo.codeup_id, repo.branch, source]);

export function bearerToken(authorization: string): string | null {
  return BEARER.exec(authorization)?.[1] ?? null;
}

/** Serializes callbacks; the lock must never be held while waiting on a client. */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async (fn) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

const keyActive = (key: KeyRecord, now: number) => !key.revoked && (key.expires_at === null || key.expires_at > now);
export const canManageRepository = (owner: string, repo: RepositoryRecord) =>
  repo.owner === owner || repo.sync_owner === owner;

type KeyOwner = { account: AccountRecord; user: UserRecord };

export class Authorization {
  private readonly store: StoreBackend;
  private readonly cloudAccessCache = new Map<string, { checkedAt: number; allowed: boolean }>();
  readonly mutate = createMutex();
  readonly enforceFeishu: boolean;

  constructor(private readonly options: AuthorizationOptions) {
    this.store = options.store;
    this.enforceFeishu = options.enforceFeishu ?? false;
  }

  async authenticateBearer(authorization: string): Promise<Principal | null> {
    const token = bearerToken(authorization);
    if (!token) return null;
    const key = await this.store.getKey(hashAccessKey(token));
    if (!key || !(await this.isActiveKey(key))) return null;
    return key;
  }

  async isActiveKey(key: KeyRecord): Promise<boolean> {
    if (!keyActive(key, Date.now())) return false;
    return this.enforceFeishu ? !!(await this.keyOwner(key)) : !!(await this.store.getUser(key.owner));
  }

  private async keyOwner(key: KeyRecord): Promise<KeyOwner | null> {
    if (key.legacy_pending || !key.repos?.length) return null;
    const account = await this.store.getAccountByCodeupId(key.owner);
    if (account?.status !== 'active') return null;
    const user = await this.store.getUser(key.owner);
    return user ? { account, user } : null;
  }

  isWrite(key: Principal): boolean {
    return key.scope === 'write' && (this.enforceFeishu || this.options.writeUsers.includes(key.owner));
  }

  /** Platform administrator: unrestricted write key held by a configured user. */
  isAdmin(key: Principal): boolean {
    return !this.enforceFeishu && key.repos === null && this.isWrite(key);
  }

  /** Self-scoped read key: visibility follows the owner's live Codeup permissions. */
  isSelfScoped(key: Principal): boolean {
    return !this.enforceFeishu && key.repos === null && key.scope === 'read';
  }

  requireWrite(key: Principal): void {
    if (!this.isWrite(key)) fail(403, 'FORBIDDEN');
  }

  requireAdmin(key: Principal): void {
    this.requireWrite(key);
    if (!this.isAdmin(key)) fail(403, 'FORBIDDEN');
  }

  private freshProof(key: string) {
    const proof = this.cloudAccessCache.get(key);
    const ttl = Math.min(this.options.accessTtlMs, MAX_CODEUP_ACCESS_AGE_MS);
    return proof && proof.checkedAt + ttl > performance.now() ? proof : undefined;
  }

  hasFreshCloudAccess(user: UserRecord, repo: RepositoryRecord, source: boolean): boolean {
    return this.freshProof(cloudAccessKey(user, repo, source))?.allowed === true;
  }

  async checkCloudAccess(
    user: UserRecord,
    repo: RepositoryRecord,
    source: boolean,
    signal?: AbortSignal,
    fresh = false,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const cacheKey = cloudAccessKey(user, repo, source);
    const checkedAt = performance.now();
    const cached = this.freshProof(cacheKey);
    if (!fresh && cached) return cached.allowed;
    let allowed = false;
    try {
      const token = this.options.cipher.decrypt(user.credential, user.id);
      const remote = await this.options.codeup.getRepository(token, repo.codeup_id);
      if (hasRepositoryRole(remote)) {
        if (!source) {
          allowed = true;
        } else if (remote.httpUrlToRepo && this.options.probe && this.options.dataDir && this.options.allowedGitHosts) {
          allowed = await this.options.probe(
            {
              dataDir: this.options.dataDir,
              repositoryId: repo.id,
              branch: repo.branch,
              cloneUrl: remote.httpUrlToRepo,
              allowedGitHosts: this.options.allowedGitHosts,
              gitUsername: user.username,
              token,
            },
            signal,
          );
        }
      }
    } catch (error) {
      if (!(error instanceof CodeupError) || !['invalid_credential', 'forbidden', 'not_found'].includes(error.kind))
        throw error;
    }
    signal?.throwIfAborted();
    if (this.cloudAccessCache.size >= MAX_CODEUP_ACCESS_ENTRIES) {
      const oldest = this.cloudAccessCache.keys().next().value;
      if (oldest !== undefined) this.cloudAccessCache.delete(oldest);
    }
    if ((this.cloudAccessCache.get(cacheKey)?.checkedAt ?? -1) <= checkedAt) {
      this.cloudAccessCache.set(cacheKey, { allowed, checkedAt });
    }
    return allowed && this.hasFreshCloudAccess(user, repo, source);
  }

  /** Check for rotation/revocation and the exact indexed generation before returning repository information. */
  private async authorizeFeishuKey(
    key: Principal,
    repo: RepositoryRecord,
    source: boolean,
    signal?: AbortSignal,
  ): Promise<RepositoryRecord | null> {
    if (repo.status === 'disabled' || (source && repo.status === 'branch_deleted') || !key.repos?.includes(repo.id))
      return null;
    const owner = await this.keyOwner(key);
    if (!owner || !(await this.checkCloudAccess(owner.user, repo, source, signal))) return null;
    return await this.mutate(async () => {
      signal?.throwIfAborted();
      const [currentKey, latest] = await Promise.all([this.store.getKey(key.hash), this.store.getRepository(repo.id)]);
      if (
        !currentKey ||
        !keyActive(currentKey, Date.now()) ||
        currentKey.owner !== key.owner ||
        !currentKey.repos?.includes(repo.id) ||
        !latest ||
        latest.status === 'disabled' ||
        (source && latest.status === 'branch_deleted') ||
        latest.codeup_id !== repo.codeup_id ||
        latest.branch !== repo.branch ||
        latest.path !== repo.path ||
        latest.commit !== repo.commit
      )
        return null;
      const currentOwner = await this.keyOwner(currentKey);
      signal?.throwIfAborted();
      return currentOwner?.account.id === owner.account.id &&
        currentOwner.user.credential_version === owner.user.credential_version &&
        keyActive(currentKey, Date.now()) &&
        this.hasFreshCloudAccess(currentOwner.user, latest, source)
        ? latest
        : null;
    });
  }

  private accessFresh(row: AccessRecord | undefined, now: number): boolean {
    return !!row && row.allowed === 1 && row.verified_at + this.options.accessTtlMs > now;
  }

  keyAllows(key: Principal, repo: RepositoryRecord, access?: AccessRecord): boolean {
    if (key.repos !== null) return key.repos.includes(repo.id);
    if (this.isAdmin(key)) return true;
    return this.isSelfScoped(key) && this.accessFresh(access, Date.now());
  }

  /** A Codeup PAT that still belongs to the current version invalidates its owner's keys and synced repositories. */
  async invalidateUserCredential(userId: string, credentialVersion: number): Promise<void> {
    await this.mutate(() =>
      this.store.transaction(async (tx) => {
        const currentUser = await tx.getUser(userId);
        if (!currentUser || currentUser.credential_version !== credentialVersion) return;
        await tx.revokeUserKeys(userId);
        for (const repo of await tx.listRepositories()) {
          if (
            repo.sync_owner === userId &&
            repo.sync_credential_version === credentialVersion &&
            repo.status !== 'disabled' &&
            repo.status !== 'branch_deleted'
          ) {
            await tx.updateRepository(repo.id, { status: 'credential_required', error: 'SYNC_AUTHORIZATION_REQUIRED' });
          }
        }
      }),
    );
  }

  /** Re-verifies one (owner, repository) permission against Codeup when the cached row is missing or stale. */
  async verifyAccess(key: Principal, repo: RepositoryRecord, signal?: AbortSignal): Promise<AccessRecord | undefined> {
    const cached = await this.store.getAccess(key.owner, repo.id);
    const now = Date.now();
    if (cached && cached.verified_at + this.options.accessTtlMs > now) return cached;
    if (signal?.aborted) throw new Error('Request cancelled');
    const user = await this.store.getUser(key.owner);
    if (!user) return undefined;
    let allowed = 0;
    try {
      const remote = await this.options.codeup.getRepository(
        this.options.cipher.decrypt(user.credential, user.id),
        repo.codeup_id,
      );
      allowed = hasRepositoryRole(remote) ? 1 : 0;
    } catch (error) {
      if (!(error instanceof CodeupError)) throw error;
      if (error.kind === 'invalid_credential') {
        await this.invalidateUserCredential(user.id, user.credential_version);
        return undefined;
      }
      if (error.kind !== 'forbidden' && error.kind !== 'not_found') throw error;
    }
    const row: AccessRecord = { user_id: user.id, repo_id: repo.id, allowed, verified_at: Date.now() };
    return await this.mutate(() =>
      this.store.transaction(async (tx) => {
        const currentUser = await tx.getUser(user.id);
        if (!currentUser || currentUser.credential_version !== user.credential_version) return undefined;
        await tx.upsertAccess(row);
        return row;
      }),
    );
  }

  /**
   * Runs on the background maintenance timer: re-verifies stale cached permissions, seeds
   * missing (user, repository) pairs for users holding self-scoped keys, and
   * applies audit retention. Codeup outages end the round early; nothing is
   * granted without a successful check.
   */
  async maintenance(): Promise<void> {
    const now = Date.now();
    if (this.enforceFeishu) {
      await this.store.purgeAuditEvents(now - this.options.auditRetentionDays * 86_400_000);
      return;
    }
    const background = (owner: string): Principal => ({
      hash: '',
      prefix: '',
      owner,
      scope: 'read',
      repos: null,
      expires_at: null,
      revoked: 0,
    });
    let budget = MAINTENANCE_BUDGET;
    try {
      for (const row of await this.store.listStaleAccess(now - this.options.accessTtlMs, MAINTENANCE_BUDGET)) {
        if (budget-- <= 0) break;
        const repo = await this.store.getRepository(row.repo_id);
        if (!repo) continue;
        await this.verifyAccess(background(row.user_id), repo);
      }
      const repos = (await this.store.listRepositories()).filter((repo) => repo.status !== 'disabled');
      for (const user of await this.store.listUsers()) {
        if (budget <= 0) break;
        const keys = await this.store.listKeys(user.id);
        if (!keys.some((key) => this.isSelfScoped(key) && keyActive(key, now))) continue;
        const have = new Set((await this.store.listAccess(user.id)).map((row) => row.repo_id));
        for (const repo of repos) {
          if (have.has(repo.id)) continue;
          if (budget-- <= 0) break;
          if (!(await this.verifyAccess(background(user.id), repo))) break;
        }
      }
    } catch (error) {
      if (!(error instanceof CodeupError)) throw error;
    }
    await this.store.purgeAuditEvents(now - this.options.auditRetentionDays * 86_400_000);
  }

  /** Confirms, under the mutation lock, that the key and repository still permit access exactly as observed. */
  async authorize(key: Principal, repo: RepositoryRecord, signal?: AbortSignal): Promise<RepositoryRecord | null> {
    const access = this.isSelfScoped(key) ? await this.verifyAccess(key, repo, signal) : undefined;
    if (!this.keyAllows(key, repo, access)) return null;
    return await this.mutate(async () => {
      if (signal?.aborted) throw new Error('Request cancelled');
      const currentKey = await this.store.getKey(key.hash);
      const latest = await this.store.getRepository(repo.id);
      if (!currentKey || !latest) return null;
      const stillValid =
        keyActive(currentKey, Date.now()) &&
        currentKey.owner === key.owner &&
        !!(await this.store.getUser(key.owner)) &&
        latest.status !== 'disabled' &&
        this.keyAllows(currentKey, latest, access) &&
        latest.codeup_id === repo.codeup_id &&
        latest.branch === repo.branch &&
        latest.path === repo.path &&
        latest.commit === repo.commit;
      return stillValid ? latest : null;
    });
  }

  async visible(key: Principal, id: string, signal?: AbortSignal): Promise<RepositoryRecord> {
    const repo = await this.store.getRepository(id);
    if (!repo || repo.status === 'disabled') fail(404, 'NOT_FOUND');
    const authorized = this.enforceFeishu
      ? await this.authorizeFeishuKey(key, repo, false, signal)
      : await this.authorize(key, repo, signal);
    if (!authorized) fail(404, 'NOT_FOUND');
    return authorized;
  }

  private async listFeishuVisible(key: Principal, signal?: AbortSignal): Promise<RepositoryRecord[]> {
    const owner = await this.keyOwner(key);
    if (!owner) fail(401, 'UNAUTHENTICATED');
    const scoped = (await this.store.getRepositoriesByIds(key.repos ?? [])).filter(
      (repo) => repo.status !== 'disabled',
    );
    for (let offset = 0; offset < scoped.length; offset += CODEUP_LIST_CONCURRENCY) {
      signal?.throwIfAborted();
      const batch = scoped.slice(offset, offset + CODEUP_LIST_CONCURRENCY);
      await Promise.all(batch.map((repo) => this.checkCloudAccess(owner.user, repo, false, signal)));
    }
    return await this.mutate(async () => {
      const current = await this.store.getKey(key.hash);
      if (!current || current.owner !== key.owner || !keyActive(current, Date.now())) fail(401, 'UNAUTHENTICATED');
      const currentOwner = await this.keyOwner(current);
      if (
        currentOwner?.account.id !== owner.account.id ||
        currentOwner.user.credential_version !== owner.user.credential_version
      )
        fail(401, 'UNAUTHENTICATED');
      const latest = await this.store.getRepositoriesByIds(
        scoped.filter((repo) => current.repos?.includes(repo.id)).map((repo) => repo.id),
      );
      signal?.throwIfAborted();
      if (!keyActive(current, Date.now())) fail(401, 'UNAUTHENTICATED');
      return latest.filter(
        (repo) => repo.status !== 'disabled' && this.hasFreshCloudAccess(currentOwner.user, repo, false),
      );
    });
  }

  async listVisible(key: Principal, signal?: AbortSignal): Promise<RepositoryRecord[]> {
    if (this.enforceFeishu) return this.listFeishuVisible(key, signal);
    if (!(await this.store.getUser(key.owner))) fail(401, 'UNAUTHENTICATED');
    const candidates = (
      key.repos === null ? await this.store.listRepositories() : await this.store.getRepositoriesByIds(key.repos)
    ).filter((repo) => repo.status !== 'disabled');
    const access = new Map<string, AccessRecord>();
    if (this.isSelfScoped(key)) {
      for (const row of await this.store.listAccess(key.owner)) access.set(row.repo_id, row);
      const now = Date.now();
      const pending = candidates
        .filter((repo) => {
          const row = access.get(repo.id);
          return !row || row.verified_at + this.options.accessTtlMs <= now;
        })
        .sort((a, b) => (access.get(a.id)?.verified_at ?? 0) - (access.get(b.id)?.verified_at ?? 0));
      let budget = LIST_VERIFY_BUDGET;
      for (const repo of pending) {
        if (budget-- <= 0) break;
        if (signal?.aborted) throw new Error('Request cancelled');
        const row = await this.verifyAccess(key, repo, signal);
        if (!row) break;
        access.set(repo.id, row);
      }
    }
    const result = candidates.filter((repo) => this.keyAllows(key, repo, access.get(repo.id)));
    const currentUser = await this.store.getUser(key.owner);
    const currentKey = await this.store.getKey(key.hash);
    if (!currentUser || !currentKey || currentKey.owner !== key.owner || !keyActive(currentKey, Date.now())) {
      fail(401, 'UNAUTHENTICATED');
    }
    return result;
  }

  /** Code queries require an explicit repository scope or a self-scoped key; administrators cannot query. */
  async queryVisible(key: Principal, id: string, signal?: AbortSignal): Promise<RepositoryRecord> {
    if (this.enforceFeishu) {
      const repo = await this.store.getRepository(id);
      const authorized = repo && (await this.authorizeFeishuKey(key, repo, true, signal));
      if (!authorized) fail(404, 'NOT_FOUND');
      return authorized;
    }
    if (this.isAdmin(key)) fail(404, 'NOT_FOUND');
    return await this.visible(key, id, signal);
  }

  async queryList(key: Principal, signal?: AbortSignal): Promise<RepositoryRecord[]> {
    return this.isAdmin(key) ? [] : await this.listVisible(key, signal);
  }
}
