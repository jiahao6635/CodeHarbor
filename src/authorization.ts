import type { CredentialCipher } from './auth.js';
import { hashAccessKey } from './auth.js';
import { type CodeupClient, CodeupError, hasRepositoryRole } from './codeup.js';
import { fail } from './http/errors.js';
import type { AccessRecord, KeyRecord, RepositoryRecord, StoreBackend } from './store.js';

export type Principal = KeyRecord;

export type AuthorizationOptions = {
  store: StoreBackend;
  codeup: Pick<CodeupClient, 'getRepository'>;
  cipher: CredentialCipher;
  writeUsers: string[];
  accessTtlMs: number;
  auditRetentionDays: number;
};

const BEARER = /^Bearer (ch_[A-Za-z0-9_-]{43})$/;
const MAINTENANCE_BUDGET = 200;
/** Bounded on-demand verification keeps listing cost independent of repository count. */
const LIST_VERIFY_BUDGET = 20;

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

export class Authorization {
  private readonly store: StoreBackend;
  readonly mutate = createMutex();

  constructor(private readonly options: AuthorizationOptions) {
    this.store = options.store;
  }

  async authenticateBearer(authorization: string): Promise<Principal | null> {
    const token = bearerToken(authorization);
    if (!token) return null;
    const key = await this.store.getKey(hashAccessKey(token));
    if (!key || !keyActive(key, Date.now()) || !(await this.store.getUser(key.owner))) return null;
    return key;
  }

  isWrite(key: Principal): boolean {
    return key.scope === 'write' && this.options.writeUsers.includes(key.owner);
  }

  /** Platform administrator: unrestricted write key held by a configured user. */
  isAdmin(key: Principal): boolean {
    return key.repos === null && this.isWrite(key);
  }

  /** Self-scoped read key: visibility follows the owner's live Codeup permissions. */
  isSelfScoped(key: Principal): boolean {
    return key.repos === null && key.scope === 'read';
  }

  requireWrite(key: Principal): void {
    if (!this.isWrite(key)) fail(403, 'FORBIDDEN');
  }

  requireAdmin(key: Principal): void {
    this.requireWrite(key);
    if (!this.isAdmin(key)) fail(403, 'FORBIDDEN');
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
   * Runs every reconcile round: re-verifies stale cached permissions, seeds
   * missing (user, repository) pairs for users holding self-scoped keys, and
   * applies audit retention. Codeup outages end the round early; nothing is
   * granted without a successful check.
   */
  async maintenance(): Promise<void> {
    const now = Date.now();
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
    const authorized = await this.authorize(key, repo, signal);
    if (!authorized) fail(404, 'NOT_FOUND');
    return authorized;
  }

  async listVisible(key: Principal, signal?: AbortSignal): Promise<RepositoryRecord[]> {
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
    if (this.isAdmin(key)) fail(404, 'NOT_FOUND');
    return await this.visible(key, id, signal);
  }

  async queryList(key: Principal, signal?: AbortSignal): Promise<RepositoryRecord[]> {
    return this.isAdmin(key) ? [] : await this.listVisible(key, signal);
  }
}
