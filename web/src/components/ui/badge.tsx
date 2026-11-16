import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-foreground',
        ready: 'bg-status-ready-tint text-status-ready',
        progress: 'bg-status-progress-tint text-status-progress',
        pending: 'bg-status-pending-tint text-status-pending',
        warning: 'bg-status-warning-tint text-status-warning',
        error: 'bg-status-error-tint text-status-error',
        accent: 'bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-accent',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({ className, tone, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
