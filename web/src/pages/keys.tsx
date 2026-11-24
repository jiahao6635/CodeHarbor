import { Key as KeyIcon, Plus, Trash } from '@phosphor-icons/react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useCreateKey, useKeys, useRepositories, useRevokeKey } from '@/api/hooks';
import type { CreatedKey, KeyInfo, Scope } from '@/api/types';
import { useAbility } from '@/auth/session';
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
import { DEFAULT_EXPIRES_IN, EXPIRY_OPTIONS, parseExpiry, UNLIMITED_EXPIRY_HELP } from '@/lib/validation';

export function KeyScopeCell({ info }: { info: Pick<KeyInfo, 'scope' | 'repos'> }) {
  if (info.repos === null) {
    return <Badge tone="neutral">旧版未限定</Badge>;
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
  const repositories = useRepositories(true);
  const create = useCreateKey();
  const [scope, setScope] = useState<Scope>('read');
  const [selected, setSelected] = useState<string[]>([]);
  const [expiresIn, setExpiresIn] = useState<number | null>(DEFAULT_EXPIRES_IN);
  const [error, setError] = useState<string | null>(null);
  const scopeId = useId();
  const expiryId = useId();

  const expiryHelp = expiresIn === null ? UNLIMITED_EXPIRY_HELP : undefined;
  const selectable = (repositories.data ?? []).filter((repo) => scope === 'read' || repo.can_manage);
  const selectedRepos = selected.filter((id) => selectable.some((repo) => repo.repo_id === id));

  const submit = () => {
    setError(null);
    if (selectedRepos.length === 0) {
      setError('请至少选择一个仓库。');
      return;
    }
    create.mutate(
      { scope, repos: selectedRepos, expires_in: expiresIn },
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
          <DialogTitle>创建 API Key</DialogTitle>
          <DialogDescription>Key 只能访问选中的仓库，实际权限随你的云效权限变化。</DialogDescription>
        </DialogHeader>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id={scopeId} label="类型">
          <NativeSelect
            id={scopeId}
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as Scope);
              setSelected([]);
            }}
          >
            <option value="read">read（限定仓库，供 CI / 机器人查询代码）</option>
            <option value="write">write（查询和触发有权维护的仓库同步）</option>
          </NativeSelect>
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">仓库范围（最多 100 个）</legend>
          {repositories.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : repositories.isError ? (
            <ErrorNotice error={repositories.error} title="仓库列表加载失败" />
          ) : selectable.length === 0 ? (
            <p className="text-sm text-muted-foreground">当前没有可选择的仓库。</p>
          ) : (
            <ul className="max-h-56 overflow-y-auto rounded-sm border border-border">
              {selectable.map((repo) => {
                const id = `repo-${repo.repo_id}`;
                const checked = selectedRepos.includes(repo.repo_id);
                return (
                  <li
                    key={repo.repo_id}
                    className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-0"
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      disabled={!checked && selectedRepos.length >= 100}
                      onCheckedChange={(value) =>
                        setSelected((current) =>
                          value === true ? [...current, repo.repo_id] : current.filter((item) => item !== repo.repo_id),
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
        <Field id={expiryId} label="有效期" helper={expiryHelp}>
          <NativeSelect
            id={expiryId}
            value={String(expiresIn)}
            onChange={(event) => setExpiresIn(parseExpiry(event.target.value))}
            aria-describedby={describedBy(expiryId, { helper: Boolean(expiryHelp) })}
          >
            {EXPIRY_OPTIONS.map((option) => (
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
          <Button onClick={submit} loading={create.isPending} disabled={selectedRepos.length === 0}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function KeyStatus({ info }: { info: KeyInfo }) {
  if (info.revoked) return <Badge tone="error">已撤销</Badge>;
  if (info.expires_at !== null && info.expires_at <= Date.now()) return <Badge tone="pending">已过期</Badge>;
  if (info.legacy_pending) return <Badge tone="warning">待审核</Badge>;
  return <Badge tone="ready">有效</Badge>;
}

function KeyRow({ info, onRevoke }: { info: KeyInfo; onRevoke: (info: KeyInfo) => void }) {
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{info.prefix}</TableCell>
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
  const { hasPat } = useAbility();
  const keys = useKeys();
  const revoke = useRevokeKey();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [revoking, setRevoking] = useState<KeyInfo | null>(null);

  const confirmRevoke = () => {
    if (!revoking) return;
    revoke.mutate(revoking.prefix, {
      onSuccess: () => {
        setRevoking(null);
        toast.success('Key 已撤销', { description: revoking.prefix });
      },
      onError: (error) => toastError(error, '撤销失败'),
    });
  };

  return (
    <>
      <PageHeader
        title="Key"
        description="你名下的 CodeHarbor API Key，可用于 Agent 和 CI。"
        actions={
          hasPat ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden="true" />
              创建 API Key
            </Button>
          ) : (
            <Button asChild variant="secondary">
              <Link to="/onboarding">绑定云效 PAT</Link>
            </Button>
          )
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
              <KeyRow key={info.prefix} info={info} onRevoke={setRevoking} />
            ))}
          </TableBody>
        </Table>
      )}

      {createOpen ? <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={setCreated} /> : null}
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
        description="撤销后，使用此 Key 的客户端会立即失去访问权限。"
        confirmLabel="撤销"
        loading={revoke.isPending}
        onConfirm={confirmRevoke}
      />
    </>
  );
}
