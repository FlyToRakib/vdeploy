'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

/** A command (or secret), with a button that copies it and says so. */
export function CopyCommand({
  command,
  label = 'Copy the command',
}: {
  command: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-2">
      <pre className="overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono text-xs break-all whitespace-pre-wrap">
        {command}
      </pre>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="justify-self-start"
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
          });
        }}
      >
        {copied ? (
          <Check aria-hidden className="size-4" />
        ) : (
          <Copy aria-hidden className="size-4" />
        )}
        {copied ? 'Copied' : label}
      </Button>
    </div>
  );
}
