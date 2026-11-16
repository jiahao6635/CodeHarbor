import { formatAbsolute, formatRelative } from '@/lib/format';

export function RelativeTime({ value }: { value: number | string | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  const iso = new Date(value).toISOString();
  return (
    <time dateTime={iso} title={formatAbsolute(value)} className="tabular">
      {formatRelative(value)}
    </time>
  );
}
