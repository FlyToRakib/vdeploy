'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import type { ReadySource } from '../new/new-project';
import { UploadSource } from '../new/upload-source';

/**
 * A new version of an uploaded app: drop the folder again, see what the
 * server found, deploy it — health-gated, rolled back if it does not start.
 */
export function NewVersionDialog({
  open,
  onOpenChange,
  serverId,
  onDeploy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  onDeploy: (uploadId: string) => void;
}) {
  const [ready, setReady] = useState<ReadySource | null>(null);
  const close = (next: boolean) => {
    if (!next) setReady(null);
    onOpenChange(next);
  };
  const uploadId = typeof ready?.source.uploadId === 'string' ? ready.source.uploadId : null;

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Upload a new version"
      description="The version running now keeps serving until the new one is healthy; if it never is, nothing changes."
    >
      {!ready && <UploadSource serverId={serverId} onReady={setReady} />}
      {ready && (
        <div className="grid gap-3 text-sm">
          <p>
            {ready.detection?.runtime
              ? `We think this is a ${ready.detection.runtime} app.`
              : 'The server looked at the files.'}
            {ready.secretsLeftOut.length > 0 &&
              ` ${ready.secretsLeftOut.join(', ')} stayed on your computer.`}
          </p>
          <div className="flex gap-2">
            <Button
              disabled={!uploadId}
              onClick={() => {
                if (uploadId) onDeploy(uploadId);
                close(false);
              }}
            >
              Deploy this version
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setReady(null);
              }}
            >
              Choose again
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
