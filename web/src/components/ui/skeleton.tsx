import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'rounded-sm bg-muted motion-safe:animate-[skeleton-shimmer_1.5s_linear_infinite] motion-safe:bg-[linear-gradient(90deg,var(--color-muted)_25%,color-mix(in_srgb,var(--color-muted)_60%,var(--color-border))_50%,var(--color-muted)_75%)] motion-safe:bg-[length:200%_100%]',
        className,
      )}
      {...props}
    />
  );
}
