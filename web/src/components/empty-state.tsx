import type { Icon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

export function EmptyState({ icon: IconComponent, title, action }: { icon: Icon; title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border px-6 py-12 text-center">
      <IconComponent className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{title}</p>
      {action}
    </div>
  );
}
