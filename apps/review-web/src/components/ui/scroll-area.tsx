import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import type * as React from 'react';
import { cn } from '@/lib/utils';

export function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>): React.ReactNode {
  return (
    <ScrollAreaPrimitive.Root
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<
  typeof ScrollAreaPrimitive.ScrollAreaScrollbar
>): React.ReactNode {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      className={cn(
        'flex touch-none select-none transition-colors',
        orientation === 'vertical'
          ? 'h-full w-2 border-l border-l-transparent p-px'
          : 'h-2 flex-col border-t border-t-transparent p-px',
        className
      )}
      orientation={orientation}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-[var(--muted)]" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}
