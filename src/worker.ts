import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CredentialCipher } from './auth.js';
import { CodeupClient, CodeupError, hasRepositoryRole } from './codeup.js';
import type { GraphClient } from './codegraph.js';
import { buildIndexCandidate, getRemoteHead, isPublishedIndexHealthy, pruneIndexVersions, IndexError, type IndexCandidate, type IndexRequest } from './indexer.js';
import { checkCloneAccess } from './clone-access.js';
import type { JobRecord } from './store.js';
import type { StoreBackend } from './async-store.js';

export type WorkerOptions = {
  store: StoreBackend;
  codeup: CodeupClient;
  cipher: CredentialCipher;
  graph: GraphClient;
  dataDir: string;
  allowedGitHosts: string[];
  codegraphBin?: string;
  reconcileIntervalMs?: number;
  /** Injected only by tests. */
  build?: (request: IndexRequest) => Promise<IndexCandidate>;
  head?: (request: IndexRequest) => Promise<string>;
  healthy?: (request: IndexRequest, worktree: string, commit: string) => Promise<boolean>;
  releaseCandidate?: (candidate: IndexCandidate) => void;
  probe?: (request: IndexRequest) => Promise<boolean>;
};

/** A single-process worker. Multi-process deployments require durable leases and fencing. */
export class IndexWorker {
  private running = false;
  private active: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: WorkerOptions) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.options.store.transaction(async (tx) => {
        for (const job of await tx.listPendingJobs()) {
          if (job.status === 'running') await tx.updateJob(job.id, { status: 'queued', queued_at: Date.now(), finished_at: null, build_duration_ms: null });
        }
      });
    } catch (error) { this.running = false; throw error; }
    const interval = this.options.reconcileIntervalMs ?? 15 * 60_000;
    if (interval > 0) {
      this.timer = setInterval(() => {
        void this.reconcile().catch(() => console.error('Index reconciliation failed'));
      }, interval);
      this.timer.unref();
    }
    this.kick();
  }

  private async reconcile(): Promise<void> {
    for (const repo of await this.options.store.listRepositories()) {
      if (repo.status !== 'disabled') await this.enqueue(repo.id, 'reconcile');
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  async enqueue(repoId: string, reason: string): Promise<JobRecord> {
    const store = this.options.store;
    const job = await store.transaction(async (tx) => {
      const repo = await tx.getRepository(repoId);
      if (!repo || repo.status === 'disabled') throw new Error('Repository not found');
      const jobs = await tx.listJobs(repoId);
      const queued = jobs.find((item) => item.status === 'queued');
      const preserveDeletion = repo.status === 'branch_deleted' && jobs.some((item) => item.status === 'running');
      if (queued) {
        if (repo.status === 'branch_deleted' && !preserveDeletion) await tx.updateRepository(repoId, { status: repo.path ? 'updating' : 'pending', error: null });
        return queued;
      }
      const now = Date.now();
      const created: JobRecord = { id: randomUUID(), repo_id: repoId, status: 'queued', reason, created_at: now, queued_at: now, error: null };
      await tx.createJob(created);
      if (!preserveDeletion) await tx.updateRepository(repoId, { status: repo.path ? 'updating' : 'pending', error: null });
      return created;
    });
    this.kick();
    return job;
  }

  kick(): void {
    if (!this.running || this.active) return;
    this.active = this.run().catch(() => {
      console.error('Index worker failed');
    }).finally(async () => {
      this.active = undefined;
      try {
        if (this.running && (await this.options.store.listPendingJobs()).some((job) => job.status === 'queued')) this.kick();
      } catch { console.error('Index worker queue check failed'); }
    });
  }

  private async run(): Promise<void> {
    while (this.running) {
      const job = (await this.options.store.listPendingJobs()).find((item) => item.status === 'queued');
      if (!job) return;
      await this.execute(job);
    }
  }

  private async execute(job: JobRecord): Promise<void> {
    const { store, cipher, codeup, graph } = this.options;
    const repo = await store.getRepository(job.repo_id);
    if (!repo || repo.status === 'disabled') {
      await store.updateJob(job.id, { status: 'failed', error: 'Repository unavailable', finished_at: Date.now(), build_duration_ms: null });
      return;
    }
    await store.transaction(async (tx) => {
      await tx.updateJob(job.id, { status: 'running', error: null, finished_at: null, build_duration_ms: null });
      await tx.updateRepository(repo.id, { status: repo.path ? 'updating' : 'indexing', error: null });
    });
    let candidate: IndexCandidate | null = null;
    let buildDurationMs: number | null = null;
    let published = false;
    try {
      const user = await store.getUser(repo.sync_owner);
      if (!user || user.credential_version !== repo.sync_credential_version || repo.sync_credential_version === 0) {
        throw new IndexError('CREDENTIAL_REQUIRED', 'Sync credential requires authorization');
      }
      const token = cipher.decrypt(user.credential, user.id);
      const source = await codeup.getRepository(token, repo.codeup_id);
      if (!hasRepositoryRole(source) || !source.httpUrlToRepo) throw new IndexError('CREDENTIAL_REQUIRED', 'Sync credential cannot read the repository');
      const request: IndexRequest = {
        dataDir: this.options.dataDir, repositoryId: repo.id, branch: repo.branch,
        cloneUrl: source.httpUrlToRepo, allowedGitHosts: this.options.allowedGitHosts,
        gitUsername: user.username, token, codegraphBin: this.options.codegraphBin,
      };
      if (!(await (this.options.probe ?? checkCloneAccess)({ ...request, branch: source.defaultBranch ?? request.branch }))) throw new IndexError('CREDENTIAL_REQUIRED', 'Sync credential cannot clone the repository');
      const current = await (this.options.head ?? getRemoteHead)(request);
      const healthy = current === repo.commit && repo.path && await (this.options.healthy ?? isPublishedIndexHealthy)(request, repo.path, current);
      if (!healthy) {
        const started = performance.now();
        try { candidate = await (this.options.build ?? buildIndexCandidate)(request); }
        finally { buildDurationMs = Math.max(0, Math.round(performance.now() - started)); }
      }
      // Image packaging can take time after indexing; never publish an older branch head.
      if (candidate && await (this.options.head ?? getRemoteHead)(request) !== candidate.commit) {
        throw new IndexError('REMOTE_CHANGED', 'Remote branch changed during indexing');
      }
      const confirmed = await codeup.getRepository(token, repo.codeup_id);
      if (!hasRepositoryRole(confirmed) || !confirmed.httpUrlToRepo || confirmed.httpUrlToRepo !== source.httpUrlToRepo ||
          !(await (this.options.probe ?? checkCloneAccess)({ ...request, branch: confirmed.defaultBranch ?? request.branch }))) {
        throw new IndexError('CREDENTIAL_REQUIRED', 'Sync credential cannot clone the repository');
      }
      const publish = async () => {
        await store.transaction(async (tx) => {
          const latest = await tx.getRepository(repo.id);
          const latestUser = await tx.getUser(user.id);
          if (latest && latest.sync_owner === user.id && (!latestUser || latest.sync_credential_version === 0 || latestUser.credential_version !== latest.sync_credential_version)) {
            throw new IndexError('CREDENTIAL_REQUIRED', 'Sync credential requires authorization');
          }
          if (!latest || latest.status === 'disabled' || latest.status === 'branch_deleted' || latest.branch !== repo.branch || latest.sync_owner !== user.id ||
              latest.sync_credential_version !== repo.sync_credential_version || !latestUser ||
              latestUser.credential_version !== user.credential_version || (await tx.getJob(job.id))?.status !== 'running') {
            throw new IndexError('SUPERSEDED', 'Repository configuration changed during indexing');
          }
          const imageCandidate = !!candidate && /^oci:\/\/sha256:[a-f0-9]{64}$/.test(candidate.path);
          const priorImage = !!latest.path && /^oci:\/\/sha256:[a-f0-9]{64}$/.test(latest.path) &&
            !!latest.commit && /^[a-f0-9]{40,64}$/.test(latest.commit);
          await tx.updateRepository(repo.id, {
            ...(candidate ? { path: candidate.path, commit: candidate.commit, indexed_at: Date.now() } : {}),
            ...(imageCandidate && (candidate!.path !== latest.path || candidate!.commit !== latest.commit)
              ? { previous_image: priorImage ? latest.path : null, previous_commit: priorImage ? latest.commit : null } : {}),
            status: (await tx.listJobs(repo.id)).some((entry) => entry.status === 'queued') ? 'updating' : 'ready',
            error: null,
          });
          await tx.updateJob(job.id, { status: 'succeeded', error: null, finished_at: Date.now(), build_duration_ms: buildDurationMs });
        });
      };
      if (candidate) await graph.withExclusive(async (explore) => {
        await explore(candidate!.path, 'repository overview', undefined, { repoId: repo.id, commit: candidate!.commit });
        if (await (this.options.head ?? getRemoteHead)(request) !== candidate!.commit) {
          throw new IndexError('REMOTE_CHANGED', 'Remote branch changed during indexing');
        }
        await publish();
        published = true;
        // Image publication must preserve any existing checkout for migration rollback.
        if (!candidate!.path.startsWith('oci://')) await pruneIndexVersions(this.options.dataDir, repo.id, [repo.path, candidate!.path]);
      });
      else await publish();
    } catch (error) {
      const message = error instanceof IndexError ? error.message : error instanceof CodeupError ? `Cloud DevOps: ${error.kind}` : 'Index update failed';
      const credentials = (error instanceof IndexError && error.code === 'CREDENTIAL_REQUIRED') ||
        (error instanceof CodeupError && ['invalid_credential', 'forbidden', 'not_found'].includes(error.kind));
      await store.transaction(async (tx) => {
        await tx.updateJob(job.id, { status: 'failed', error: message, finished_at: Date.now(), build_duration_ms: buildDurationMs });
        const latest = await tx.getRepository(repo.id);
        if (latest && latest.status !== 'disabled' && latest.status !== 'branch_deleted') {
          const queued = (await tx.listJobs(repo.id)).some((entry) => entry.status === 'queued');
          const status = error instanceof IndexError && error.code === 'BRANCH_NOT_FOUND' ? 'branch_deleted'
            : queued ? 'updating' : credentials ? 'credential_required' : latest.path ? 'stale' : 'failed';
          await tx.updateRepository(repo.id, { status, error: message });
        }
      });
      const latest = await store.getRepository(repo.id);
      if (error instanceof IndexError && error.code === 'REMOTE_CHANGED' && this.running && latest && latest.status !== 'branch_deleted' && latest.status !== 'disabled') {
        await this.enqueue(repo.id, 'branch_changed');
      }
    } finally {
      if (candidate) this.options.releaseCandidate?.(candidate);
      // Only remove a path constructed for this repository and this generation.
      if (candidate && !published && /^[0-9a-f-]{36}$/.test(candidate.generation)) {
        const expected = resolve(this.options.dataDir, 'repositories', repo.id, 'versions', candidate.generation, 'worktree');
        if (resolve(candidate.path) === expected) await rm(dirname(expected), { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
