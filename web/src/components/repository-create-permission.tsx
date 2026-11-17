import { useAbility } from '@/auth/session';
import { Alert } from '@/components/ui/alert';

export function RepositoryCreatePermission() {
  const { me, canWrite, isAdmin, isUnrestricted } = useAbility();
  if (isAdmin) return null;

  const hasWriteKey = me?.key_scope === 'write';

  return (
    <Alert tone="warning" title="当前 Key 无法接入仓库" className="mb-4">
      <p>接入仓库需要平台管理 Key，以下条件必须同时满足：</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          write 类型 Key：
          {hasWriteKey ? '已满足。' : `未满足，当前为 ${me?.key_scope ?? '未知'} 类型；请更换 write Key。`}
        </li>
        <li>
          Key 所属用户在 CODEHARBOR_WRITE_USERS 白名单中：
          {canWrite
            ? '已满足。'
            : hasWriteKey
              ? '未满足，请联系平台管理员添加。'
              : '待确认，当前 Key 无法判断白名单状态；请联系平台管理员确认。'}
        </li>
        <li>
          Key 不限定仓库范围（key_repos = null）：
          {isUnrestricted ? '已满足。' : '未满足，请更换不限定仓库范围的 Key。'}
        </li>
      </ul>
      <p className="mt-2 break-all">联系管理员时请提供你的云效用户 ID：{me?.id ?? '未知'}。</p>
    </Alert>
  );
}
