import { ShieldCheck } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function AuthLayout({ children, width = 'sm' }: { children: ReactNode; width?: 'sm' | 'md' }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className={cn('flex w-full flex-col gap-6', width === 'sm' ? 'max-w-[400px]' : 'max-w-[560px]')}>
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-7 text-accent" weight="duotone" aria-hidden="true" />
          <span className="text-lg font-semibold">CodeHarbor 控制台</span>
        </div>
        {children}
      </div>
    </div>
  );
}
