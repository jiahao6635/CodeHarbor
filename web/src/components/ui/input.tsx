import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'h-9 w-full min-w-0 rounded-sm border border-input bg-background px-3 text-base text-foreground placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-status-error',
        type === 'password' && 'font-mono tracking-wide',
        className,
      )}
      {...props}
    />
  );
}

export function NativeSelect({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-9 w-full min-w-0 rounded-sm border border-input bg-background px-3 text-base text-foreground transition-[border-color] duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
