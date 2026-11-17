import { Key as KeyIcon, Plus, Trash } from '@phosphor-icons/react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { useCreateKey, useKeys, useRepositories, useRevokeKey } from '@/api/hooks';
import type { CreatedKey, KeyInfo, Scope } from '@/api/types';
import { useAbility, useSession } from '@/auth/session';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { ErrorNotice } from '@/components/error-notice';
import { PageHeader } from '@/components/page-header';
import { SecretReveal } from '@/components/secret-reveal';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { NativeSelect } from '@/components/ui/input';
import { describedBy, Field, Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatAbsolute, formatExpiry } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { childExpiryOptions, parseExpiry, resolveChildExpiry, UNLIMITED_EXPIRY_HELP } from '@/lib/validation';

export function KeyScopeCell({ info }: { info: Pick<KeyInfo, 'scope' | 'repos'> }) {
  if (info.repos === null) {
    return info.scope === 'write' ? <Badge tone="accent">平台管理</Badge> : <Badge tone="neutral">跟随云效权限</Badge>;
  }
  return (
    <span className="text-xs text-muted-foreground" title={info.repos.join('\n')}>
      限定 {info.repos.length} 个仓库
    </span>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: CreatedKey) => void;
}) {
  const { me } = useAbility();
  const repositories = useRepositories();
  const create = useCreateKey();
  const [scope, setScope] = useState<Scope>('read');
  const [selected, setSelected] = useState<string[]>([]);
  const [chosenExpiry, setChosenExpiry] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const scopeId = useId();
  const expiryId = useId();

  const parentExpiry = me?.key_expires_at;
  const expiryOptions = childExpiryOptions(parentExpiry);
  // Default to the longest finite option; null is only used when explicitly selected.
  const expiresIn = resolveChildExpiry(expiryOptions, chosenExpiry);

  const submit = () => {
    setError(null);
    // Recheck at submission in case the parent's remaining lifetime has shrunk.
    if (expiresIn === undefined || !childExpiryOptions(parentExpiry).some((option) => option.seconds === expiresIn)) {
      setError('当前 Key 的剩余有效期不足，请重新选择或更换 Key。');
      return;
    }
    if (scope === 'read' && selected.length === 0) {
      setError('read Key 必须至少选择一个仓库。');
      return;
    }
    create.mutate(
      { scope, repos: scope === 'read' ? selected : null, expires_in: expiresIn },
      {
        onSuccess: (key) => {
          onOpenChange(false);
          setSelected([]);
          onCreated(key);
        },
        onError: (failure) => toastError(failure, '创建 Key 失败'),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>创建下级 Key</DialogTitle>
          <DialogDescription>
            下级 Key 的有效期不能超过当前 Key（{parentExpiry === null ? '永不过期' : formatAbsolute(parentExpiry)}
            ）。read Key 只能查询明确列出的仓库，不再核验云效权限，审计归属于你。
          </DialogDescription>
        </DialogHeader>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id={scopeId} label="类型">
          <NativeSelect id={scopeId} value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
            <option value="read">read（限定仓库，供 CI / 机器人查询代码）</option>
            <option value="write">write（平台管理，不能查询代码）</option>
          </NativeSelect>
        </Field>
        {scope === 'read' ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">仓库范围（最多 100 个）</legend>
            {repositories.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : repositories.isError ? (
              <ErrorNotice error={repositories.error} title="仓库列表加载失败" />
            ) : repositories.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">当前没有可选择的仓库。</p>
            ) : (
              <ul className="max-h-56 overflow-y-auto rounded-sm border border-border">
                {repositories.data.map((repo) => {
                  const id = `repo-${repo.repo_id}`;
                  const checked = selected.includes(repo.repo_id);
                  return (
                    <li
                      key={repo.repo_id}
                      className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-0"
                    >
                      <Checkbox
                        id={id}
                        checked={checked}
                        disabled={!checked && selected.length >= 100}
                        onCheckedChange={(value) =>
                          setSelected((current) =>
                            value === true
                              ? [...current, repo.repo_id]
                              : current.filter((item) => item !== repo.repo_id),
                          )
                        }
                      />
                      <Label
                        htmlFor={id}
                        className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 font-normal"
                      >
                        <span className="truncate">{repo.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">{repo.branch}</span>
                      </Label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
        ) : null}
        <Field id={expiryId} label="有效期" helper={expiresIn === null ? UNLIMITED_EXPIRY_HELP : undefined}>
          <NativeSelect
            id={expiryId}
            value={expiresIn === undefined ? '' : String(expiresIn)}
            onChange={(event) => setChosenExpiry(parseExpiry(event.target.value))}
            aria-describedby={describedBy(expiryId, { helper: expiresIn === null })}
          >
            {expiryOptions.map((option) => (
              <option key={String(option.seconds)} value={String(option.seconds)}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            取消
          </Button>
          <Button onClick={submit} loading={create.isPending} disabled={expiryOptions.length === 0}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KeyStatus({ info }: { info: KeyInfo }) {
  if (info.revoked) return <Badge tone="error">已撤销</Badge>;
  if (info.expires_at !== null && info.expires_at <= Date.now()) return <Badge tone="pending">已过期</Badge>;
  return <Badge tone="ready">有效</Badge>;
}

function KeyRow({ info, current, onRevoke }: { info: KeyInfo; current: boolean; onRevoke: (info: KeyInfo) => void }) {
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">
        {info.prefix}
        {current ? (
          <Badge tone="progress" className="ml-2">
            当前登录
          </Badge>
        ) : null}
      </TableCell>
      <TableCell>
        <Badge tone={info.scope === 'write' ? 'accent' : 'neutral'}>{info.scope}</Badge>
      </TableCell>
      <TableCell>
        <KeyScopeCell info={info} />
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{formatExpiry(info.expires_at)}</TableCell>
      <TableCell>
        <KeyStatus info={info} />
      </TableCell>
      <TableCell className="text-right">
        {!info.revoked ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-status-error hover:text-status-error"
            onClick={() => onRevoke(info)}
          >
            <Trash aria-hidden="true" />
            撤销
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

export default function KeysPage() {
  const { me, canWrite, isUnrestricted } = useAbility();
  const { signOut } = useSession();
  const keys = useKeys();
  const revoke = useRevokeKey();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [revoking, setRevoking] = useState<KeyInfo | null>(null);

  const confirmRevoke = () => {
    if (!revoking) return;
    const isCurrent = revoking.prefix === me?.key_prefix;
    revoke.mutate(revoking.prefix, {
      onSuccess: () => {
        setRevoking(null);
        if (isCurrent) {
          signOut('manual');
          return;
        }
        toast.success('Key 已撤销', { description: revoking.prefix });
      },
      onError: (error) => toastError(error, '撤销失败'),
    });
  };

  return (
    <>
      <PageHeader
        title="Key"
        description={
          isUnrestricted
            ? '你名下的全部 CodeHarbor Key。撤销后立即失效，无法恢复。'
            : '限定仓库范围的 Key 只能查看和撤销自身。'
        }
        actions={
          canWrite ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden="true" />
              创建下级 Key
            </Button>
          ) : null
        }
      />
      {keys.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : keys.isError ? (
        <ErrorNotice error={keys.error} />
      ) : keys.data.length === 0 ? (
        <EmptyState icon={KeyIcon} title="没有 Key" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>前缀</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>范围</TableHead>
              <TableHead>有效期</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.data.map((info) => (
              <KeyRow key={info.prefix} info={info} current={info.prefix === me?.key_prefix} onRevoke={setRevoking} />
            ))}
          </TableBody>
        </Table>
      )}

      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={setCreated} />
      <SecretReveal
        open={created !== null}
        title="新的 CodeHarbor Key"
        description={
          created
            ? `类型 ${created.scope}，前缀 ${created.prefix}，${created.expires_at === null ? '无限期（无截止日期）' : `到期 ${formatAbsolute(created.expires_at)}`}。`
            : ''
        }
        items={created ? [{ label: 'CodeHarbor Key', value: created.token }] : []}
        onClose={() => setCreated(null)}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`撤销 Key ${revoking?.prefix ?? ''}`}
        description={
          revoking?.prefix === me?.key_prefix
            ? '这是你当前登录使用的 Key。撤销后将立即退出控制台，且使用它的 MCP 客户端会同时失效。'
            : '撤销后使用该 Key 的所有客户端立即失去访问权限，此操作不可恢复。'
        }
        confirmLabel="撤销"
        loading={revoke.isPending}
        onConfirm={confirmRevoke}
      />
    </>
  );
}
