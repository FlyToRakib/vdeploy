'use client';

import { zipSync } from 'fflate';
import { FolderUp, UploadCloud } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Status } from '@/components/ui/status';
import { messageOf } from '@/lib/forms';
import { query, runOperation } from '@/lib/operations';
import { describeDetection, projectName, uploadPlan } from '@/lib/projects';
import type { ReadySource } from './new-project';

const MAX_BYTES = 200 * 1024 * 1024;
const ARCHIVE = /\.(zip|tar\.gz|tgz)$/i;

interface BuildView {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  error: string | null;
  detection: unknown;
}

type Phase =
  { kind: 'idle' } | { kind: 'working'; label: string } | { kind: 'error'; message: string };

async function detect(serverId: string, uploadId: string): Promise<BuildView> {
  const started = await runOperation<{ buildId: string }>('source.detect', { serverId, uploadId });
  if (started.status !== 'done') throw new Error('The detection did not start');
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    const build = await query<BuildView>('build.get', { buildId: started.result.buildId });
    if (build.status === 'succeeded' || build.status === 'failed') return build;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('The server did not finish looking at the files; try again');
}

/**
 * A folder (zipped here, in the browser) or an archive, uploaded and looked
 * at by the server before anything is built: "we think this is…" (§30 ⑥).
 */
export function UploadSource({
  serverId,
  onReady,
}: {
  serverId: string;
  onReady: (ready: ReadySource) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);

  async function send(archive: Blob, type: string, name: string, secretsLeftOut: string[]) {
    if (archive.size > MAX_BYTES) {
      setPhase({ kind: 'error', message: 'That is more than 200 MB, even compressed.' });
      return;
    }
    setPhase({ kind: 'working', label: 'Uploading…' });
    const res = await fetch('/api/v1/uploads', {
      method: 'POST',
      headers: { 'content-type': type },
      body: archive,
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      setPhase({ kind: 'error', message: messageOf(body, 'The upload did not go through.') });
      return;
    }
    const { uploadId } = body as { uploadId: string };
    setPhase({ kind: 'working', label: 'Looking at your files on the server…' });
    const build = await detect(serverId, uploadId);
    if (build.status === 'failed') {
      setPhase({
        kind: 'error',
        message: `We could not tell how to run this app. ${build.error ?? ''} It usually needs a package.json, requirements.txt, go.mod or an index.html at the top of the folder.`,
      });
      return;
    }
    setPhase({ kind: 'idle' });
    onReady({
      source: { type: 'archive', uploadId },
      build: { strategy: 'railpack' },
      name: projectName(name),
      detection: describeDetection(build.detection),
      secretsLeftOut,
    });
  }

  async function run(task: () => Promise<void>) {
    try {
      await task();
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : 'That did not work',
      });
    }
  }

  function fromArchive(file: File) {
    if (!ARCHIVE.test(file.name)) {
      setPhase({ kind: 'error', message: 'Choose a .zip or .tar.gz file, or a folder.' });
      return;
    }
    const type = /\.zip$/i.test(file.name) ? 'application/zip' : 'application/gzip';
    void run(() => send(file, type, file.name, []));
  }

  function fromFolder(files: FileList) {
    void run(async () => {
      setPhase({ kind: 'working', label: 'Packing the folder…' });
      const all = [...files];
      const byPath = new Map(all.map((f) => [f.webkitRelativePath, f]));
      const { keep, secretsLeftOut } = uploadPlan([...byPath.keys()]);
      if (keep.length === 0) {
        setPhase({ kind: 'error', message: 'That folder is empty.' });
        return;
      }
      const root = all[0]?.webkitRelativePath.split('/')[0] ?? 'app';
      const entries: Record<string, Uint8Array> = {};
      for (const path of keep) {
        const file = byPath.get(`${root}/${path}`);
        if (file) entries[path] = new Uint8Array(await file.arrayBuffer());
      }
      const zipped = zipSync(entries, { level: 6 });
      await send(
        new Blob([zipped], { type: 'application/zip' }),
        'application/zip',
        root,
        secretsLeftOut,
      );
    });
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) fromArchive(file);
  }

  const busy = phase.kind === 'working';
  return (
    <div className="grid gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={onDrop}
        className={`grid justify-items-center gap-3 rounded-lg border-2 border-dashed p-8 text-center ${
          dragging ? 'border-accent bg-surface' : 'border-border'
        }`}
      >
        <UploadCloud aria-hidden className="size-8 text-muted-foreground" />
        <p className="max-w-sm text-sm text-muted-foreground">
          Drop a .zip or .tar.gz here, or choose your app&apos;s folder. Dependencies
          (node_modules), git history and .env files stay on your computer.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild variant="secondary" size="sm" aria-disabled={busy}>
            <label className="cursor-pointer">
              <FolderUp aria-hidden className="size-4" />
              Choose a folder
              <input
                type="file"
                className="sr-only"
                disabled={busy}
                ref={(el) => {
                  el?.setAttribute('webkitdirectory', '');
                }}
                onChange={(e) => {
                  if (e.target.files?.length) fromFolder(e.target.files);
                }}
              />
            </label>
          </Button>
          <Button asChild variant="secondary" size="sm" aria-disabled={busy}>
            <label className="cursor-pointer">
              Choose a .zip file
              <input
                type="file"
                accept=".zip,.tar.gz,.tgz"
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) fromArchive(file);
                }}
              />
            </label>
          </Button>
        </div>
      </div>
      <div aria-live="polite">
        {phase.kind === 'working' && <Status health="neutral">{phase.label}</Status>}
        {phase.kind === 'error' && (
          <p role="alert" className="text-sm text-status-failed">
            {phase.message}
          </p>
        )}
      </div>
    </div>
  );
}
