'use client';

import { X } from 'lucide-react';
import { Dialog as Primitive } from 'radix-ui';
import type { ReactNode } from 'react';

/** A modal on Radix: focus is trapped and returned, Escape closes, the title is announced. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string | undefined;
  children: ReactNode;
}) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Primitive.Content className="fixed top-1/2 left-1/2 z-50 grid max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border border-border bg-surface-raised p-6 shadow-lg">
          <div className="grid gap-1 pr-8">
            <Primitive.Title className="text-lg font-semibold">{title}</Primitive.Title>
            {description ? (
              <Primitive.Description className="text-sm text-muted-foreground">
                {description}
              </Primitive.Description>
            ) : (
              <Primitive.Description className="sr-only">{title}</Primitive.Description>
            )}
          </div>
          {children}
          <Primitive.Close
            aria-label="Close"
            className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground hover:bg-surface hover:text-foreground"
          >
            <X aria-hidden className="size-4" />
          </Primitive.Close>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
