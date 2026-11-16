import { CircleNotch } from '@phosphor-icons/react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm font-medium text-sm transition-[background-color,border-color,color,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-foreground hover:bg-[color-mix(in_srgb,var(--color-accent)_92%,white)]',
        secondary: 'border border-border bg-transparent text-foreground hover:bg-muted',
        ghost: 'bg-transparent text-foreground hover:bg-muted',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-[color-mix(in_srgb,var(--color-destructive)_92%,white)]',
        link: 'h-auto px-0 text-accent underline-offset-4 hover:underline',
      },
      size: {
        md: 'h-9 px-3.5 [&_svg]:size-5',
        sm: 'h-8 px-2.5 text-xs [&_svg]:size-4',
        icon: 'size-9 [&_svg]:size-5',
        'icon-sm': 'size-8 [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export function Button({ className, variant, size, asChild, loading, children, disabled, ...props }: ButtonProps) {
  if (asChild) {
    // Slot requires exactly one child; loading state is only meaningful for real buttons.
    return (
      <Slot.Root
        className={cn(buttonVariants({ variant, size }), className)}
        aria-disabled={disabled || undefined}
        {...props}
      >
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      type="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <CircleNotch className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export { buttonVariants };
