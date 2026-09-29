'use client';

import { OPERATIONS } from '@vdeploy/contracts';
import { Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/empty-state';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { formText } from '@/lib/forms';
import { OperationError, query, runOperation } from '@/lib/operations';

type BuiltIn = 'viewer' | 'developer' | 'admin';

interface Member {
  userId: string;
  name: string;
  email: string;
  role: BuiltIn | 'owner';
  customRole: { id: string; name: string } | null;
  teams: { id: string; name: string }[];
}

interface Members {
  members: Member[];
  invited: { email: string; role: string | null; expiresAt: string }[];
}

interface CustomRole {
  id: string;
  name: string;
  base: BuiltIn;
  operations: string[];
  people: number;
}

interface Team {
  id: string;
  name: string;
  members: { userId: string; name: string }[];
  projects: { id: string; name: string }[];
}

const RANK: Record<BuiltIn | 'owner', number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };
const BUILT_IN: { role: BuiltIn; label: string; words: string }[] = [
  { role: 'viewer', label: 'Viewer', words: 'Viewer — sees everything, changes nothing' },
  { role: 'developer', label: 'Developer', words: 'Developer — deploys and changes apps' },
  { role: 'admin', label: 'Admin', words: 'Admin — also servers, people and settings' },
];

/** The changes a role built on \`base\` could be given. */
function changesFor(base: BuiltIn) {
  return OPERATIONS.filter((op) => op.mutates && RANK[base] >= RANK[op.minRole]);
}

