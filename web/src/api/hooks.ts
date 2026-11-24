import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type {
  AccountRole,
  AccountStatus,
  AdminKeyInfo,
  AdminRepository,
  AdminSystemPerformance,
  AuditEvent,
  CodeupRepository,
  ConsoleConfig,
  CreatedKey,
  CreatedRepository,
  Job,
  KeyInfo,
  Repository,
  Scope,
  UserSummary,
} from './types';

export const queryKeys = {
  me: ['me'] as const,
  console: ['console'] as const,
  repositories: ['repositories'] as const,
  repository: (id: string) => ['repositories', id] as const,
  repositoryJobs: (id: string) => ['repositories', id, 'jobs'] as const,
  job: (id: string) => ['jobs', id] as const,
  codeupRepositories: (page: number) => ['codeup', page] as const,
  keys: ['keys'] as const,
  adminRepositories: ['admin', 'repositories'] as const,
  adminUsers: ['admin', 'users'] as const,
  adminKeys: (owner: string | undefined, page: number) => ['admin', 'keys', owner ?? '', page] as const,
  adminAudit: (filter: AuditFilter) => ['admin', 'audit', filter] as const,
  adminSystemPerformance: ['admin', 'system', 'performance'] as const,
};

const ACTIVE_REPOSITORY = new Set(['pending', 'indexing', 'updating']);
const ACTIVE_JOB = new Set(['queued', 'running']);

export const isRepositoryActive = (repo: Pick<Repository, 'status'>) => ACTIVE_REPOSITORY.has(repo.status);
export const isJobActive = (job: Pick<Job, 'status'>) => ACTIVE_JOB.has(job.status);

/** Polls only while something is in flight and the tab is visible. */
const pollWhile =
  <T>(active: (data: T) => boolean, intervalMs: number) =>
  (query: { state: { data?: T } }) => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
    const data = query.state.data;
    return data !== undefined && active(data) ? intervalMs : false;
  };

export function useConsoleConfig() {
  return useQuery({
    queryKey: queryKeys.console,
    queryFn: () => apiFetch<ConsoleConfig>('/api/v1/console'),
    staleTime: 60_000,
    retry: false,
  });
}

export function useRepositories(forKey = false) {
  return useQuery({
    queryKey: forKey ? [...queryKeys.repositories, 'for-key'] : queryKeys.repositories,
    queryFn: async () =>
      (
        await apiFetch<{ repositories: Repository[] }>(
          forKey ? '/api/v1/repositories?for_key=1' : '/api/v1/repositories',
        )
      ).repositories,
    refetchInterval: pollWhile<Repository[]>((repos) => repos.some(isRepositoryActive), 10_000),
  });
}

export function useRepository(id: string) {
  return useQuery({
    queryKey: queryKeys.repository(id),
    queryFn: () => apiFetch<Repository>(`/api/v1/repositories/${encodeURIComponent(id)}`),
    refetchInterval: pollWhile<Repository>(isRepositoryActive, 5_000),
  });
}

export function useRepositoryJobs(id: string, options?: { watchIdle?: boolean; repositoryActive?: boolean }) {
  return useQuery({
    queryKey: queryKeys.repositoryJobs(id),
    queryFn: async () => (await apiFetch<{ jobs: Job[] }>(`/api/v1/repositories/${encodeURIComponent(id)}/jobs`)).jobs,
    refetchInterval: ({ state: { data } }) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
      if (options?.repositoryActive || data?.some(isJobActive)) return 5_000;
      return options?.watchIdle && data !== undefined ? 30_000 : false;
    },
  });
}

export function useJob(id: string) {
  return useQuery({
    queryKey: queryKeys.job(id),
    queryFn: () => apiFetch<Job>(`/api/v1/jobs/${encodeURIComponent(id)}`),
    refetchInterval: pollWhile<Job>(isJobActive, 5_000),
  });
}

