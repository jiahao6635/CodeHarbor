import { ApiError } from '@/api/client';
import { Alert } from '@/components/ui/alert';
import { describeError } from '@/lib/errors';

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return describeError(error.code);
  if (error instanceof Error) return error.message;
  return '发生未知错误';
}

export function ErrorNotice({ error, title = '加载失败' }: { error: unknown; title?: string }) {
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <Alert tone="error" title={title}>
      <p>{errorMessage(error)}</p>
      {requestId ? (
        <p className="text-xs">
          请求 ID：<code className="select-all">{requestId}</code>
        </p>
      ) : null}
    </Alert>
  );
}
