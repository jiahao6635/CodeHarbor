import { GitBranch, Plus } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useAdminRepositories, useDeleteRepository, useRepositoryLifecycle } from '@/api/hooks';
import type { AdminRepository } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { ErrorNotice } from '@/components/error-notice';
import { PageHeader } from '@/components/page-header';
import { RelativeTime } from '@/components/relative-time';
import { RepositoryStatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { shortSha } from '@/lib/format';
import { toastError } from '@/lib/toast';

type Pending = { action: 'disable' | 'delete'; repo: AdminRepository } | null;

export default function AdminRepositoriesPage() {
  const query = useAdminRepositories();
  const lifecycle = useRepositoryLifecycle();
  const remove = useDeleteRepository();
  const [search, setSearch] = useState('');
  const [onlyDisabled, setOnlyDisabled] = useState('all');
  const [pending, setPending] = useState<Pending>(null);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (query.data ?? []).filter(
      (repo) =>
        (onlyDisabled === 'all' || (onlyDisabled === 'disabled') === (repo.status === 'disabled')) &&
        (!term ||
          repo.name.toLowerCase().includes(term) ||
          repo.owner.toLowerCase().includes(term) ||
          repo.sync_owner.toLowerCase().includes(term) ||
          repo.codeup_id.includes(term)),
    );
  }, [query.data, search, onlyDisabled]);

  const enable = (repo: AdminRepository) =>
    lifecycle.mutate(
      { id: repo.repo_id, action: 'enable' },
      {
        onSuccess: () => toast.success('已启用并加入同步队列', { description: repo.name }),
        onError: (error) => toastError(error, '启用失败'),
      },
    );

  return (
    <>
      <PageHeader
        title="全部仓库"
        description="包含已禁用的仓库。仅已禁用的仓库可以删除。"
        actions={
          <Button asChild>
            <Link to="/repositories/new">
              <Plus aria-hidden="true" />
              接入仓库
            </Link>
          </Button>
        }
      />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="admin-repo-search">搜索</Label>
          <Input
            id="admin-repo-search"
            placeholder="名称、云效 ID、接入者或同步凭证持有人"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:w-40">
          <Label htmlFor="admin-repo-filter">筛选</Label>
          <NativeSelect
            id="admin-repo-filter"
            value={onlyDisabled}
            onChange={(event) => setOnlyDisabled(event.target.value)}
          >
            <option value="all">全部</option>
            <option value="enabled">启用中</option>
            <option value="disabled">已禁用</option>
          </NativeSelect>
        </div>
      </div>
      {query.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : query.isError ? (
        <ErrorNotice error={query.error} />
      ) : rows.length === 0 ? (
        <EmptyState icon={GitBranch} title="没有匹配的仓库" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>名称</TableHead>
              <TableHead>云效 ID</TableHead>
              <TableHead>分支</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>接入者</TableHead>
              <TableHead>同步凭证</TableHead>
              <TableHead>commit</TableHead>
              <TableHead>索引时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((repo) => {
              const disabled = repo.status === 'disabled';
              return (
                <TableRow key={repo.repo_id}>
                  <TableCell>
                    <Link
                      to={`/repositories/${repo.repo_id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {repo.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{repo.codeup_id}</TableCell>
                  <TableCell className="font-mono text-xs">{repo.branch}</TableCell>
                  <TableCell>
                    <RepositoryStatusBadge status={repo.status} />
                  </TableCell>
                  <TableCell className="text-xs">{repo.owner}</TableCell>
                  <TableCell className="text-xs">{repo.sync_owner}</TableCell>
                  <TableCell className="font-mono text-xs">{shortSha(repo.indexed_commit)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <RelativeTime value={repo.indexed_at} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {disabled ? (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={lifecycle.isPending && lifecycle.variables?.id === repo.repo_id}
                            onClick={() => enable(repo)}
                          >
                            启用
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-status-error hover:text-status-error"
                            onClick={() => setPending({ action: 'delete', repo })}
                          >
                            删除
                          </Button>
                        </>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => setPending({ action: 'disable', repo })}>
                          禁用
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={pending?.action === 'disable'}
        onOpenChange={(open) => !open && setPending(null)}
        title={`禁用仓库 ${pending?.repo.name ?? ''}`}
        description="禁用后所有 Key 都无法查询该仓库，自动同步停止；已有索引保留，可随时重新启用。"
        confirmLabel="禁用"
        loading={lifecycle.isPending}
        onConfirm={() =>
          pending &&
          lifecycle.mutate(
            { id: pending.repo.repo_id, action: 'disable' },
            {
              onSuccess: () => {
                toast.success('仓库已禁用');
                setPending(null);
              },
              onError: (error) => toastError(error, '禁用失败'),
            },
          )
        }
      />
      <ConfirmDialog
        open={pending?.action === 'delete'}
        onOpenChange={(open) => !open && setPending(null)}
        title={`删除仓库 ${pending?.repo.name ?? ''}`}
        description="删除会移除平台记录、索引与 Webhook 配置，不可恢复；云效上的仓库不受影响。"
        confirmLabel="永久删除"
        typedPhrase={pending?.repo.name}
        loading={remove.isPending}
        onConfirm={() =>
          pending &&
          remove.mutate(pending.repo.repo_id, {
            onSuccess: () => {
              toast.success('仓库已删除');
              setPending(null);
            },
            onError: (error) => toastError(error, '删除失败'),
          })
        }
      />
    </>
  );
}
