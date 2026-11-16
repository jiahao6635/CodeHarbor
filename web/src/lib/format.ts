import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

export function formatAbsolute(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return dayjs(value).format('YYYY-MM-DD HH:mm:ss');
}

export function formatRelative(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return dayjs(value).fromNow();
}

export function shortSha(value: string | null | undefined, length = 7): string {
  if (!value) return '—';
  return value.slice(0, length);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

/** Remaining validity expressed for humans; expired keys read as such. */
export function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return '永不过期';
  if (expiresAt <= Date.now()) return '已过期';
  return `${formatRelative(expiresAt).replace('内', '后')}（${formatAbsolute(expiresAt)}）`;
}
