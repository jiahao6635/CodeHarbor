import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('block text-sm font-medium leading-5 text-foreground', className)} {...props} />;
}

/** Visible label + input + helper/error wiring. Error text is linked to the field via aria-describedby. */
export function Field({
  id,
  label,
  helper,
  error,
  children,
  className,
}: {
  id: string;
  label: string;
  helper?: ReactNode;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {helper ? (
        <p id={`${id}-helper`} className="text-xs text-muted-foreground">
          {helper}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-status-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const describedBy = (id: string, options: { helper?: boolean; error?: boolean }) =>
  [options.error ? `${id}-error` : null, options.helper ? `${id}-helper` : null].filter(Boolean).join(' ') || undefined;
