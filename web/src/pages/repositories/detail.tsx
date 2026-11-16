import { ArrowsClockwise, CaretRight, Prohibit, ShieldCheck, Trash } from '@phosphor-icons/react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import {
  useAuthorizeSyncCredential,
  useDeleteRepository,
  useRepository,
  useRepositoryJobs,
  useRepositoryLifecycle,
} from '@/api/hooks';
import type { Repository } from '@/api/types';
import { useAbility } from '@/auth/session';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CopyButton } from '@/components/copy-button';
import { ErrorNotice } from '@/components/error-notice';
import { PageHeader } from '@/components/page-header';
import { RelativeTime } from '@/components/relative-time';
import { JobStatusBadge, jobReasonLabel, RepositoryStatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { describeRepositoryError } from '@/lib/errors';
import { formatAbsolute, formatDuration } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { SyncButton } from './list';

function Definition({ term, children, mono }: { term: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className={mono ? 'break-all font-mono text-sm' : 'text-sm'}>{children}</dd>
    </div>
  );
}

function AdminActions({ repo }: { repo: Repository }) {
  const lifecycle = useRepositoryLifecycle();
  const remove = useDeleteRepository();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState<'disable' | 'delete' | null>(null);
  const disabled = repo.status === 'disabled';
  return (
    <>
      {disabled ? (
        <Button
          variant="secondary"
          size="sm"
          loading={lifecycle.isPending}
          onClick={() =>
            lifecycle.mutate(
              { id: repo.repo_id, action: 'enable' },
              {
                onSuccess: () => toast.success('仓库已启用并加入同步队列'),
                onError: (error) => toastError(error, '启用失败'),
              },
            )
          }
        >
          <ShieldCheck aria-hidden="true" />
          启用
        </Button>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setConfirm('disable')}>
          <Prohibit aria-hidden="true" />
          禁用
        </Button>
      )}
      <Button
        variant="destructive"
        size="sm"
        disabled={!disabled}
        title={disabled ? undefined : '仅已禁用的仓库可删除'}
        onClick={() => setConfirm('delete')}
      >
        <Trash aria-hidden="true" />
        删除
      </Button>
      <ConfirmDialog
        open={confirm === 'disable'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`禁用仓库 ${repo.name}`}
        description="禁用后所有 Key 都无法查询该仓库，自动同步停止；已有索引保留，可随时重新启用。"
        confirmLabel="禁用"
        loading={lifecycle.isPending}
        onConfirm={() =>
          lifecycle.mutate(
            { id: repo.repo_id, action: 'disable' },
            {
              onSuccess: () => {
                toast.success('仓库已禁用');
                setConfirm(null);
              },
              onError: (error) => toastError(error, '禁用失败'),
            },
          )
        }
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`删除仓库 ${repo.name}`}
        description="删除会移除平台记录、索引与 Webhook 配置，不可恢复；云效上的仓库不受影响。"
        confirmLabel="永久删除"
        typedPhrase={repo.name}
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(repo.repo_id, {
            onSuccess: () => {
              toast.success('仓库已删除');
              navigate('/admin/repositories', { replace: true });
            },
            onError: (error) => toastError(error, '删除失败'),
          })
        }
      />
    </>
  );
}