export function useCodeupRepositories(page: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.codeupRepositories(page),
    queryFn: () =>
      apiFetch<{ repositories: CodeupRepository[]; next_page: number | null }>(
        `/api/v1/codeup/repositories?page=${page}`,
      ),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useKeys() {
  return useQuery({
    queryKey: queryKeys.keys,
    queryFn: async () => (await apiFetch<{ keys: KeyInfo[] }>('/api/v1/api-keys')).keys,
  });
}

export function useAdminRepositories() {
  return useQuery({
    queryKey: queryKeys.adminRepositories,
    queryFn: async () =>
      (await apiFetch<{ repositories: AdminRepository[] }>('/api/v1/admin/repositories')).repositories,
    refetchInterval: pollWhile<AdminRepository[]>((repos) => repos.some(isRepositoryActive), 10_000),
  });
}

export function useAdminUsers() {
  return useQuery({
    queryKey: queryKeys.adminUsers,
    queryFn: async () => (await apiFetch<{ users: UserSummary[] }>('/api/v1/admin/users')).users,
  });
}

export function useAdminSystemPerformance(autoRefresh: boolean) {
  return useQuery({
    queryKey: queryKeys.adminSystemPerformance,
    queryFn: ({ signal }) => apiFetch<AdminSystemPerformance>('/api/v1/admin/system/performance', { signal }),
    refetchInterval: autoRefresh ? 15_000 : false,
    refetchOnWindowFocus: autoRefresh,
    refetchOnReconnect: autoRefresh,
    retry: false,
  });
}

export function useAdminKeys(owner: string | undefined, page: number) {
  const params = new URLSearchParams({ page: String(page) });
  if (owner) params.set('owner', owner);
  return useQuery({
    queryKey: queryKeys.adminKeys(owner, page),
    queryFn: () => apiFetch<{ keys: AdminKeyInfo[]; next_page: number | null }>(`/api/v1/admin/api-keys?${params}`),
  });
}

export interface AuditFilter {
  subject?: string;
  repo_id?: string;
  since?: number;
  limit: number;
}

export function useAdminAudit(filter: AuditFilter) {
  const params = new URLSearchParams({ limit: String(filter.limit) });
  if (filter.subject) params.set('subject', filter.subject);
  if (filter.repo_id) params.set('repo_id', filter.repo_id);
  if (filter.since) params.set('since', String(filter.since));
  return useQuery({
    queryKey: queryKeys.adminAudit(filter),
    queryFn: async () => (await apiFetch<{ events: AuditEvent[] }>(`/api/v1/admin/audit?${params}`)).events,
  });
}

// ---- Mutations -------------------------------------------------------------------------------

export function useSyncRepository() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ job_id: string }>(`/api/v1/repositories/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
    onSuccess: (_result, id) => {
      void client.invalidateQueries({ queryKey: queryKeys.repository(id) });
      void client.invalidateQueries({ queryKey: queryKeys.repositoryJobs(id) });
      void client.invalidateQueries({ queryKey: queryKeys.repositories });
      void client.invalidateQueries({ queryKey: queryKeys.adminRepositories });
    },
  });
}

export function useAuthorizeSyncCredential() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ job_id: string }>(`/api/v1/repositories/${encodeURIComponent(id)}/sync-credential`, {
        method: 'PUT',
        body: { authorize_automatic_sync: true },
      }),
    onSuccess: (_result, id) => {
      void client.invalidateQueries({ queryKey: queryKeys.repository(id) });
      void client.invalidateQueries({ queryKey: queryKeys.repositoryJobs(id) });
      void client.invalidateQueries({ queryKey: queryKeys.repositories });
    },
  });
}

export function useCreateRepository() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { codeup_repository_id: string; branch: string; sync_interval_minutes?: number | null }) =>
      apiFetch<CreatedRepository | { repository: Repository }>('/api/v1/repositories', {
        method: 'POST',
        body: { ...input, authorize_automatic_sync: true },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.repositories });
      void client.invalidateQueries({ queryKey: queryKeys.adminRepositories });
    },
  });
}

type Lifecycle = 'disable' | 'enable';

export function useRepositoryLifecycle() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: Lifecycle }) =>
      apiFetch<{ repository: Repository; job_id?: string }>(
        `/api/v1/repositories/${encodeURIComponent(id)}/${action}`,
        { method: 'POST' },
      ),
    onSuccess: (_result, { id }) => {
      void client.invalidateQueries({ queryKey: queryKeys.repository(id) });
      void client.invalidateQueries({ queryKey: queryKeys.repositoryJobs(id) });
      void client.invalidateQueries({ queryKey: queryKeys.repositories });
      void client.invalidateQueries({ queryKey: queryKeys.adminRepositories });
    },
  });
}

export function useDeleteRepository() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/v1/repositories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.repositories });
      void client.invalidateQueries({ queryKey: queryKeys.adminRepositories });
    },
  });
}

export function createKey(input: { scope: Scope; repos: string[]; expires_in: number | null }) {
  return apiFetch<CreatedKey>('/api/v1/api-keys', { method: 'POST', body: input });
}

export function useCreateKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createKey,
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.keys }),
  });
}

export function useRevokeKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (prefix: string) =>
      apiFetch<{ revoked: boolean }>(`/api/v1/api-keys/${encodeURIComponent(prefix)}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.keys }),
  });
}

export function useAdminRevokeKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (prefix: string) =>
      apiFetch<{ revoked: boolean }>(`/api/v1/admin/api-keys/${encodeURIComponent(prefix)}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['admin', 'keys'] }),
  });
}

export function useAdminRevokeUserKeys() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<{ revoked: boolean }>(`/api/v1/admin/users/${encodeURIComponent(userId)}/revoke-keys`, {
        method: 'POST',
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['admin', 'keys'] }),
  });
}

export function useUpdateAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { role?: AccountRole; status?: AccountStatus } }) =>
      apiFetch(`/api/v1/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.adminUsers });
      void client.invalidateQueries({ queryKey: queryKeys.me });
      void client.invalidateQueries({ queryKey: ['admin', 'keys'] });
    },
  });
}

export function useApproveLegacyKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (prefix: string) =>
      apiFetch(`/api/v1/admin/api-keys/${encodeURIComponent(prefix)}/approve`, { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['admin', 'keys'] }),
  });
}