/** People, what each may do, and which team owns which apps (§20 Org). */
export function MembersPage() {
  const stepUp = useStepUp();
  const [data, setData] = useState<Members | null>(null);
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [base, setBase] = useState<BuiltIn>('developer');
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void Promise.all([
      query<Members>('org.members'),
      query<CustomRole[]>('role.list'),
      query<Team[]>('team.list'),
    ]).then(
      ([m, r, t]) => {
        setData(m);
        setRoles(r);
        setTeams(t);
      },
      (err: unknown) => {
        setData({ members: [], invited: [] });
        setError(err instanceof Error ? err.message : 'This could not be loaded.');
      },
    );
  }, [version]);

  async function run(name: string, input: Record<string, unknown>, done: string) {
    setError(null);
    try {
      await stepUp(() => runOperation(name, input));
      toast.success(done);
      setVersion((v) => v + 1);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        setError(err instanceof Error ? err.message : 'That did not work.');
      }
    }
  }

  /** A role change: built-in roles through user.set_role, the organization's own through role.assign. */
  function changeRole(person: Member, value: string) {
    if (value.startsWith('custom:')) {
      void run('role.assign', { userId: person.userId, roleId: value.slice(7) }, 'Role changed');
      return;
    }
    void (async () => {
      if (person.customRole) {
        await run('role.assign', { userId: person.userId, roleId: null }, 'Role changed');
      }
      await run('user.set_role', { userId: person.userId, role: value }, 'Role changed');
    })();
  }

  if (data === null) return <Skeleton className="h-40" />;
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Members</h1>
        <p className="text-sm text-muted-foreground">
          Who is in this organization and what each may do. Changing someone&apos;s role or teams
          signs them out everywhere, so they sign in again under what they now have.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      )}

      <Card className="grid gap-3">
        <h2 className="font-medium">People</h2>
        <ul className="grid gap-3">
          {data.members.map((person) => (
            <li
              key={person.userId}
              className="grid gap-2 border-b border-border pb-3 text-sm last:border-0 last:pb-0 sm:grid-cols-[1fr_auto_auto] sm:items-center"
            >
              <div className="min-w-0">
                <p className="font-medium">{person.name}</p>
                <p className="break-all text-muted-foreground">
                  {person.email}
                  {person.teams.length > 0 && ` · ${person.teams.map((t) => t.name).join(', ')}`}
                </p>
              </div>
              {person.role === 'owner' ? (
                <span className="text-muted-foreground">Owner</span>
              ) : (
                <select
                  aria-label={`Role of ${person.name}`}
                  value={person.customRole ? `custom:${person.customRole.id}` : person.role}
                  onChange={(event) => {
                    changeRole(person, event.target.value);
                  }}
                  className="h-9 rounded-md border border-border bg-surface-raised px-2"
                >
                  {BUILT_IN.map((b) => (
                    <option key={b.role} value={b.role}>
                      {b.label}
                    </option>
                  ))}
                  {roles.map((r) => (
                    <option key={r.id} value={`custom:${r.id}`}>
                      {r.name}
                    </option>
                  ))}
                </select>
              )}
              {person.role !== 'owner' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run('user.remove', { userId: person.userId }, `${person.name} removed`)
                  }
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
        {data.invited.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Invited, not joined yet: {data.invited.map((i) => i.email).join(', ')}
          </p>
        )}
        <form
          action={(form) => {
            void run(
              'user.invite',
              { email: formText(form, 'email').trim(), role: formText(form, 'role') },
              'Invitation sent',
            );
          }}
          className="grid gap-3 border-t border-border pt-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"
        >
          <Field label="Invite by email" name="email" type="email" required />
          <select
            name="role"
            aria-label="Their role"
            defaultValue="developer"
            className="h-10 rounded-md border border-border bg-surface-raised px-2 text-sm"
          >
            {BUILT_IN.map((b) => (
              <option key={b.role} value={b.role}>
                {b.words}
              </option>
            ))}
          </select>
          <Button type="submit">Invite</Button>
        </form>
      </Card>

      <Card className="grid gap-3">
        <h2 className="font-medium">Roles of your own</h2>
        <p className="text-sm text-muted-foreground">
          A built-in role, allowed only the changes you pick. It reads what its built-in role reads.
        </p>
        {roles.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{r.name}</span>
            <span className="text-muted-foreground">
              a {r.base} allowed {r.operations.length} change{r.operations.length === 1 ? '' : 's'}
              {r.people ? ` · ${String(r.people)} ${r.people === 1 ? 'person' : 'people'}` : ''}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => void run('role.delete', { roleId: r.id }, `${r.name} deleted`)}
            >
              Delete
            </Button>
          </div>
        ))}
        <form
          action={(form) => {
            const operations = changesFor(base)
              .map((op) => op.name)
              .filter((name) => form.get(`op-${name}`) === 'on');
            void run(
              'role.create',
              { name: formText(form, 'name').trim(), base, operations },
              'Role made',
            );
          }}
          className="grid gap-3 border-t border-border pt-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" name="name" required maxLength={60} placeholder="Releaser" />
            <label className="grid gap-1 text-sm">
              Built on
              <select
                value={base}
                onChange={(event) => {
                  setBase(event.target.value as BuiltIn);
                }}
                className="h-10 rounded-md border border-border bg-surface-raised px-2"
              >
                {BUILT_IN.map((b) => (
                  <option key={b.role} value={b.role}>
                    {b.role}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="grid max-h-64 gap-1 overflow-y-auto rounded-md border border-border p-2 text-sm sm:grid-cols-2">
            <legend className="px-1 font-medium">Changes it may make</legend>
            {changesFor(base).map((op) => (
              <label key={op.name} className="flex items-start gap-2">
                <input type="checkbox" name={`op-${op.name}`} className="mt-1" />
                <span>{op.summary}</span>
              </label>
            ))}
          </fieldset>
          <Button type="submit" className="justify-self-start">
            Make the role
          </Button>
        </form>
      </Card>

      <Card className="grid gap-3">
        <h2 className="font-medium">Teams</h2>
        <p className="text-sm text-muted-foreground">
          An app given to a team can be changed only by that team&apos;s members and by admins.
          Everyone can still see it.
        </p>
        {teams.length === 0 && (
          <EmptyState icon={Users} title="No teams">
            Make one, then give it apps from each app&apos;s Config screen.
          </EmptyState>
        )}
        {teams.map((t) => {
          const outside = data.members.filter(
            (m) => m.role !== 'owner' && !t.members.some((x) => x.userId === m.userId),
          );
          return (
            <div key={t.id} className="grid gap-2 rounded-md border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t.name}</span>
                <span className="text-muted-foreground">
                  {t.projects.length ? t.projects.map((p) => p.name).join(', ') : 'no apps yet'}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => void run('team.delete', { teamId: t.id }, `${t.name} deleted`)}
                >
                  Delete
                </Button>
              </div>
              <ul className="flex flex-wrap gap-2">
                {t.members.map((m) => (
                  <li key={m.userId} className="flex items-center gap-1">
                    {m.name}
                    <button
                      type="button"
                      aria-label={`Take ${m.name} out of ${t.name}`}
                      className="text-muted-foreground underline"
                      onClick={() =>
                        void run(
                          'team.remove_member',
                          { teamId: t.id, userId: m.userId },
                          `${m.name} left ${t.name}`,
                        )
                      }
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
              {outside.length > 0 && (
                <select
                  aria-label={`Add someone to ${t.name}`}
                  value=""
                  onChange={(event) => {
                    if (event.target.value) {
                      void run(
                        'team.add_member',
                        { teamId: t.id, userId: event.target.value },
                        'Added to the team',
                      );
                    }
                  }}
                  className="h-9 justify-self-start rounded-md border border-border bg-surface-raised px-2"
                >
                  <option value="">Add someone…</option>
                  {outside.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
        <form
          action={(form) => {
            void run('team.create', { name: formText(form, 'team').trim() }, 'Team made');
          }}
          className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
        >
          <Field label="New team" name="team" required maxLength={60} placeholder="payments" />
          <Button type="submit">Make the team</Button>
        </form>
      </Card>
    </div>
  );
}