function JobHistory({ repoId }: { repoId: string }) {
  const jobs = useRepositoryJobs(repoId);
  if (jobs.isPending) return <Skeleton className="h-32 w-full" />;
  if (jobs.isError) return <ErrorNotice error={jobs.error} title="任务历史加载失败" />;
  if (jobs.data.length === 0) return <p className="text-sm text-muted-foreground">还没有索引任务。</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>原因</TableHead>
          <TableHead className="w-28">状态</TableHead>
          <TableHead>创建</TableHead>
          <TableHead>完成</TableHead>
          <TableHead>构建耗时</TableHead>
          <TableHead>错误</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.data.map((job) => (
          <TableRow key={job.id}>
            <TableCell>
              {jobReasonLabel(job.reason)}
              <span className="ml-2 font-mono text-xs text-muted-foreground" title={job.id}>
                {job.id.slice(0, 8)}
              </span>
            </TableCell>
            <TableCell>
              <JobStatusBadge status={job.status} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              <RelativeTime value={job.created_at} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              <RelativeTime value={job.finished_at} />
            </TableCell>
            <TableCell className="tabular">{formatDuration(job.build_duration_ms)}</TableCell>
            <TableCell className="font-mono text-xs text-status-error">{job.error ?? ''}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function RepositoryDetailPage() {
  const { id = '' } = useParams();
  const { me, canWrite, isAdmin } = useAbility();
  const query = useRepository(id);
  const authorize = useAuthorizeSyncCredential();

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (query.isError) return <ErrorNotice error={query.error} title="仓库加载失败" />;
  const repo = query.data;
  const explanation = describeRepositoryError(repo.error);
  const webhookUrl = `${window.location.origin}${repo.webhook_path}`;

  return (
    <>
      <nav aria-label="面包屑" className="mb-3 flex items-center gap-1 text-sm text-muted-foreground">
        <Link to="/repositories" className="hover:text-foreground">
          仓库
        </Link>
        <CaretRight className="size-3.5" aria-hidden="true" />
        <span className="text-foreground">{repo.name}</span>
      </nav>
      <PageHeader
        title={repo.name}
        actions={
          <>
            {canWrite ? <SyncButton repo={repo} size="md" /> : null}
            {isAdmin ? <AdminActions repo={repo} /> : null}
          </>
        }
      />

      {repo.status === 'credential_required' ? (
        <Alert tone="warning" title="需要重新授权自动同步" className="mb-4">
          <p>{explanation}</p>
          {canWrite ? (
            <div className="mt-2">
              <Button
                size="sm"
                loading={authorize.isPending}
                onClick={() =>
                  authorize.mutate(repo.repo_id, {
                    onSuccess: () => toast.success('已重新授权并加入同步队列'),
                    onError: (error) => toastError(error, '授权失败'),
                  })
                }
              >
                <ArrowsClockwise aria-hidden="true" />
                用我当前的 PAT 重新授权
              </Button>
              <p className="mt-1 text-xs">
                仅仓库接入者或当前同步凭证持有人（{me?.username}）可以执行；其他人会收到「资源不存在」。
              </p>
            </div>
          ) : null}
        </Alert>
      ) : repo.error && repo.status !== 'disabled' ? (
        <Alert tone={repo.status === 'failed' ? 'error' : 'warning'} className="mb-4">
          {explanation}
        </Alert>
      ) : null}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>索引状态</CardTitle>
          <div className="flex items-center gap-1.5">
            <RepositoryStatusBadge status={repo.status} />
            {repo.stale && repo.indexed_commit && repo.status !== 'ready' ? (
              <Badge tone="warning">提供旧索引</Badge>
            ) : null}
          </div>
        </CardHeader>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <Definition term="CodeHarbor 仓库 ID" mono>
            {repo.repo_id}
          </Definition>
          <Definition term="云效仓库 ID" mono>
            {repo.codeup_id}
          </Definition>
          <Definition term="分支" mono>
            {repo.branch}
          </Definition>
          <Definition term="索引 commit" mono>
            {repo.indexed_commit ?? '—'}
          </Definition>
          <Definition term="索引时间">{repo.indexed_at ? formatAbsolute(repo.indexed_at) : '—'}</Definition>
          <Definition term="错误码" mono>
            {repo.error ?? '—'}
          </Definition>
        </dl>
        <div className="mt-4 flex flex-col gap-1.5 border-t border-border pt-4">
          <span className="text-xs text-muted-foreground">Codeup Webhook 地址（Secret Token 仅在接入时显示一次）</span>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-2 py-1 text-xs">{webhookUrl}</code>
            <CopyButton value={webhookUrl} />
          </div>
        </div>
      </Card>

      <section>
        <h2 className="mb-3 text-lg font-semibold">任务历史</h2>
        <JobHistory repoId={repo.repo_id} />
      </section>
    </>
  );
}
