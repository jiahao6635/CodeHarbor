import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type {
  AdminKeyInfo,
  AdminRepository,
  AuditEvent,
  BootstrapKey,
  BootstrapSession,
  CodeupRepository,
  ConsoleConfig,
  CreatedKey,
  CreatedRepository,
  Job,
  KeyInfo,
  Me,
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

export function useMe(enabled = true) {
  return useQuery({ queryKey: queryKeys.me, queryFn: () => apiFetch<Me>('/api/v1/me'), enabled, staleTime: 60_000 });
}

export function useConsoleConfig() {
  return useQuery({
    queryKey: queryKeys.console,
    queryFn: () => apiFetch<ConsoleConfig>('/api/v1/console'),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function useRepositories() {
  return useQuery({
    queryKey: queryKeys.repositories,
    queryFn: async () => (await apiFetch<{ repositories: Repository[] }>('/api/v1/repositories')).repositories,
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

export function useRepositoryJobs(id: string) {
  return useQuery({
    queryKey: queryKeys.repositoryJobs(id),
    queryFn: async () => (await apiFetch<{ jobs: Job[] }>(`/api/v1/repositories/${encodeURIComponent(id)}/jobs`)).jobs,
    refetchInterval: pollWhile<Job[]>((jobs) => jobs.some(isJobActive), 5_000),
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
    mutationFn: (input: { codeup_repository_id: string; branch: string }) =>
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

export function useCreateKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { scope: Scope; repos: string[] | null; expires_in: number }) =>
      apiFetch<CreatedKey>('/api/v1/api-keys', { method: 'POST', body: input }),
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

// ---- Onboarding (no session) ------------------------------------------------------------------

export function bindYunxiao(pat: string, signal?: AbortSignal) {
  return apiFetch<BootstrapSession>('/api/v1/auth/yunxiao/bind', {
    method: 'POST',
    body: { pat },
    token: null,
    signal,
  });
}

export function createBootstrapKey(bootstrapToken: string, input: { scope: Scope; expires_in: number }) {
  return apiFetch<BootstrapKey>('/api/v1/auth/bootstrap/keys', { method: 'POST', body: input, token: bootstrapToken });
}

export function fetchMeWith(token: string) {
  return apiFetch<Me>('/api/v1/me', { token, keepSession: true });
}
