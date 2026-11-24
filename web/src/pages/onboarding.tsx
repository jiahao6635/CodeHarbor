import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { apiFetch } from '@/api/client';
import { useSession } from '@/auth/session';
import { ErrorNotice } from '@/components/error-notice';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { pat } from '@/lib/validation';

export default function OnboardingPage() {
  const { me, refreshSession } = useSession();
  const client = useQueryClient();
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function bind(event: React.FormEvent) {
    event.preventDefault();
    if (!pat.safeParse(value).success || pending) return;
    setPending(true);
    setError(null);
    setSuccess(false);
    try {
      await apiFetch('/api/v1/auth/yunxiao/bind', { method: 'POST', body: { pat: value } });
      await refreshSession();
      void client.invalidateQueries({
        predicate: (query) => ['repositories', 'codeup', 'codeup-branches', 'keys'].includes(String(query.queryKey[0])),
      });
      setSuccess(true);
    } catch (failure) {
      setError(failure);
    } finally {
      setValue('');
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader
        title="云效凭证"
        description="绑定自己的云效 PAT 后，可接入有权克隆的仓库，并为 Agent 创建 API Key。"
      />
      <Card className="max-w-lg">
        <form className="flex flex-col gap-4" onSubmit={(event) => void bind(event)}>
          <p className="text-sm text-muted-foreground">{me?.has_pat ? '已绑定云效 PAT' : '尚未绑定云效 PAT'}</p>
          {success ? <Alert>云效 PAT 已保存。</Alert> : null}
          {error != null ? <ErrorNotice error={error} title="绑定失败" /> : null}
          <Field
            id="yunxiao-pat"
            label="云效个人访问令牌"
            helper="需要读取用户、仓库和分支的权限。接入及源码查询还需要 Git HTTPS 克隆权限。更换 PAT 后，请重新授权受影响仓库的自动同步。"
          >
            <Input
              id="yunxiao-pat"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!pat.safeParse(value).success} loading={pending}>
              {me?.has_pat ? '更新 PAT' : '绑定 PAT'}
            </Button>
            {me?.has_pat ? (
              <Button asChild variant="secondary">
                <Link to="/keys">管理 API Key</Link>
              </Button>
            ) : null}
          </div>
        </form>
      </Card>
    </>
  );
}
