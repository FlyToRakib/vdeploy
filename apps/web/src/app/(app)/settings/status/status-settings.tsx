'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { formText } from '@/lib/forms';
import { query, runOperation } from '@/lib/operations';
import type { ProjectSummary } from '@/lib/projects';

interface StatusPage {
  slug: string;
  title: string;
  enabled: boolean;
  entries: { projectId: string; label: string }[];
}

/**
 * The page you hand to strangers (§18).
 *
 * Off until somebody turns it on, and then it shows only the apps chosen,
 * under names they write — "The shop", not "shop-prod-2". Nothing else
 * about this organization is on it: no addresses, no server names, no apps
 * that were not put there.
 */
export function StatusSettings() {
  const [page, setPage] = useState<StatusPage | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void query<{ page: StatusPage | null; publicUrl: string | null }>('status.get', {}).then(
      (answer) => {
        if (!live) return;
        setPage(answer.page);
        setUrl(answer.publicUrl);
        setEnabled(answer.page?.enabled ?? false);
        setChosen(
          Object.fromEntries((answer.page?.entries ?? []).map((e) => [e.projectId, e.label])),
        );
      },
      () => {
        if (live) setPage(null);
      },
    );
    void query<ProjectSummary[]>('project.list', {}).then(
      (list) => {
        if (live) setProjects(list);
      },
      () => {
        if (live) setProjects([]);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  async function save(form: FormData) {
    setSaving(true);
    try {
      const outcome = await runOperation<{ url: string }>('status.configure', {
        slug: formText(form, 'slug').trim(),
        title: formText(form, 'title').trim(),
        enabled,
        apps: Object.entries(chosen).map(([projectId, label]) => ({ projectId, label })),
      });
      if (outcome.status === 'done') {
        setUrl(outcome.result.url);
        toast.success(enabled ? 'Your status page is live.' : 'Saved. It is not public yet.');
      } else {
        toast.success('Waiting for someone to approve it.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  if (projects === null) return <Skeleton className="h-64" />;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Status page</h1>
        <p className="text-sm text-muted-foreground">
          A page anyone can open, without signing in, that says whether your apps are working. It
          shows only what you put on it.
        </p>
      </div>

      <Card className="grid gap-4">
        <form action={save} className="grid gap-4">
          <Field
            label="Title"
            name="title"
            required
            maxLength={120}
            defaultValue={page?.title ?? ''}
            hint="What visitors see at the top."
          />
          <Field
            label="Address"
            name="slug"
            required
            defaultValue={page?.slug ?? ''}
            pattern="[a-z]([a-z0-9-]{1,61}[a-z0-9])?"
            hint={url ? `It is at ${url}` : 'Lowercase letters, digits and hyphens.'}
          />

          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">Apps to show</legend>
            {projects.length === 0 && (
              <p className="text-sm text-muted-foreground">
                There are no apps yet, so there is nothing to show.
              </p>
            )}
            {projects.map((project) => {
              const on = project.id in chosen;
              return (
                <div key={project.id} className="flex flex-wrap items-center gap-3 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => {
                        setChosen((was) =>
                          e.target.checked
                            ? { ...was, [project.id]: project.name }
                            : Object.fromEntries(
                                Object.entries(was).filter(([id]) => id !== project.id),
                              ),
                        );
                      }}
                    />
                    <span className="font-mono">{project.name}</span>
                  </label>
                  {on && (
                    <input
                      aria-label={`What visitors call ${project.name}`}
                      value={chosen[project.id] ?? ''}
                      maxLength={80}
                      onChange={(e) => {
                        setChosen((was) => ({ ...was, [project.id]: e.target.value }));
                      }}
                      placeholder="What visitors call it"
                      className="h-9 flex-1 rounded-md border border-border bg-surface-raised px-3 text-sm"
                    />
                  )}
                </div>
              );
            })}
          </fieldset>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
              }}
            />
            <span>
              Anyone with the address can read it.{' '}
              <span className="text-muted-foreground">
                Only the names you wrote above and whether each is working.
              </span>
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {url && enabled && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="text-sm underline underline-offset-2"
              >
                Open it
              </a>
            )}
          </div>
        </form>
      </Card>
    </div>
  );
}
