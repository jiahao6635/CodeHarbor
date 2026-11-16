import { Info, Warning, XCircle } from '@phosphor-icons/react';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const alertVariants = cva(
  'flex gap-3 rounded-md border px-4 py-3 text-sm [&_svg]:mt-0.5 [&_svg]:size-5 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        info: 'border-status-progress/40 bg-status-progress-tint text-foreground [&_svg]:text-status-progress',
        warning: 'border-status-warning/40 bg-status-warning-tint text-foreground [&_svg]:text-status-warning',
        error: 'border-status-error/40 bg-status-error-tint text-foreground [&_svg]:text-status-error',
      },
    },
    defaultVariants: { tone: 'info' },
  },
);

const ICONS = { info: Info, warning: Warning, error: XCircle } as const;

export function Alert({
  className,
  tone = 'info',
  title,
  children,
  ...props
}: ComponentProps<'div'> & VariantProps<typeof alertVariants> & { title?: string }) {
  const Icon = ICONS[tone ?? 'info'];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn(alertVariants({ tone }), className)} {...props}>
      <Icon aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1">
        {title ? <p className="font-medium">{title}</p> : null}
        <div className="text-muted-foreground [&_a]:text-accent [&_a]:underline-offset-2 [&_a:hover]:underline">
          {children}
        </div>
      </div>
    </div>
  );
}
