import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { describeError } from '@/lib/errors';

/** Errors stay until dismissed and carry the request id for log correlation. */
export function toastError(error: unknown, title = '操作失败') {
  const message =
    error instanceof ApiError ? describeError(error.code) : error instanceof Error ? error.message : '未知错误';
  const requestId = error instanceof ApiError ? error.requestId : null;
  toast.error(title, {
    description: requestId ? `${message}（请求 ID：${requestId}）` : message,
    duration: Number.POSITIVE_INFINITY,
    closeButton: true,
  });
}
