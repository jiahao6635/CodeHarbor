import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export function Separator({ className, ...props }: ComponentProps<'hr'>) {
  return <hr className={cn('my-4 border-0 border-t border-border', className)} {...props} />;
}
