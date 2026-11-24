import { useSearchParams } from 'react-router';
import { useSession } from '@/auth/session';
import { AuthLayout } from '@/components/auth-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

const LOGIN_ERRORS: Record<string, string> = {
  access_denied: '飞书授权未完成，请重新登录。',
  account_disabled: '此 CodeHarbor 账号已停用，请联系超级管理员。',
  login_failed: '飞书登录失败，请重试。',
};

export default function LoginPage() {
  const [search] = useSearchParams();
  const { expired } = useSession();
  const error = LOGIN_ERRORS[search.get('error') ?? ''];

  return (
    <AuthLayout>
      <Card className="flex flex-col gap-5 p-6">
        <div>
          <h1 className="text-xl font-semibold">登录 CodeHarbor</h1>
          <p className="mt-2 text-sm text-muted-foreground">使用企业飞书账号访问 CodeHarbor。</p>
        </div>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {expired ? <Alert tone="warning">会话已结束，请重新登录。</Alert> : null}
        <Button asChild>
          <a href="/api/v1/auth/feishu/start">使用飞书登录</a>
        </Button>
      </Card>
    </AuthLayout>
  );
}
