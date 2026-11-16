import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeSlash } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router';
import { z } from 'zod';
import { ApiError } from '@/api/client';
import { fetchMeWith } from '@/api/hooks';
import { useSession } from '@/auth/session';
import { AuthLayout } from '@/components/auth-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { describedBy, Field } from '@/components/ui/label';
import { describeError } from '@/lib/errors';
import { accessKey } from '@/lib/validation';

const schema = z.object({ token: accessKey });
type FormValues = z.infer<typeof schema>;

const COOLDOWN_SECONDS = 60;

export default function LoginPage() {
  const { signIn, signOutReason } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [visible, setVisible] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { token: '' } });

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const onSubmit = form.handleSubmit(async ({ token }) => {
    setServerError(null);
    try {
      const me = await fetchMeWith(token);
      signIn(token, me);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : '/repositories', { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        setCooldown(COOLDOWN_SECONDS);
        setServerError('认证失败次数过多，请稍后再试。');
        return;
      }
      setServerError(error instanceof ApiError ? describeError(error.code) : '无法连接到服务。');
    }
  });

  const tokenError = form.formState.errors.token?.message;
  return (
    <AuthLayout>
      <Card className="flex flex-col gap-5 p-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">登录</h1>
          <p className="text-sm text-muted-foreground">
            使用 CodeHarbor Key 登录。Key 仅保存在当前浏览器标签页，关闭后需重新输入。
          </p>
        </div>
        {signOutReason === 'expired' ? (
          <Alert tone="warning">会话已失效：Key 可能已过期或被撤销，请重新登录。</Alert>
        ) : null}
        {serverError ? <Alert tone="error">{serverError}</Alert> : null}
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <Field id="token" label="CodeHarbor Key" error={tokenError}>
            <div className="flex gap-2">
              <Input
                id="token"
                type={visible ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                aria-invalid={tokenError ? true : undefined}
                aria-describedby={describedBy('token', { error: !!tokenError })}
                {...form.register('token')}
              />
              <Button
                type="button"
                variant="secondary"
                size="icon"
                onClick={() => setVisible((value) => !value)}
                aria-pressed={visible}
                aria-label={visible ? '隐藏 Key' : '显示 Key'}
              >
                {visible ? <EyeSlash /> : <Eye />}
              </Button>
            </div>
          </Field>
          <Button type="submit" loading={form.formState.isSubmitting} disabled={cooldown > 0}>
            {cooldown > 0 ? `请等待 ${cooldown} 秒` : '登录'}
          </Button>
        </form>
      </Card>
      <p className="text-center text-sm text-muted-foreground">
        还没有 Key？
        <Link to="/onboarding" className="ml-1 text-accent underline-offset-4 hover:underline">
          首次绑定云效账号
        </Link>
      </p>
    </AuthLayout>
  );
}
