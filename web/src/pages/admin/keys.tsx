import { Key as KeyIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { useAdminKeys, useAdminRevokeKey } from '@/api/hooks';
import type { AdminKeyInfo } from '@/api/types';
import { useAbility, useSession } from '@/auth/session';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { ErrorNotice } from '@/components/error-notice';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatExpiry } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { KeyScopeCell } from '../keys';

export default function AdminKeysPage() {
  const { me } = useAbility();
  const { signOut } = useSession();
  const [params, setParams] = useSearchParams();
  const owner = params.get('owner') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const [draft, setDraft] = useState(owner);
  const keys = useAdminKeys(owner || undefined, page);
  const revoke = useAdminRevokeKey();
  const [target, setTarget] = useState<AdminKeyInfo | null>(null);

  const apply = (next: { owner?: string; page?: number }) => {
    const search = new URLSearchParams();
    const nextOwner = next.owner ?? owner;
    const nextPage = next.page ?? 1;
    if (nextOwner) search.set('owner', nextOwner);
    if (nextPage > 1) search.set('page', String(nextPage));
    setParams(search);
  };

  return (
    <>
      <PageHeader title="全平台 Key" description="按持有人筛选；每页 100 条。撤销管理员自身 Key 需格外谨慎。" />
      <form
        className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          apply({ owner: draft.trim(), page: 1 });
        }}
      >
        <div className="flex flex-1 flex-col gap-1.5 sm:max-w-sm">
          <Label htmlFor="owner">持有人用户 ID</Label>
          <Input
            id="owner"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="font-mono"
            autoComplete="off"
          />
        </div>
        <Button type="submit" variant="secondary">
          筛选
        </Button>
        {owner ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft('');
              apply({ owner: '', page: 1 });
            }}
          >
            清除
          </Button>
        ) : null}
      </form>
      {keys.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : keys.isError ? (
        <ErrorNotice error={keys.error} />
      ) : keys.data.keys.length === 0 ? (
        <EmptyState icon={KeyIcon} title="没有匹配的 Key" />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>前缀</TableHead>
                <TableHead>持有人</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>范围</TableHead>
                <TableHead>有效期</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.data.keys.map((info) => (
                <TableRow key={info.prefix}>
                  <TableCell className="font-mono text-xs">
                    {info.prefix}
                    {info.prefix === me?.key_prefix ? (
                      <Badge tone="progress" className="ml-2">
                        当前登录
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{info.owner}</TableCell>
                  <TableCell>
                    <Badge tone={info.scope === 'write' ? 'accent' : 'neutral'}>{info.scope}</Badge>
                  </TableCell>
                  <TableCell>
                    <KeyScopeCell info={info} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatExpiry(info.expires_at)}</TableCell>
                  <TableCell>
                    {info.revoked ? <Badge tone="error">已撤销</Badge> : <Badge tone="ready">有效</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    {!info.revoked ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-status-error hover:text-status-error"
                        onClick={() => setTarget(info)}
                      >
                        撤销
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>第 {page} 页</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => apply({ page: page - 1 })}>
                上一页
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={keys.data.next_page === null}
                onClick={() => apply({ page: keys.data.next_page ?? page })}
              >
                下一页
              </Button>
            </div>
          </div>
        </>
      )}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={`撤销 Key ${target?.prefix ?? ''}`}
        description={
          target?.prefix === me?.key_prefix
            ? '这是你当前登录使用的 Key，撤销后将立即退出控制台。'
            : `持有人 ${target?.owner ?? ''}。撤销后使用该 Key 的所有客户端立即失去访问权限，不可恢复。`
        }
        confirmLabel="撤销"
        loading={revoke.isPending}
        onConfirm={() =>
          target &&
          revoke.mutate(target.prefix, {
            onSuccess: () => {
              const isCurrent = target.prefix === me?.key_prefix;
              setTarget(null);
              if (isCurrent) {
                signOut('manual');
                return;
              }
              toast.success('Key 已撤销', { description: target.prefix });
            },
            onError: (error) => {
              if (error instanceof ApiError && error.status === 409) {
                toast.error('前缀冲突', {
                  description: '存在多个相同前缀的 Key，请使用 CLI 按完整哈希处理。',
                  duration: Number.POSITIVE_INFINITY,
                  closeButton: true,
                });
                return;
              }
              toastError(error, '撤销失败');
            },
          })
        }
      />
    </>
  );
}
