import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CredentialCipher } from './auth.js';
import { CodeupClient, CodeupError, hasRepositoryRole } from './codeup.js';
import { CodeGraphClient } from './codegraph.js';
import { buildIndexCandidate, getRemoteHead, IndexError, type IndexCandidate, type IndexRequest } from './indexer.js';
import { Store, type JobRecord } from './store.js';

export type WorkerOptions = {
  store: Store;
  codeup: CodeupClient;
  cipher: CredentialCipher;
  graph: CodeGraphClient;
  dataDir: string;
  allowedGitHosts: string[];
  codegraphBin?: string;
  reconcileIntervalMs?: number;
  /** Injected only by tests. */
  build?: (request: IndexRequest) => Promise<IndexCandidate>;
  head?: (request: IndexRequest) => Promise<string>;
};

/** A single-process worker. Multi-process deployments require durable leases and fencing. */
export class IndexWorker {
  private running = false;
  private active: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: WorkerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.options.store.transaction(() => {
      for (const job of this.options.store.listPendingJobs()) {
        if (job.status === 'running') this.options.store.updateJob(job.id, { status: 'queued' });
      }
    });
    const interval = this.options.reconcileIntervalMs ?? 15 * 60_000;
    if (interval > 0) {
      this.timer = setInterval(() => {
        for (const repo of this.options.store.listRepositories()) {
          if (repo.status !== 'disabled' && repo.status !== 'branch_deleted') this.enqueue(repo.id, 'reconcile');
        }
      }, interval);
      this.timer.unref();
    }
    this.kick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  enqueue(repoId: string, reason: string): JobRecord {
    const store = this.options.store;
    const job = store.transaction(() => {
      const repo = store.getRepository(repoId);
      if (!repo || repo.status === 'disabled') throw new Error('Repository not found');
      const queued = store.listJobs(repoId).find((item) => item.status === 'queued');
      if (queued) {
        if (repo.status === 'branch_deleted') store.updateRepository(repoId, { status: repo.path ? 'updating' : 'pending', error: null });
        return queued;
      }
      const created: JobRecord = { id: randomUUID(), repo_id: repoId, status: 'queued', reason, created_at: Date.now(), error: null };
      store.createJob(created);
      store.updateRepository(repoId, { status: repo.path ? 'updating' : 'pending', error: null });
      return created;
    });
    this.kick();
    return job;
  }

  kick(): void {
    if (!this.running || this.active) return;
    this.active = this.run().catch(() => {
      console.error('Index worker failed');
    }).finally(() => {
      this.active = undefined;
      if (this.running && this.options.store.listPendingJobs().some((job) => job.status === 'queued')) this.kick();
    });
  }

  private async run(): Promise<void> {
    while (this.running) {
      const job = this.options.store.listPendingJobs().find((item) => item.status === 'queued');
      if (!job) return;
      await this.execute(job);
    }
  }

  private async execute(job: JobRecord): Promise<void> {
    const { store, cipher, codeup, graph } = this.options;
    const repo = store.getRepository(job.repo_id);
    if (!repo || repo.status === 'disabled' || repo.status === 'branch_deleted') {
      store.updateJob(job.id, { status: 'failed', error: 'Repository unavailable' });
      return;
    }
    store.transaction(() => {
      store.updateJob(job.id, { status: 'running', error: null });
      store.updateRepository(repo.id, { status: repo.path ? 'updating' : 'indexing', error: null });
    });
    let candidate: IndexCandidate | null = null;
    let published = false;
    try {
      const user = store.getUser(repo.sync_owner);
      if (!user || user.credential_version !== repo.sync_credential_version || repo.sync_credential_version === 0) {
        throw new IndexError('CREDENTIAL_REQUIRED', 'Sync credential requires authorization');
      }
      const token = cipher.decrypt(user.credential, user.id);
      const source = await codeup.getRepository(token, repo.codeup_id);
      if (!hasRepositoryRole(source) || !source.httpUrlToRepo) throw new IndexError('CREDENTIAL_REQUIRED', 'Sync credential cannot read the repository');
      const username = await codeup.getCloneUsername(token, user.id);
      const request: IndexRequest = {
        dataDir: this.options.dataDir, repositoryId: repo.id, branch: repo.branch,
        cloneUrl: source.httpUrlToRepo, allowedGitHosts: this.options.allowedGitHosts,
        gitUsername: username, token, codegraphBin: this.options.codegraphBin,
      };
      const current = await (this.options.head ?? getRemoteHead)(request);
      candidate = current === repo.commit && repo.path ? null : await (this.options.build ?? buildIndexCandidate)(request);
      const publish = () => {
        store.transaction(() => {
          const latest = store.getRepository(repo.id);
          const latestUser = store.getUser(user.id);
          if (latest && latest.sync_owner === user.id && (!latestUser || latest.sync_credential_version === 0 || latestUser.credential_version !== latest.sync_credential_version)) {
            throw new IndexError('CREDENTIAL_REQUIRED', 'Sync credential requires authorization');
          }
          if (!latest || latest.status === 'disabled' || latest.status === 'branch_deleted' || latest.branch !== repo.branch || latest.sync_owner !== user.id ||
              latest.sync_credential_version !== repo.sync_credential_version || !latestUser ||
              latestUser.credential_version !== user.credential_version || store.getJob(job.id)?.status !== 'running') {
            throw new IndexError('SUPERSEDED', 'Repository configuration changed during indexing');
          }
          store.updateRepository(repo.id, {
            ...(candidate ? { path: candidate.path, commit: candidate.commit, indexed_at: Date.now() } : {}),
            status: store.listJobs(repo.id).some((entry) => entry.status === 'queued') ? 'updating' : 'ready',
            error: null,
          });
          store.updateJob(job.id, { status: 'succeeded', error: null });
        });
      };
      if (candidate) await graph.withExclusive(async (explore) => {
        await explore(candidate!.path, 'repository overview');
        publish();
        published = true;
      });
      else publish();
    } catch (error) {
      const message = error instanceof IndexError ? error.message : error instanceof CodeupError ? `Cloud DevOps: ${error.kind}` : 'Index update failed';
      const credentials = (error instanceof IndexError && error.code === 'CREDENTIAL_REQUIRED') ||
        (error instanceof CodeupError && ['invalid_credential', 'forbidden', 'not_found'].includes(error.kind));
      store.transaction(() => {
        store.updateJob(job.id, { status: 'failed', error: message });
        const latest = store.getRepository(repo.id);
        if (latest && latest.status !== 'disabled' && latest.status !== 'branch_deleted') {
          const queued = store.listJobs(repo.id).some((entry) => entry.status === 'queued');
          store.updateRepository(repo.id, { status: queued ? 'updating' : credentials ? 'credential_required' : latest.path ? 'stale' : 'failed', error: message });
        }
      });
      const latest = store.getRepository(repo.id);
      if (error instanceof IndexError && error.code === 'REMOTE_CHANGED' && this.running && latest && latest.status !== 'branch_deleted' && latest.status !== 'disabled') {
        this.enqueue(repo.id, 'branch_changed');
      }
    } finally {
      // Only remove a path constructed for this repository and this generation.
      if (candidate && !published && /^[0-9a-f-]{36}$/.test(candidate.generation)) {
        const expected = resolve(this.options.dataDir, 'repositories', repo.id, 'versions', candidate.generation, 'worktree');
        if (resolve(candidate.path) === expected) await rm(dirname(expected), { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
