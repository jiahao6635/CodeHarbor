import { UsersThree } from '@phosphor-icons/react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useAdminRevokeUserKeys, useAdminUsers, useUpdateAccount } from '@/api/hooks';
import type { AccountRole, AccountStatus, UserSummary } from '@/api/types';
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

type AccountAction =
  | { kind: 'role'; role: AccountRole; title: string }
  | { kind: 'status'; status: AccountStatus; title: string }
  | { kind: 'keys'; title: string };

export default function AdminUsersPage() {
  const { me } = useAbility();
  const users = useAdminUsers();
  const revoke = useAdminRevokeUserKeys();
  const update = useUpdateAccount();
  const [target, setTarget] = useState<{ user: UserSummary; action: AccountAction } | null>(null);

  const suspending = target?.action.kind === 'status' && target.action.status === 'disabled';

  const submit = () => {
    if (!target) return;
    const { user, action } = target;
    const handlers = {
      onSuccess: () => {
        toast.success('已更新', { description: user.username });
        setTarget(null);
      },
      onError: (error: Error) => toastError(error, '更新失败'),
    };
    if (action.kind === 'keys') revoke.mutate(user.id, handlers);
    else
      update.mutate(
        { id: user.id, patch: action.kind === 'role' ? { role: action.role } : { status: action.status } },
        handlers,
      );
  };

  return (
    <>
      <PageHeader title="用户" description="管理飞书账号角色、使用状态和已签发的 API Key。" />
      {users.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : users.isError ? (
        <ErrorNotice error={users.error} />
      ) : users.data.length === 0 ? (
        <EmptyState icon={UsersThree} title="暂无用户" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>飞书用户</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>云效账号</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.data.map((user) => {
              const promote = user.role === 'member';
              const enable = user.status === 'disabled';
              return (
                <TableRow key={user.id}>
                  <TableCell>
                    {user.username}
                    {user.id === me?.id ? (
                      <Badge tone="progress" className="ml-2">
                        本人
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>{promote ? '成员' : '超级管理员'}</TableCell>
                  <TableCell>
                    <Badge tone={enable ? 'error' : 'ready'}>{enable ? '已停用' : '启用'}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{user.codeup_user_id ?? '未绑定'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setTarget({
                            user,
                            action: {
                              kind: 'role',
                              role: promote ? 'super_admin' : 'member',
                              title: promote ? '设为超级管理员' : '改为普通成员',
                            },
                          })
                        }
                      >
                        {promote ? '设为超级管理员' : '改为普通成员'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setTarget({
                            user,
                            action: {
                              kind: 'status',
                              status: enable ? 'active' : 'disabled',
                              title: enable ? '启用账号' : '停用账号',
                            },
                          })
                        }
                      >
                        {enable ? '启用' : '停用'}
                      </Button>
                      {user.codeup_user_id ? (
                        <>
                          <Button asChild variant="ghost" size="sm">
                            <Link to={`/admin/keys?owner=${encodeURIComponent(user.codeup_user_id)}`}>查看 Key</Link>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setTarget({ user, action: { kind: 'keys', title: '撤销全部 Key' } })}
                          >
                            撤销全部 Key
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={target?.action.title ?? ''}
        description={
          suspending
            ? `停用 ${target?.user.username ?? ''} 会结束其会话、撤销全部 Key，并暂停由其 PAT 授权的自动同步。`
            : `用户 ${target?.user.username ?? ''}`
        }
        destructive={suspending || target?.action.kind === 'keys'}
        confirmLabel="确认"
        loading={revoke.isPending || update.isPending}
        onConfirm={submit}
      />
    </>
  );
}
