'use client';

import { Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { formText, messageOf } from '@/lib/forms';
import { OperationError, query } from '@/lib/operations';
import { projectName } from '@/lib/projects';
import type { ReadySource } from './new-project';

interface Repository {
  installationId: number;
  repo: string;
  private: boolean;
  defaultBranch: string;
}

/**
 * A GitHub repository: picked from the connected accounts (private ones
 * too), or typed in for a public one when GitHub is not connected.
 */
export function GithubSource({ onReady }: { onReady: (ready: ReadySource) => void }) {
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [appReady, setAppReady] = useState(true);
  const [picked, setPicked] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    query<Repository[]>('github.repositories').then(
      (list) => {
        setRepos(list);
        setPicked(list[0]?.repo ?? '');
      },
      (err: unknown) => {
        setRepos([]);
        if (err instanceof OperationError && err.code === 'unavailable') setAppReady(false);
      },
    );
  }, []);

  async function connect() {
    const res = await fetch('/api/v1/github/install');
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      setError(messageOf(body, 'GitHub could not be connected.'));
      return;
    }
    window.location.assign((body as { url: string }).url);
  }

  function submit(form: FormData) {
    const repo = formText(form, 'repo')
      .trim()
      .replace(/^https:\/\/github\.com\//, '')
      .replace(/\.git$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      setError('Write it as owner/name, like acme/website.');
      return;
    }
    onReady({
      source: { type: 'git', provider: 'github', repo, branch: formText(form, 'branch') || 'main' },
      build: { strategy: 'railpack' },
      name: projectName(repo),
      detection: null,
      secretsLeftOut: [],
    });
  }

  const selected = repos?.find((r) => r.repo === picked);
  return (
    <form action={submit} className="grid gap-4">
      {repos && repos.length > 0 ? (
        <div className="grid gap-1.5">
          <label htmlFor="repo" className="text-sm font-medium">
            Repository
          </label>
          <select
            id="repo"
            name="repo"
            value={picked}
            onChange={(e) => {
              setPicked(e.target.value);
            }}
            className="h-10 rounded-md border border-border bg-surface-raised px-3 text-sm"
          >
            {repos.map((r) => (
              <option key={r.repo} value={r.repo}>
                {r.repo}
                {r.private ? ' (private)' : ''}
              </option>
            ))}
          </select>
          {selected?.private && (
            <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Lock aria-hidden className="size-3" /> Private: read through the VDeploy GitHub App.
            </p>
          )}
        </div>
      ) : (
        <Field
          label="Public repository"
          name="repo"
          required
          placeholder="acme/website"
          hint="owner/name, or the address from GitHub."
        />
      )}
      <Field
        key={selected?.repo ?? 'typed'}
        label="Branch"
        name="branch"
        defaultValue={selected?.defaultBranch ?? 'main'}
        hint="Every push to this branch deploys, when GitHub is connected."
      />
      {error && (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={repos === null}>
          Continue
        </Button>
        {appReady && (
          <Button type="button" variant="secondary" onClick={() => void connect()}>
            {repos && repos.length > 0
              ? 'Connect another GitHub account'
              : 'Connect GitHub for private repositories'}
          </Button>
        )}
      </div>
    </form>
  );
}
