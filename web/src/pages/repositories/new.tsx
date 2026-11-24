import { zodResolver } from '@hookform/resolvers/zod';
import { CaretRight, MagnifyingGlass } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { ApiError } from '@/api/client';
import { useCodeupRepositories, useCreateRepository } from '@/api/hooks';
import type { CodeupRepository, CreatedRepository } from '@/api/types';
import { useAbility } from '@/auth/session';
import { CodeupBranchPicker } from '@/components/codeup-branch-picker';
import { ErrorNotice } from '@/components/error-notice';
import { IndexBuildProgress } from '@/components/index-build-progress';
import { PageHeader } from '@/components/page-header';
import { RepositoryCreatePermission } from '@/components/repository-create-permission';
import { SecretReveal } from '@/components/secret-reveal';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { describedBy, Field, Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/errors';
import { branchName, codeupRepositoryId } from '@/lib/validation';

const schema = z.object({
  codeup_repository_id: codeupRepositoryId,
  branch: branchName,
  authorize: z.literal(true, { error: '必须确认授权自动同步' }),
});
type FormValues = z.infer<typeof schema>;

function CodeupPicker({ selectedId, onSelect }: { selectedId: string; onSelect: (repo: CodeupRepository) => void }) {
  const [page, setPage] = useState(1);
  const [term, setTerm] = useState('');
  const query = useCodeupRepositories(page, true);
  const searchId = useId();
  const filtered = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return (query.data?.repositories ?? []).filter(
      (repo) => !needle || repo.name.toLowerCase().includes(needle) || repo.path.toLowerCase().includes(needle),
    );
  }, [query.data, term]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={searchId}>在当前页筛选</Label>
        <div className="relative">
          <MagnifyingGlass
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id={searchId}
            className="pl-9"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="名称或路径"
          />
        </div>
      </div>
      {query.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : query.isError ? (
        <ErrorNotice error={query.error} title="云效仓库列表加载失败" />
      ) : (
        <>
          <ul
            className="max-h-72 divide-y divide-border overflow-y-auto rounded-sm border border-border"
            aria-label="云效仓库"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">本页没有匹配的仓库</li>
            ) : (
              filtered.map((repo) => {
                const selected = repo.id === selectedId;
                return (
                  <li key={repo.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(repo)}
                      aria-pressed={selected}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors duration-150 hover:bg-muted',
                        selected && 'bg-muted',
                      )}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium">{repo.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{repo.path}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-mono">#{repo.id}</span>
                        {repo.access_level !== null ? <span>权限 {repo.access_level}</span> : null}
                        <CaretRight aria-hidden="true" />
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>第 {page} 页，每页最多 100 项</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
                上一页
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={query.data.next_page === null}
                onClick={() => setPage(query.data.next_page ?? page)}
              >
                下一页
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function RepositoryNewPage() {
  const { hasPat } = useAbility();

  return (
    <>
      <nav aria-label="面包屑" className="mb-3 flex items-center gap-1 text-sm text-muted-foreground">
        <Link to="/repositories" className="hover:text-foreground">
          仓库
        </Link>
        <CaretRight className="size-3.5" aria-hidden="true" />
        <span className="text-foreground">接入仓库</span>
      </nav>
      <PageHeader
        title="接入云效仓库"
        description="平台将用你当前绑定的 PAT 克隆并构建索引，之后按 Webhook、手动同步和定期对账更新。"
      />
      {hasPat ? (
        <RepositoryCreateForm />
      ) : (
        <>
          <RepositoryCreatePermission />
          <Button asChild variant="secondary">
            <Link to="/repositories">返回仓库列表</Link>
          </Button>
        </>
      )}
    </>
  );
}

function RepositoryCreateForm() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const create = useCreateRepository();
  const [created, setCreated] = useState<CreatedRepository | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ repoId: string; branch: string } | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { codeup_repository_id: '', branch: '', authorize: undefined as unknown as true },
  });
  const authorizeId = useId();

  const onSubmit = form.handleSubmit((values) => {
    setServerError(null);
    setConflict(null);
    create.mutate(
      { codeup_repository_id: values.codeup_repository_id, branch: values.branch },
      {
        onSuccess: (result) => {
          if ('webhook_token' in result) {
            setCreated(result);
            return;
          }
          toast.info('该仓库已接入', { description: result.repository.name });
          navigate(`/repositories/${result.repository.repo_id}`);
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'REPOSITORY_BRANCH_CONFLICT') {
            const repository = (error.data as { repository?: { repo_id?: string; branch?: string } })?.repository;
            if (repository?.repo_id && repository.branch) {
              setConflict({ repoId: repository.repo_id, branch: repository.branch });
              return;
            }
          }
          if (error instanceof ApiError && error.code === 'BRANCH_NOT_FOUND') {
            form.setValue('branch', '');
            void client.invalidateQueries({ queryKey: ['codeup-branches', values.codeup_repository_id] });
            form.setError('branch', { message: '该分支已不可用。请重新加载并选择分支。' });
            return;
          }
          if (error instanceof ApiError && error.status === 404) {
            setServerError('云效仓库不存在、你没有访问权限，或平台无法用你的 PAT 克隆该仓库。');
            return;
          }
          setServerError(error instanceof ApiError ? describeError(error.code) : '无法连接到服务。');
        },
      },
    );
  });

  const errors = form.formState.errors;
  const idValue = form.watch('codeup_repository_id');
  const selectedBranch = form.watch('branch');
  const validId = codeupRepositoryId.safeParse(idValue);

  const resetBranch = () => {
    form.setValue('branch', '');
    form.clearErrors('branch');
    setServerError(null);
    setConflict(null);
  };

  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
        <Card className="flex flex-col gap-4">
          <Tabs defaultValue="pick">
            <TabsList>
              <TabsTrigger value="pick">从云效列表选择</TabsTrigger>
              <TabsTrigger value="manual">输入仓库 ID</TabsTrigger>
            </TabsList>
            <TabsContent value="pick">
              <CodeupPicker
                selectedId={idValue}
                onSelect={(repo) => {
                  if (repo.id !== idValue) resetBranch();
                  form.setValue('codeup_repository_id', repo.id, { shouldValidate: true });
                  setSelectedName(repo.name);
                }}
              />
            </TabsContent>
            <TabsContent value="manual">
              <p className="text-sm text-muted-foreground">
                在云效仓库设置页可以找到数字 ID；接入前平台会校验你对该仓库的访问与克隆权限。
              </p>
            </TabsContent>
          </Tabs>
        </Card>

        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <Card className="flex flex-col gap-4">
            {serverError ? <Alert tone="error">{serverError}</Alert> : null}
            {conflict ? (
              <Alert tone="warning">
                此仓库已跟踪 {conflict.branch}。 <Link to={`/repositories/${conflict.repoId}`}>查看已有索引</Link>
              </Alert>
            ) : null}
            <Field
              id="codeup_repository_id"
              label="云效仓库 ID"
              helper={selectedName ? `已选择：${selectedName}` : undefined}
              error={errors.codeup_repository_id?.message}
            >
              <Input
                id="codeup_repository_id"
                inputMode="numeric"
                autoComplete="off"
                className="font-mono"
                aria-invalid={errors.codeup_repository_id ? true : undefined}
                aria-describedby={describedBy('codeup_repository_id', {
                  helper: !!selectedName,
                  error: !!errors.codeup_repository_id,
                })}
                {...form.register('codeup_repository_id', {
                  onChange: () => {
                    setSelectedName(null);
                    resetBranch();
                  },
                })}
              />
            </Field>
            <CodeupBranchPicker
              key={validId.success ? validId.data : ''}
              repoId={validId.success ? validId.data : ''}
              value={selectedBranch}
              onSelect={(name) => form.setValue('branch', name, { shouldValidate: true })}
              error={errors.branch?.message}
            />
            <div className="flex flex-col gap-1.5">
              <div className="flex items-start gap-2">
                <Checkbox
                  id={authorizeId}
                  checked={form.watch('authorize') === true}
                  onCheckedChange={(value) =>
                    form.setValue('authorize', (value === true) as true, { shouldValidate: true })
                  }
                  aria-invalid={errors.authorize ? true : undefined}
                  aria-describedby={errors.authorize ? `${authorizeId}-error` : undefined}
                  className="mt-0.5"
                />
                <Label htmlFor={authorizeId} className="font-normal">
                  我授权 CodeHarbor 使用我当前绑定的云效 PAT 自动同步该仓库。平台不会借用其他用户的令牌。
                </Label>
              </div>
              {errors.authorize ? (
                <p id={`${authorizeId}-error`} className="text-xs text-status-error">
                  {errors.authorize.message}
                </p>
              ) : null}
            </div>
            <Button type="submit" loading={create.isPending} disabled={!selectedBranch || !validId.success}>
              接入并开始构建
            </Button>
          </Card>
        </form>
      </div>

      <SecretReveal
        open={created !== null}
        title="仓库已接入，请配置 Webhook"
        description={created ? `${created.repository.name} 已加入构建队列（任务 ${created.job_id.slice(0, 8)}）。` : ''}
        items={
          created
            ? [
                {
                  label: 'Webhook URL',
                  value: `${window.location.origin}${created.webhook_path}`,
                  hint: '在 Codeup 仓库设置 → Webhooks 中新建普通 Webhook，填入该 URL，事件勾选 Push。',
                },
                {
                  label: 'Secret Token（X-Codeup-Token）',
                  value: created.webhook_token,
                  hint: '填入 Webhook 的 Secret Token；无法配置 Webhook 时仍可手动同步，后台定期对账也会补偿。',
                },
              ]
            : []
        }
        onClose={() => {
          const target = created?.repository.repo_id;
          setCreated(null);
          if (target) navigate(`/repositories/${target}`);
        }}
        confirmLabel="我已妥善保存，查看仓库"
      >
        {created ? <IndexBuildProgress jobId={created.job_id} /> : null}
      </SecretReveal>
    </>
  );
}
