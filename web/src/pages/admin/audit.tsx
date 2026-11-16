import { ClipboardText } from '@phosphor-icons/react';
import { useState } from 'react';
import { type AuditFilter, useAdminAudit } from '@/api/hooks';
import type { AuditEvent } from '@/api/types';
import { EmptyState } from '@/components/empty-state';
import { ErrorNotice } from '@/components/error-notice';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatAbsolute } from '@/lib/format';

const WINDOWS = [
  { label: '最近 1 小时', ms: 3_600_000 },
  { label: '最近 24 小时', ms: 86_400_000 },
  { label: '最近 7 天', ms: 7 * 86_400_000 },
  { label: '最近 30 天', ms: 30 * 86_400_000 },
  { label: '不限', ms: 0 },
] as const;

function StatusBadge({ status }: { status: number }) {
  const tone = status >= 500 ? 'error' : status >= 400 ? 'warning' : 'ready';
  return (
    <Badge tone={tone} className="tabular">
      {status}
    </Badge>
  );
}

function AuditRow({ event }: { event: AuditEvent }) {
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-xs tabular">{formatAbsolute(event.at)}</TableCell>
      <TableCell className="font-mono text-xs">{event.method}</TableCell>
      <TableCell className="font-mono text-xs" title={event.request_id}>
        {event.route}
      </TableCell>
      <TableCell>
        <StatusBadge status={event.status} />
      </TableCell>
      <TableCell className="text-xs">{event.authentication ?? ''}</TableCell>
      <TableCell className="font-mono text-xs">{event.subject ?? ''}</TableCell>
      <TableCell className="font-mono text-xs">{event.key_prefix ?? ''}</TableCell>
      <TableCell className="font-mono text-xs" title={event.repo_id ?? undefined}>
        {event.repo_id ? event.repo_id.slice(0, 8) : ''}
      </TableCell>
      <TableCell className="text-xs">
        {event.tool ? (
          <span className="inline-flex items-center gap-1">
            <code>{event.tool}</code>
            {event.tool_outcome ? (
              <Badge tone={event.tool_outcome === 'success' ? 'ready' : 'error'}>{event.tool_outcome}</Badge>
            ) : null}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="font-mono text-xs" title={event.query_hash ?? undefined}>
        {event.query_hash ? event.query_hash.slice(0, 12) : ''}
      </TableCell>
    </TableRow>
  );
}

export default function AdminAuditPage() {
  const [draft, setDraft] = useState({ subject: '', repo_id: '', window: 86_400_000, limit: 100 });
  const [filter, setFilter] = useState<AuditFilter>({ since: Date.now() - 86_400_000, limit: 100 });
  const audit = useAdminAudit(filter);

  return (
    <>
      <PageHeader title="审计" description="HTTP 与 MCP 调用的审计事件。代码查询只记录 SHA-256 摘要，不记录内容。" />
      <form
        className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_160px_120px_auto] lg:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter({
            subject: draft.subject.trim() || undefined,
            repo_id: draft.repo_id.trim() || undefined,
            since: draft.window ? Date.now() - draft.window : undefined,
            limit: draft.limit,
          });
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-subject">主体（用户 ID）</Label>
          <Input
            id="audit-subject"
            className="font-mono"
            autoComplete="off"
            value={draft.subject}
            onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-repo">仓库 ID</Label>
          <Input
            id="audit-repo"
            className="font-mono"
            autoComplete="off"
            value={draft.repo_id}
            onChange={(event) => setDraft({ ...draft, repo_id: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-window">时间范围</Label>
          <NativeSelect
            id="audit-window"
            value={draft.window}
            onChange={(event) => setDraft({ ...draft, window: Number(event.target.value) })}
          >
            {WINDOWS.map((window) => (
              <option key={window.label} value={window.ms}>
                {window.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-limit">条数</Label>
          <NativeSelect
            id="audit-limit"
            value={draft.limit}
            onChange={(event) => setDraft({ ...draft, limit: Number(event.target.value) })}
          >
            {[100, 250, 500, 1000].map((limit) => (
              <option key={limit} value={limit}>
                {limit}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="secondary" loading={audit.isFetching}>
          查询
        </Button>
      </form>
      {audit.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : audit.isError ? (
        <ErrorNotice error={audit.error} />
      ) : audit.data.length === 0 ? (
        <EmptyState icon={ClipboardText} title="没有匹配的审计事件" />
      ) : (
        <>
          <p className="mb-2 text-xs text-muted-foreground" aria-live="polite">
            {audit.data.length} 条{audit.data.length >= filter.limit ? '（已达条数上限，请缩小范围）' : ''}
          </p>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>时间</TableHead>
                <TableHead>方法</TableHead>
                <TableHead>路由</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>认证</TableHead>
                <TableHead>主体</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>仓库</TableHead>
                <TableHead>工具</TableHead>
                <TableHead>摘要</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {audit.data.map((event) => (
                <AuditRow key={event.id} event={event} />
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </>
  );
}
