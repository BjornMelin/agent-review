import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex min-h-6 items-center rounded-md border px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        neutral:
          'border-[var(--border)] bg-[var(--surface)] text-[var(--muted-foreground)]',
        success:
          'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
        warning:
          'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200',
        danger:
          'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200',
        info: 'border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-900 dark:bg-cyan-950 dark:text-cyan-200',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  }
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>;

export function Badge({
  className,
  variant,
  ...props
}: BadgeProps): React.ReactNode {
  return (
    <span className={cn(badgeVariants({ variant, className }))} {...props} />
  );
}
