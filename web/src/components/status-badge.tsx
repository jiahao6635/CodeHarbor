import { CheckCircle, CircleNotch, Clock, Prohibit, Warning, XCircle } from '@phosphor-icons/react';
import type { JobStatus, RepositoryStatus } from '@/api/types';
import { Badge } from '@/components/ui/badge';

type Tone = 'ready' | 'progress' | 'pending' | 'warning' | 'error';

const REPOSITORY: Record<string, { tone: Tone; label: string }> = {
  ready: { tone: 'ready', label: '索引可用' },
  pending: { tone: 'pending', label: '等待首次构建' },
  indexing: { tone: 'progress', label: '构建中' },
  updating: { tone: 'progress', label: '更新中' },
  credential_required: { tone: 'warning', label: '需重新授权' },
  branch_deleted: { tone: 'warning', label: '分支已删除' },
  failed: { tone: 'error', label: '构建失败' },
  disabled: { tone: 'pending', label: '已禁用' },
};

const JOB: Record<JobStatus, { tone: Tone; label: string }> = {
  queued: { tone: 'pending', label: '排队中' },
  running: { tone: 'progress', label: '执行中' },
  succeeded: { tone: 'ready', label: '成功' },
  failed: { tone: 'error', label: '失败' },
};

function Icon({ tone, status }: { tone: Tone; status: string }) {
  if (status === 'disabled') return <Prohibit aria-hidden="true" />;
  if (tone === 'ready') return <CheckCircle aria-hidden="true" weight="fill" />;
  if (tone === 'progress')
    return <CircleNotch aria-hidden="true" className="animate-spin motion-reduce:animate-none" />;
  if (tone === 'pending') return <Clock aria-hidden="true" />;
  if (tone === 'warning') return <Warning aria-hidden="true" weight="fill" />;
  return <XCircle aria-hidden="true" weight="fill" />;
}

export function repositoryStatusLabel(status: RepositoryStatus): string {
  return REPOSITORY[status]?.label ?? status;
}

export function RepositoryStatusBadge({ status }: { status: RepositoryStatus }) {
  const meta = REPOSITORY[status] ?? { tone: 'pending' as Tone, label: status };
  return (
    <Badge tone={meta.tone}>
      <Icon tone={meta.tone} status={status} />
      {meta.label}
    </Badge>
  );
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const meta = JOB[status];
  return (
    <Badge tone={meta.tone}>
      <Icon tone={meta.tone} status={status} />
      {meta.label}
    </Badge>
  );
}

export const JOB_REASONS: Record<string, string> = {
  initial: '首次接入',
  manual: '手动同步',
  webhook: 'Webhook 推送',
  credential_changed: '重新授权凭证',
  reconcile: '定期对账',
};

export const jobReasonLabel = (reason: string) => JOB_REASONS[reason] ?? reason;
