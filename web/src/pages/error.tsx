import { WarningOctagon } from '@phosphor-icons/react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Button } from '@/components/ui/button';

/** Route-level boundary so a rendering failure never exposes the framework's developer screen. */
export default function RouteErrorPage() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : '未知错误';
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <WarningOctagon className="size-10 text-status-error" aria-hidden="true" />
      <h1 className="text-xl font-semibold">页面出错了</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        控制台遇到无法恢复的错误。请刷新页面重试；若问题持续，请把以下信息反馈给管理员。
      </p>
      <code className="max-w-lg break-all rounded-sm bg-muted px-3 py-2 text-xs">{message}</code>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => window.location.reload()}>
          刷新页面
        </Button>
        <Button asChild>
          <Link to="/repositories" reloadDocument>
            返回仓库列表
          </Link>
        </Button>
      </div>
    </div>
  );
}
