'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { sizeWords } from '@/lib/databases';
import { query } from '@/lib/operations';
import { ago } from '@/lib/servers';
import { useProject } from '../project-shell';

interface Entry {
  name: string;
  kind: 'file' | 'folder' | 'link' | 'other';
  sizeBytes: number;
  modifiedAt: string;
  linkTo: string | null;
}

interface Listing {
  folder: string;
  mountPath: string;
  path: string;
  entries: Entry[];
  truncated: boolean;
}

/**
 * What an app has actually written (§20 Runtime). The question this answers
 * is "did my upload arrive?", and answering it used to mean a shell.
 *
 * Only permanent folders are here, and that is the honest shape of it:
 * everything else an app writes is gone at the next deploy, so a browser
 * over it would show files that are not really there.
 */
export function FileBrowser() {
  const { projectId, row } = useProject();
  const folders = row.spec.runtime.volumes;
  const [folder, setFolder] = useState(() => folders[0]?.name ?? '');
  const [path, setPath] = useState('');
  // One piece of state for the answer, tagged with the folder it answers
  // about: while the tag does not match, the screen is still loading, and
  // nothing has to be cleared to say so.
  const [answer, setAnswer] = useState<{ at: string; listing: Listing | null; problem: string }>({
    at: '',
    listing: null,
    problem: '',
  });
  const at = `${folder}/${path}`;
  const loading = answer.at !== at;

  useEffect(() => {
    if (!folder) return;
    let live = true;
    void query<Listing>('files.list', { projectId, folder, path }).then(
      (listing) => {
        if (live) setAnswer({ at: `${folder}/${path}`, listing, problem: '' });
      },
      (error: unknown) => {
        if (!live) return;
        const problem = error instanceof Error ? error.message : 'That folder could not be read';
        setAnswer({ at: `${folder}/${path}`, listing: null, problem });
      },
    );
    return () => {
      live = false;
    };
  }, [projectId, folder, path]);

  const listing = loading ? null : answer.listing;
  const problem = loading ? '' : answer.problem;

  if (folders.length === 0) {
    return (
      <Card className="grid gap-2">
        <h2 className="font-medium">This app has no permanent folders</h2>
        <p className="text-sm text-muted-foreground">
          Everything it writes is deleted on the next deploy, so there is nothing here to look at.
          The Config tab’s Files section is where a folder is made permanent.
        </p>
      </Card>
    );
  }

  const parts = path === '' ? [] : path.split('/');
  const into = (name: string) => {
    setPath(path === '' ? name : `${path}/${name}`);
  };
  const downloadUrl = (name: string) =>
    `/api/v1/projects/${projectId}/files/download?folder=${encodeURIComponent(folder)}&path=${encodeURIComponent(path === '' ? name : `${path}/${name}`)}`;

  return (
    <div className="grid gap-4">
      {folders.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {folders.map((f) => (
            <Button
              key={f.name}
              size="sm"
              variant={f.name === folder ? 'primary' : 'secondary'}
              onClick={() => {
                setFolder(f.name);
                setPath('');
              }}
            >
              {f.mountPath}
            </Button>
          ))}
        </div>
      )}

      <nav aria-label="Where you are" className="flex flex-wrap items-center gap-1 text-sm">
        <button
          type="button"
          className="font-mono underline-offset-2 hover:underline"
          onClick={() => {
            setPath('');
          }}
        >
          {listing?.mountPath ?? folders.find((f) => f.name === folder)?.mountPath ?? folder}
        </button>
        {parts.map((part, i) => (
          <span key={`${part}-${String(i)}`} className="flex items-center gap-1">
            <span className="text-muted-foreground">/</span>
            <button
              type="button"
              className="font-mono underline-offset-2 hover:underline"
              onClick={() => {
                setPath(parts.slice(0, i + 1).join('/'));
              }}
            >
              {part}
            </button>
          </span>
        ))}
      </nav>

      {problem && (
        <Card className="border-status-warning text-sm">
          <p>{problem}</p>
        </Card>
      )}
      {!problem && loading && <Skeleton className="h-32" />}
      {listing?.entries.length === 0 && (
        <p className="text-sm text-muted-foreground">This folder is empty.</p>
      )}
      {listing && listing.entries.length > 0 && (
        <ul className="grid divide-y divide-border rounded-md border border-border">
          {listing.entries.map((entry) => (
            <li
              key={entry.name}
              className="grid gap-1 p-3 text-sm sm:grid-cols-[1fr_auto_auto_auto] sm:items-center sm:gap-4"
            >
              {entry.kind === 'folder' ? (
                <button
                  type="button"
                  className="justify-self-start text-left font-mono underline-offset-2 hover:underline"
                  onClick={() => {
                    into(entry.name);
                  }}
                >
                  {entry.name}/
                </button>
              ) : (
                <span className="font-mono break-all">{entry.name}</span>
              )}
              <span className="text-muted-foreground">
                {entry.kind === 'file'
                  ? sizeWords(entry.sizeBytes)
                  : entry.kind === 'link'
                    ? `a shortcut to ${entry.linkTo ?? 'somewhere else'}`
                    : entry.kind === 'folder'
                      ? 'folder'
                      : 'not a file'}
              </span>
              <span className="text-muted-foreground" title={entry.modifiedAt}>
                {ago(entry.modifiedAt)}
              </span>
              {entry.kind === 'file' ? (
                <a
                  className="justify-self-start underline underline-offset-2 sm:justify-self-end"
                  href={downloadUrl(entry.name)}
                  download={entry.name}
                >
                  Download
                </a>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      )}
      {listing?.truncated && (
        <p className="text-sm text-muted-foreground">
          Only the first {listing.entries.length} are shown: this folder holds more than a page can
          usefully list.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        These are the files that survive a deploy. A shortcut is shown but never followed, and
        nothing outside this folder can be reached from here.
      </p>
    </div>
  );
}
