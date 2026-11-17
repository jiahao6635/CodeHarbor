import { ArrowsClockwise, GitBranch, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { isRepositoryActive, useRepositories, useSyncRepository } from '@/api/hooks';
import type { Repository } from '@/api/types';
import { useAbility } from '@/auth/session';
import { EmptyState } from '@/components/empty-state';
import { ErrorNotice } from '@/components/error-notice';
import { PageHeader } from '@/components/page-header';
import { RelativeTime } from '@/components/relative-time';
import { RepositoryCreatePermission } from '@/components/repository-create-permission';
import { RepositoryStatusBadge, repositoryStatusLabel } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { describeRepositoryError } from '@/lib/errors';
import { shortSha } from '@/lib/format';
import { toastError } from '@/lib/toast';

const STATUS_FILTERS = [
  { value: 'all', label: '全部状态' },
  { value: 'ready', label: '索引可用' },
  { value: 'active', label: '进行中' },
  { value: 'attention', label: '需要关注' },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]['value'];

function matchesFilter(repo: Repository, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'ready') return repo.status === 'ready';
  if (filter === 'active') return isRepositoryActive(repo);
  return ['failed', 'credential_required', 'branch_deleted'].includes(repo.status);
}

export function SyncButton({ repo, size = 'sm' }: { repo: Repository; size?: 'sm' | 'md' }) {
  const sync = useSyncRepository();
  return (
    <Button
      variant="secondary"
      size={size}
      loading={sync.isPending && sync.variables === repo.repo_id}
      disabled={isRepositoryActive(repo) || repo.status === 'credential_required'}
      onClick={() =>
        sync.mutate(repo.repo_id, {
          onSuccess: () => toast.success('已加入同步队列', { description: repo.name }),
          onError: (error) => toastError(error, '同步失败'),
        })
      }
    >
      <ArrowsClockwise aria-hidden="true" />
      同步
    </Button>
  );
}

export default function RepositoriesPage() {
  const { canWrite, isAdmin } = useAbility();
  const query = useRepositories();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');

  const repos = query.data ?? [];
  const activeCount = repos.filter(isRepositoryActive).length;
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return repos.filter(
      (repo) =>
        matchesFilter(repo, filter) &&
        (!term || repo.name.toLowerCase().includes(term) || repo.branch.toLowerCase().includes(term)),
    );
  }, [repos, search, filter]);

  return (
    <>
      <PageHeader
        title="仓库"
        description="当前 Key 可访问的已接入仓库及其索引状态。"
        actions={
          <Button asChild>
            <Link to="/repositories/new">
              <Plus aria-hidden="true" />
              接入仓库
            </Link>
          </Button>
        }
      />
      <RepositoryCreatePermission />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="repo-search">搜索</Label>
          <div className="relative">
            <MagnifyingGlass
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="repo-search"
              className="pl-9"
              placeholder="按名称或分支过滤"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5 sm:w-44">
          <Label htmlFor="repo-filter">状态</Label>
          <NativeSelect
            id="repo-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value as StatusFilter)}
          >
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <output className="text-xs text-muted-foreground sm:pb-2.5" aria-live="polite">
          {activeCount > 0
            ? `${activeCount} 个仓库构建中，每 10 秒自动刷新`
            : query.isFetching && query.data
              ? '刷新中…'
              : ''}
        </output>
      </div>

      {query.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-10 w-full" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorNotice error={query.error} />
      ) : repos.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          title={isAdmin ? '还没有接入任何仓库' : '当前 Key 没有可访问的仓库'}
          action={
            <Button asChild>
              <Link to="/repositories/new">接入第一个仓库</Link>
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={MagnifyingGlass} title="没有匹配的仓库" />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>名称</TableHead>
                  <TableHead>分支</TableHead>
                  <TableHead className="w-36">状态</TableHead>
                  <TableHead>索引 commit</TableHead>
                  <TableHead>索引时间</TableHead>
                  <TableHead className="w-24 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((repo) => (
                  <TableRow key={repo.repo_id}>
                    <TableCell>
                      <Link
                        to={`/repositories/${repo.repo_id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {repo.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{repo.branch}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <RepositoryStatusBadge status={repo.status} />
                        {repo.stale && repo.status !== 'ready' && repo.indexed_commit ? (
                          <Badge tone="warning" title="当前提供的是上一次成功的索引">
                            旧索引
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs" title={repo.indexed_commit ?? undefined}>
                      {shortSha(repo.indexed_commit)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <RelativeTime value={repo.indexed_at} />
                    </TableCell>
                    <TableCell className="text-right">{canWrite ? <SyncButton repo={repo} /> : null}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {/* Mobile cards */}
          <ul className="flex flex-col gap-2 md:hidden">
            {filtered.map((repo) => (
              <li key={repo.repo_id} className="rounded-md border border-border bg-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <Link to={`/repositories/${repo.repo_id}`} className="font-medium underline-offset-4 hover:underline">
                    {repo.name}
                  </Link>
                  <RepositoryStatusBadge status={repo.status} />
                </div>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <dt>分支</dt>
                  <dd className="font-mono">{repo.branch}</dd>
                  <dt>commit</dt>
                  <dd className="font-mono">{shortSha(repo.indexed_commit)}</dd>
                  <dt>索引时间</dt>
                  <dd>
                    <RelativeTime value={repo.indexed_at} />
                  </dd>
                  {repo.error ? (
                    <>
                      <dt>说明</dt>
                      <dd>{describeRepositoryError(repo.error)}</dd>
                    </>
                  ) : null}
                </dl>
                {canWrite ? (
                  <div className="mt-3 flex justify-end">
                    <SyncButton repo={repo} />
                  </div>
                ) : null}
                <span className="sr-only">状态：{repositoryStatusLabel(repo.status)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
