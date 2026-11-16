import { UsersThree } from '@phosphor-icons/react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useAdminRevokeUserKeys, useAdminUsers } from '@/api/hooks';
import type { UserSummary } from '@/api/types';
import { useAbility } from '@/auth/session';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { ErrorNotice } from '@/components/error-notice';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toastError } from '@/lib/toast';

export default function AdminUsersPage() {
  const { me } = useAbility();
  const users = useAdminUsers();
  const revoke = useAdminRevokeUserKeys();
  const [target, setTarget] = useState<UserSummary | null>(null);

  return (
    <>
      <PageHeader title="用户" description="已绑定云效 PAT 的用户。credential_version 随每次重新绑定递增。" />
      {users.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : users.isError ? (
        <ErrorNotice error={users.error} />
      ) : users.data.length === 0 ? (
        <EmptyState icon={UsersThree} title="还没有用户绑定" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>用户 ID</TableHead>
              <TableHead>用户名</TableHead>
              <TableHead>凭证版本</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.data.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-mono text-xs">
                  {user.id}
                  {user.id === me?.id ? (
                    <Badge tone="progress" className="ml-2">
                      本人
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>{user.username}</TableCell>
                <TableCell className="tabular">{user.credential_version}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button asChild variant="ghost" size="sm">
                      <Link to={`/admin/keys?owner=${encodeURIComponent(user.id)}`}>查看 Key</Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-status-error hover:text-status-error"
                      onClick={() => setTarget(user)}
                    >
                      撤销全部 Key
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={`撤销 ${target?.username ?? ''} 的全部 Key`}
        description={
          target?.id === me?.id
            ? '这会撤销包括你当前登录 Key 在内的全部 Key，你将立即退出控制台。'
            : '该用户的所有 Key（包括其签发的下级 Key）立即失效，MCP 客户端随即断开；用户需重新绑定并申请 Key。'
        }
        confirmLabel="撤销全部 Key"
        typedPhrase={target?.id}
        loading={revoke.isPending}
        onConfirm={() =>
          target &&
          revoke.mutate(target.id, {
            onSuccess: () => {
              toast.success('已撤销该用户的全部 Key', { description: target.username });
              setTarget(null);
            },
            onError: (error) => toastError(error, '撤销失败'),
          })
        }
      />
    </>
  );
}
