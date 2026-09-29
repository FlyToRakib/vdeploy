'use client';

import Link from 'next/link';
import { Lock, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Status, type Health } from '@/components/ui/status';
import {
  CHECK_EVERY,
  cleanHost,
  countdownWords,
  memoryWords,
  MEMORY_CHOICES,
  secretNameFor,
  WAIT_CHOICES,
  withChecks,
  withDomains,
  withLoadBalancing,
  withMiddleware,
  withMovedPaths,
  withTwin,
  withMemory,
  type EditableSpec,
} from '@/lib/config';
import { formText } from '@/lib/forms';
import { OperationError, query, runOperation } from '@/lib/operations';
import { ago, sizeWords, type BackupSummary } from '@/lib/databases';
import type { ServerSummary } from '@/lib/servers';
import { parseDotenv, toDotenv, type TaskView } from '@vdeploy/contracts';
import { useProject } from '../project-shell';

export function useSpec(): EditableSpec {
  return useProject().row.spec as unknown as EditableSpec;
}

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <Card className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {children}
    </Card>
  );
}

interface Secret {
  id: string;
  name: string;
}

/** Settings the app reads (environment variables); secret ones are stored encrypted, never shown. */
export function SettingsSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [problems, setProblems] = useState<string[]>([]);

  useEffect(() => {
    void query<Secret[]>('secret.list', { projectId }).then(setSecrets, () => undefined);
  }, [projectId, spec]);

  /**
   * A pasted .env, as one change: secret values are stored encrypted first,
   * each on its own, and then every setting goes in together, so the app
   * deploys once rather than once a line.
   */
  async function importFile(form: FormData) {
    const { entries, problems: found } = parseDotenv(formText(form, 'dotenv'));
    setProblems(
      entries.length === 0 && found.length === 0 ? ['There are no settings in that.'] : found,
    );
    if (entries.length === 0) return;
    // An empty value is not a secret, and could not be stored as one.
    const hidden = form.get('secret') === 'on' ? entries.filter((e) => e.value !== '') : [];
    for (const e of hidden) {
      await act(
        'secret.set',
        { projectId, name: secretNameFor(e.key), value: e.value },
        `Storing ${e.key} encrypted`,
      );
    }
    const stored = hidden.length ? await query<Secret[]>('secret.list', { projectId }) : [];
    const refs = new Map(stored.map((x) => [x.name, x.id]));
    const missing = hidden.filter((e) => !refs.has(secretNameFor(e.key))).map((e) => e.key);
    if (missing.length) {
      setProblems([`Not imported: ${missing.join(', ')} could not be stored encrypted.`]);
      return;
    }
    await act(
      'env.import',
      {
        projectId,
        entries: entries.map((e) =>
          hidden.includes(e)
            ? { key: e.key, secretRef: refs.get(secretNameFor(e.key)) }
            : { key: e.key, value: e.value },
        ),
      },
      `Setting ${String(entries.length)} settings`,
    );
  }

  async function add(form: FormData) {
    const key = formText(form, 'key').trim();
    const value = formText(form, 'value');
    if (form.get('secret') === 'on') {
      const name = secretNameFor(key);
      await act('secret.set', { projectId, name, value }, `Storing ${key} encrypted`);
      const stored = await query<Secret[]>('secret.list', { projectId });
      const secret = stored.find((s) => s.name === name);
      if (secret) await act('env.set', { projectId, key, secretRef: secret.id }, `Setting ${key}`);
    } else {
      await act('env.set', { projectId, key, value }, `Setting ${key}`);
    }
  }

  const secretName = (id: string) => secrets.find((s) => s.id === id)?.name ?? 'a secret';
  return (
    <Section
      title="Settings"
      hint="Values your app reads, like DATABASE_URL. Saving one deploys the app again with it."
    >
      {spec.runtime.env.length > 0 && (
        <ul className="grid gap-2">
          {spec.runtime.env.map((e) => (
            <li
              key={e.key}
              className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-md border border-border p-2 text-sm"
            >
              <span className="min-w-0 font-mono break-all">
                {e.key}
                <span className="text-muted-foreground"> = </span>
                {'secretRef' in e ? (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Lock aria-hidden className="size-3" />
                    stored encrypted ({secretName(e.secretRef)})
                  </span>
                ) : (
                  e.value
                )}
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${e.key}`}
                onClick={() =>
                  void act('env.unset', { projectId, key: e.key }, `Removing ${e.key}`)
                }
              >
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form action={add} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field
          label="Name"
          name="key"
          required
          pattern="[A-Za-z_][A-Za-z0-9_]*"
          placeholder="API_KEY"
        />
        <Field label="Value" name="value" required type="password" autoComplete="off" />
        <Button type="submit">Save</Button>
        <label className="flex items-center gap-2 text-sm sm:col-span-3">
          <input type="checkbox" name="secret" defaultChecked className="size-4" />
          Keep it secret: stored encrypted, never shown again
        </label>
      </form>
      <details className="text-sm">
        <summary className="cursor-pointer">Import a .env file, or download these settings</summary>
        <form action={importFile} className="mt-3 grid gap-3">
          <label htmlFor="dotenv">Paste the contents of a .env file</label>
          <textarea
            id="dotenv"
            name="dotenv"
            rows={6}
            spellCheck={false}
            autoComplete="off"
            placeholder={'DATABASE_URL=postgres://…\nLOG_LEVEL=info'}
            className="rounded-md border border-border bg-surface-raised p-2 font-mono text-sm"
          />
          <label className="flex items-center gap-2">
            <input type="checkbox" name="secret" defaultChecked className="size-4" />
            Keep every value secret: stored encrypted, never shown again
          </label>
          {problems.length > 0 && (
            <ul role="alert" className="grid gap-1 text-status-failed">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit">Import</Button>
            <Button
              type="button"
              variant="secondary"
              disabled={spec.runtime.env.length === 0}
              onClick={() => {
                save('.env', toDotenv(spec.runtime.env));
              }}
            >
              Download as .env
            </Button>
          </div>
          <p className="text-muted-foreground">
            The download leaves out values stored encrypted: their lines are there, empty.
          </p>
        </form>
      </details>
    </Section>
  );
}

interface DomainCheck {
  host: string;
  status: string;
  message: string;
  instructions: { type: string; name: string; value: string; zone: string }[];
  /** The certificate the server holds for it, once it has one (§30 ⑦). */
  certificate: { notAfter: string; renewing: boolean } | null;
  /** Set on a www or bare twin: the address it sends visitors to (§30 ⑤). */
  twinOf: string | null;
  /** When DNS is looked at again. */
  nextCheckAt: string;
}

/**
 * When VDeploy looks at a name's DNS again (§30 ⑤). A countdown rather
 * than a retry button: asking Let's Encrypt early is what locks a domain
 * out for an hour, and VDeploy asks only once the name points here.
 */
function NextLook({ at }: { at: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(tick);
    };
  }, []);
  return (
    <p className="text-muted-foreground" aria-live="polite">
      DNS changes can take a while to reach everyone. VDeploy looks again{' '}
      {countdownWords(Date.parse(at) - now)}, and asks for the certificate only once it points here
      — asking early is how a domain gets locked out for an hour.
    </p>
  );
}

/** "until 3 December 2026", in the reader's own words for dates. */
function untilWords(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

const DOMAIN_LOOK: Record<string, { health: Health; label: string }> = {
  verified: { health: 'healthy', label: 'Pointing here' },
  pending: { health: 'neutral', label: 'Checking' },
  missing: { health: 'warning', label: 'Needs a DNS record' },
  misdirected: { health: 'failed', label: 'Points elsewhere' },
  proxied: { health: 'warning', label: 'Behind a proxy' },
  apex_cname: { health: 'failed', label: 'Record not allowed' },
  no_server_address: { health: 'warning', label: 'Server address unknown' },
};

/** Domains, each with whether it points here and exactly which record to add if not (§13). */
export function DomainsSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  const [checks, setChecks] = useState<DomainCheck[] | null>(null);
  const hosts = spec.network?.domains.map((d) => d.host) ?? [];
  const waiting = checks?.some((c) => c.status !== 'verified') ?? false;

  useEffect(() => {
    const load = () => {
      void query<DomainCheck[]>('domain.status', { projectId }).then(setChecks, () => {
        setChecks([]);
      });
    };
    load();
    // While a name is not verified yet, keep the page up to date by itself.
    if (!waiting) return;
    const every = setInterval(load, 15_000);
    return () => {
      clearInterval(every);
    };
  }, [projectId, spec, waiting]);

  if (!spec.network) {
    return (
      <Section title="Domains" hint="This app has no port, so nothing can reach it from the web." />
    );
  }
  const change = (next: string[], doing: string) =>
    act('project.update_spec', { projectId, spec: withDomains(spec, next) }, doing);

  return (
    <Section
      title="Domains"
      hint="Your own addresses for this app. Each gets its HTTPS certificate once its DNS points here."
    >
      {hosts.length > 0 && checks === null && <Skeleton className="h-16" />}
      <ul className="grid gap-3">
        {hosts.map((host) => {
          const check = checks?.find((c) => c.host === host);
          const twin = checks?.find((c) => c.twinOf === host);
          const domain = spec.network?.domains.find((d) => d.host === host);
          const twinOn = domain?.twin !== false;
          const throughDns = domain?.tls?.challenge === 'dns-01';
          const look = DOMAIN_LOOK[check?.status ?? 'pending'] ?? DOMAIN_LOOK.pending;
          return (
            <li key={host} className="grid gap-2 rounded-md border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium break-all">{host}</span>
                {look && <Status health={look.health}>{look.label}</Status>}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() =>
                    void change(
                      hosts.filter((h) => h !== host),
                      `Removing ${host}`,
                    )
                  }
                >
                  Remove
                </Button>
              </div>
              {check?.message && <p>{check.message}</p>}
              {check && check.status !== 'verified' && <NextLook at={check.nextCheckAt} />}
              {check?.certificate &&
                (check.certificate.renewing ? (
                  <p className="text-muted-foreground">
                    Certificate valid until {untilWords(check.certificate.notAfter)}. It renews by
                    itself.
                  </p>
                ) : (
                  <p className="text-status-warning">
                    The certificate runs out on {untilWords(check.certificate.notAfter)} and has not
                    renewed. It should have a week ago: check that this address still points at the
                    server, and that nothing in front of it blocks port 80.
                  </p>
                ))}
              <label className="flex flex-wrap items-center gap-2 text-muted-foreground">
                <input
                  type="checkbox"
                  checked={twinOn}
                  onChange={(event) =>
                    void act(
                      'project.update_spec',
                      { projectId, spec: withTwin(spec, host, event.target.checked) },
                      event.target.checked
                        ? `Answering at ${twin?.host ?? 'its twin'} too`
                        : `No longer answering at ${twin?.host ?? 'its twin'}`,
                    )
                  }
                />
                {twin
                  ? `Also answer at ${twin.host}, and send those visitors here`
                  : 'Also answer at its www or bare address, once its DNS is found'}
                {twinOn && twin && (
                  <Status health={twin.status === 'verified' ? 'healthy' : 'neutral'}>
                    {twin.status === 'verified'
                      ? 'Sending visitors here'
                      : 'Needs its own DNS record'}
                  </Status>
                )}
              </label>
              {/* A wildcard domain can only be proved through DNS; nothing to choose. */}
              {!host.startsWith('*.') && (
                <label className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={throughDns}
                    onChange={(event) =>
                      void act(
                        'tls.configure',
                        {
                          projectId,
                          host,
                          challenge: event.target.checked ? 'dns-01' : 'http-01',
                        },
                        event.target.checked
                          ? `Proving ${host} through DNS`
                          : `Proving ${host} over HTTP`,
                      )
                    }
                  />
                  Prove its certificate through DNS — for an address behind Cloudflare&apos;s proxy.
                  Needs the DNS provider in{' '}
                  <Link href="/settings/domains" className="underline">
                    Domains &amp; certificates
                  </Link>
                  .
                </label>
              )}
              {twinOn && twin && twin.status !== 'verified' && twin.instructions.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  For {twin.host}, add{' '}
                  {twin.instructions.map((i) => `${i.type} ${i.name} → ${i.value}`).join(' and ')}{' '}
                  in {twin.instructions[0]?.zone}.
                </p>
              )}
              {check && check.status !== 'verified' && check.instructions.length > 0 && (
                <table className="w-full text-left text-xs">
                  <caption className="mb-1 text-left text-muted-foreground">
                    Add at your domain registrar:
                  </caption>
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="pr-3 font-normal">Type</th>
                      <th className="pr-3 font-normal">Name</th>
                      <th className="font-normal">Value</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {check.instructions.map((i) => (
                      <tr key={`${i.type}${i.name}${i.value}`}>
                        <td className="pr-3">{i.type}</td>
                        <td className="pr-3">{i.name}</td>
                        <td className="break-all">{i.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          );
        })}
      </ul>
      <form
        action={(form) => {
          const host = cleanHost(formText(form, 'host'));
          if (host && !hosts.includes(host)) void change([...hosts, host], `Adding ${host}`);
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="min-w-0 flex-1">
          <Field label="Add a domain" name="host" required placeholder="shop.example.com" />
        </div>
        <Button type="submit">Add</Button>
      </form>
    </Section>
  );
}

/** How big the app is: memory, and how many copies run. */
export function SizeSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  const limit = spec.runtime.resources.memory.limit;
  const choices: readonly string[] = MEMORY_CHOICES.includes(
    limit as (typeof MEMORY_CHOICES)[number],
  )
    ? MEMORY_CHOICES
    : [...MEMORY_CHOICES, limit];

  return (
    <Section
      title="Size"
      hint="Memory is a hard limit: an app that needs more is stopped. More copies share visitors, and keep the site up while one restarts."
    >
      <form
        action={(form) => {
          const memory = formText(form, 'memory');
          const replicas = Number(formText(form, 'replicas'));
          if (memory !== limit) {
            void act(
              'project.update_spec',
              { projectId, spec: withMemory(spec, memory) },
              `Giving it ${memoryWords(memory)}`,
            );
          } else if (replicas !== spec.runtime.replicas) {
            void act(
              'project.scale',
              { projectId, replicas },
              `Running ${String(replicas)} copies`,
            );
          }
        }}
        className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <div className="grid gap-1.5">
          <label htmlFor="memory" className="text-sm font-medium">
            Memory
          </label>
          <select
            id="memory"
            name="memory"
            defaultValue={limit}
            className="h-10 rounded-md border border-border bg-surface-raised px-3 text-sm"
          >
            {choices.map((m) => (
              <option key={m} value={m}>
                {memoryWords(m)}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Copies"
          name="replicas"
          type="number"
          min={1}
          max={64}
          defaultValue={spec.runtime.replicas}
        />
        <Button type="submit">Save</Button>
      </form>
    </Section>
  );
}

/**
 * Who may reach this app (§13): a password in front of it, and addresses
 * turned away. The passwords are hashed as they arrive and never kept;
 * turning a password on is two steps — the hashes are stored as a secret,
 * then the app is told to use it — and the second is an ordinary change
 * that goes through its plan like any other.
 */
export function AccessSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  const stepUp = useStepUp();
  const [people, setPeople] = useState([{ name: '', password: '' }]);
  const [error, setError] = useState<string | null>(null);
  if (!spec.network) return null;
  const middleware = spec.network.middleware ?? {};
  const guarded = middleware.auth?.type === 'basic';

  async function protect() {
    setError(null);
    const users = people.filter((p) => p.name.trim() && p.password);
    if (users.length === 0) return;
    try {
      const outcome = await stepUp(() =>
        runOperation<{ secretId: string }>('project.basic_auth', { projectId, users }),
      );
      if (outcome.status !== 'done') return;
      await act(
        'network.middleware',
        {
          projectId,
          middleware: withMiddleware(spec, {
            auth: { type: 'basic', secretRef: outcome.result.secretId },
          }),
        },
        'Asking for a password before anyone reaches it',
      );
      setPeople([{ name: '', password: '' }]);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        setError(err instanceof Error ? err.message : 'That did not work.');
      }
    }
  }

  return (
    <Section
      title="Who can reach it"
      hint="Put a password in front of it — a staging copy, a tool only your team uses — and turn away addresses that should never get in."
    >
      {guarded ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Status health="healthy">Asks for a password</Status>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void act(
                'network.middleware',
                { projectId, middleware: withMiddleware(spec, { auth: undefined }) },
                'Letting anyone reach it again',
              )
            }
          >
            Remove the password
          </Button>
        </div>
      ) : middleware.auth?.type === 'forward' ? (
        <p className="text-sm text-muted-foreground">
          Every visit is checked by {middleware.auth.address} first. Change it in the Advanced view.
        </p>
      ) : (
        <form
          action={() => {
            void protect();
          }}
          className="grid gap-3"
        >
          {people.map((person, i) => (
            <div key={i} className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Name"
                name={`name-${String(i)}`}
                value={person.name}
                onChange={(e) => {
                  setPeople(people.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)));
                }}
                autoComplete="off"
              />
              <Field
                label="Password"
                name={`password-${String(i)}`}
                type="password"
                value={person.password}
                onChange={(e) => {
                  setPeople(
                    people.map((p, j) => (j === i ? { ...p, password: e.target.value } : p)),
                  );
                }}
                autoComplete="new-password"
                hint="At least 12 characters."
              />
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setPeople([...people, { name: '', password: '' }]);
              }}
            >
              Add another person
            </Button>
            <Button type="submit">Ask for a password</Button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-status-failed">
              {error}
            </p>
          )}
        </form>
      )}
      <form
        action={(form) => {
          const list = formText(form, 'deny')
            .split(/[\s,]+/)
            .map((l) => l.trim())
            .filter(Boolean);
          void act(
            'network.middleware',
            { projectId, middleware: withMiddleware(spec, { ipDenyList: list }) },
            list.length ? 'Turning those addresses away' : 'Letting every address in',
          );
        }}
        className="grid gap-2"
      >
        <label htmlFor="deny" className="text-sm font-medium">
          Turned away
        </label>
        <textarea
          id="deny"
          name="deny"
          rows={3}
          defaultValue={(middleware.ipDenyList ?? []).join('\n')}
          placeholder={'203.0.113.7\n198.51.100.0/24'}
          className="rounded-md border border-border bg-surface-raised p-3 font-mono text-xs text-foreground"
        />
        <p className="text-xs text-muted-foreground">
          One address or range per line. They reach nothing of this app.
        </p>
        <Button type="submit" variant="secondary" className="justify-self-start">
          Save
        </Button>
      </form>
    </Section>
  );
}

/**
 * Pages that moved (§13): a path, and everything under it, sent on — to
 * another path here or another site — so old links keep working.
 */
export function MovedPagesSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  if (!spec.network) return null;
  const moved = spec.network.redirects ?? [];
  const save = (next: typeof moved, doing: string) =>
    act('project.update_spec', { projectId, spec: withMovedPaths(spec, next) }, doing);
  return (
    <Section
      title="Moved pages"
      hint="Send an old address, and everything under it, somewhere new, so links people saved keep working."
    >
      {moved.length > 0 && (
        <ul className="grid gap-2 text-sm">
          {moved.map((m) => (
            <li key={m.from} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{m.from}</span>
              <span aria-hidden>→</span>
              <span className="font-mono break-all">{m.to}</span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() =>
                  void save(
                    moved.filter((x) => x.from !== m.from),
                    `No longer sending ${m.from} on`,
                  )
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        action={(form) => {
          const from = formText(form, 'from');
          const to = formText(form, 'to');
          if (from && to) {
            void save(
              [...moved.filter((x) => x.from !== from), { from, to, permanent: true }],
              `Sending ${from} to ${to}`,
            );
          }
        }}
        className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <Field label="From" name="from" required placeholder="/old-page" />
        <Field label="To" name="to" required placeholder="/new-page or https://…" />
        <Button type="submit">Add</Button>
      </form>
    </Section>
  );
}

/** Which team owns this app (§20 Org): only its members, and admins, change it. */
export function TeamSection() {
  const { projectId, row, act } = useProject();
  const [teams, setTeams] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    void query<{ id: string; name: string }[]>('team.list').then(setTeams, () => {
      setTeams([]);
    });
  }, []);
  if (!teams?.length) return null;
  return (
    <Section
      title="Team"
      hint="An app that belongs to a team can be changed only by that team's members and by admins. Everyone can still see it."
    >
      <select
        aria-label="The team that owns this app"
        value={row.teamId ?? ''}
        onChange={(event) =>
          void act(
            'project.set_team',
            { projectId, teamId: event.target.value || null },
            'Changing its team',
          )
        }
        className="h-10 justify-self-start rounded-md border border-border bg-surface-raised px-3 text-sm"
      >
        <option value="">No team: anyone whose role allows can change it</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </Section>
  );
}

/** Holding this app's deploys (§20): nothing new goes live until it is unlocked. */
export function DeployLockSection() {
  const { projectId, row, act } = useProject();
  const lock = row.deployLock;
  return (
    <Section
      title="Deploy lock"
      hint="Locked, nothing new goes live for this app — not from a person, a push or the assistant. Going back to an earlier version, restarting and resizing still work."
    >
      {lock ? (
        <div className="grid gap-3 text-sm">
          <p>
            <Lock aria-hidden className="mr-1 inline size-4" />
            Locked by {lock.by} {new Date(lock.at).toLocaleString()}: {lock.reason}
          </p>
          <Button
            variant="secondary"
            className="justify-self-start"
            onClick={() => void act('deploy.unlock', { projectId }, 'Unlocking')}
          >
            Unlock
          </Button>
        </div>
      ) : (
        <form
          action={(form) => {
            void act('deploy.lock', { projectId, reason: formText(form, 'reason') }, 'Locking');
          }}
          className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
        >
          <Field
            label="Why"
            name="reason"
            required
            maxLength={200}
            placeholder="The launch is today"
            hint="Whoever finds it locked sees this and your name."
          />
          <Button type="submit">Lock</Button>
        </form>
      )}
    </Section>
  );
}

/** A copy of this app under a new name (§20 Projects). */
export function CloneSection() {
  const { projectId, row, act } = useProject();
  return (
    <Section
      title="Make a copy"
      hint="A new app with this one's code and settings, and its own copies of the secrets. Its domains and scheduled jobs stay with this app; the copy gets an address of its own."
    >
      <form
        action={(form) => {
          const name = formText(form, 'name').trim();
          void act('project.clone', { projectId, name }, `Making ${name}`);
        }}
        className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
      >
        <Field
          label="Name of the copy"
          name="name"
          required
          maxLength={63}
          pattern="[a-z]([a-z0-9\-]*[a-z0-9])?"
          defaultValue={`${row.name.slice(0, 58)}-copy`}
          hint="Lowercase letters, digits and hyphens."
        />
        <Button type="submit">Make a copy</Button>
      </form>
    </Section>
  );
}

/** Hands a text file to the browser to save, named as it will be used. */
function save(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Everything about this app, in files that work without VDeploy (§17.7).
 * Nobody should feel trapped: leaving should cost an afternoon.
 */
export function ExportSection() {
  const { projectId } = useProject();
  const [files, setFiles] = useState<{ name: string; content: string }[] | null>(null);
  const [failed, setFailed] = useState(false);
  return (
    <Section
      title="Take it with you"
      hint="This app as files that run without VDeploy: its settings, a Compose file, and the spec VDeploy keeps. Secrets are named, never written down."
    >
      {files === null ? (
        <Button
          variant="secondary"
          className="justify-self-start"
          onClick={() => {
            setFailed(false);
            void query<{ name: string; content: string }[]>('project.export', { projectId }).then(
              setFiles,
              () => {
                setFailed(true);
              },
            );
          }}
        >
          Prepare the files
        </Button>
      ) : (
        <div className="flex flex-wrap gap-2">
          {files.map((file) => (
            <Button
              key={file.name}
              size="sm"
              variant="secondary"
              onClick={() => {
                save(file.name, file.content);
              }}
            >
              {file.name}
            </Button>
          ))}
        </div>
      )}
      {failed && (
        <p role="alert" className="text-sm text-status-failed">
          The files could not be prepared. Try again in a moment.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Its permanent folders and databases leave as copies: download them from Backups and from
        Databases.
      </p>
    </Section>
  );
}

const EVERY_WORDS: Record<(typeof CHECK_EVERY)[number], string> = {
  '10s': 'every 10 seconds',
  '30s': 'every 30 seconds',
  '1m': 'every minute',
  '5m': 'every 5 minutes',
};

/**
 * The checks an app keeps having to pass once it has started (§18).
 *
 * They are two questions with two different answers, and the screen says
 * which is which, because choosing the wrong one is how an app gets
 * restarted in a loop while it waits for its database: **alive** means
 * "answering at all" and failing it restarts the app; **ready** means
 * "able to take visitors right now" and failing it only stops sending
 * them until it is.
 */
export function HealthSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  if (!spec.network) return null;
  const { liveness, readiness } = spec.health ?? {};
  const every = (probe: { interval?: string } | undefined, fallback: string) =>
    probe?.interval && (CHECK_EVERY as readonly string[]).includes(probe.interval)
      ? probe.interval
      : fallback;
  const select = (id: string, value: string) => (
    <select
      id={id}
      name={id}
      defaultValue={value}
      className="h-10 rounded-md border border-border bg-surface-raised px-3 text-sm"
    >
      {CHECK_EVERY.map((e) => (
        <option key={e} value={e}>
          {EVERY_WORDS[e]}
        </option>
      ))}
    </select>
  );
  return (
    <Section
      title="Health checks"
      hint="An app is checked until it first answers. These keep checking it after that; leave a path empty to turn that check off."
    >
      <form
        action={(form) => {
          void act(
            'health.configure',
            {
              projectId,
              health: withChecks(spec.health, {
                alive: formText(form, 'alive'),
                aliveEvery: formText(form, 'aliveEvery'),
                ready: formText(form, 'ready'),
                readyEvery: formText(form, 'readyEvery'),
              }),
            },
            'Changing its health checks',
          );
        }}
        className="grid gap-4"
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field
            label="Is it still alive?"
            name="alive"
            placeholder="/health"
            defaultValue={liveness?.path ?? ''}
            hint="If this stops answering three times in a row, the app is restarted."
          />
          {select('aliveEvery', every(liveness, '30s'))}
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field
            label="Can it take visitors?"
            name="ready"
            placeholder="/ready"
            defaultValue={readiness?.path ?? ''}
            hint="If this says no three times in a row, visitors go to the other copies until it says yes. It is not restarted."
          />
          {select('readyEvery', every(readiness, '10s'))}
        </div>
        <Button type="submit" className="justify-self-start">
          Save
        </Button>
      </form>
    </Section>
  );
}

const WAIT_WORDS: Record<string, string> = {
  '30s': '30 seconds',
  '1m': 'a minute',
  '5m': '5 minutes',
};

/** How visitors are shared between an app's copies (§13). */
export function LoadBalancingSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  if (!spec.network) return null;
  const lb = spec.network.loadBalancer;
  const wait = lb?.responseTimeout ?? '';
  const waits: string[] = [...WAIT_CHOICES];
  if (wait && !waits.includes(wait)) waits.push(wait);
  return (
    <Section
      title="Load balancing"
      hint="How visitors are shared between the copies of this app, and how long it has to answer them."
    >
      <form
        action={(form) => {
          void act(
            'loadbalancer.configure',
            {
              projectId,
              loadBalancer: withLoadBalancing(lb, {
                sticky: form.get('sticky') === 'on',
                retry: form.get('retry') === 'on',
                wait: formText(form, 'wait'),
              }),
            },
            'Changing how visitors are shared',
          );
        }}
        className="grid gap-4"
      >
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="sticky"
            defaultChecked={lb?.sticky?.enabled ?? false}
            className="mt-1"
          />
          <span>
            Keep each visitor on the same copy
            <span className="block text-muted-foreground">
              For apps that keep sign-ins or carts in memory rather than in a database.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="retry" defaultChecked={!!lb?.retry} className="mt-1" />
          <span>
            Try another copy when one cannot be reached
            <span className="block text-muted-foreground">
              Only a request that never arrived is sent again, so nothing is done twice.
            </span>
          </span>
        </label>
        <div className="grid gap-1 text-sm">
          <label htmlFor="wait">Give up on a request that has not started answering after</label>
          <select
            id="wait"
            name="wait"
            defaultValue={wait}
            className="h-10 justify-self-start rounded-md border border-border bg-surface-raised px-3"
          >
            <option value="">No limit</option>
            {waits.map((w) => (
              <option key={w} value={w}>
                {WAIT_WORDS[w] ?? w}
              </option>
            ))}
          </select>
          <span className="text-muted-foreground">
            Live streams and WebSockets start answering at once, so a limit never cuts them off.
          </span>
        </div>
        <Button type="submit" className="justify-self-start">
          Save
        </Button>
      </form>
    </Section>
  );
}

/**
 * Which server compiles this app (§15).
 *
 * The reason this is worth a setting: a build is the heaviest thing a
 * small box ever does, and a production machine that compiles is a
 * production machine that goes slow on the evening somebody deploys.
 * Sending the build elsewhere is the cheapest way to never have that
 * happen. The image then travels back, checked on the way, and the deploy
 * does not count as built until it has arrived.
 */
export function BuildServerSection() {
  const { projectId, row, act } = useProject();
  const [servers, setServers] = useState<ServerSummary[] | null>(null);
  const current = row.spec.build?.builder ?? '';

  useEffect(() => {
    void query<ServerSummary[]>('server.list').then(
      (list) => {
        setServers(list.filter((s) => s.status !== 'pending'));
      },
      () => {
        setServers([]);
      },
    );
  }, []);

  // An app running an image somebody else built is not compiled at all.
  if (row.spec.build?.strategy === 'image') return null;
  const elsewhere = servers?.filter((s) => s.id !== row.serverId) ?? [];
  return (
    <Section
      title="Where it is built"
      hint="A build is the heaviest thing a small server does. It does not have to happen on the one serving your site."
    >
      {servers === null && <Skeleton className="h-10" />}
      {servers !== null && elsewhere.length === 0 && (
        <p className="text-sm text-muted-foreground">
          This is your only server, so it builds here. Add a second one — there is a “building only”
          choice when you do — and this app can be compiled there instead.
        </p>
      )}
      {elsewhere.length > 0 && (
        <div className="grid gap-3">
          <select
            aria-label="Build on"
            value={current}
            onChange={(e) => {
              void act(
                'build.configure',
                { projectId, builder: e.target.value === '' ? null : e.target.value },
                'Changing where it is built',
              );
            }}
            className="h-10 max-w-sm rounded-md border border-border bg-surface-raised px-3 text-sm"
          >
            <option value="">On the server that runs it</option>
            {elsewhere.map((s) => (
              <option key={s.id} value={s.id}>
                On {s.name}
                {s.role === 'builder' ? ' (a build server)' : ''}
              </option>
            ))}
          </select>
          {current !== '' && (
            <p className="text-sm text-muted-foreground">
              The image is built there and copied here before the new version starts. If the copy
              does not arrive whole, the deploy fails and what is running keeps running.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

/**
 * Which server the app runs on, and moving it to another (§17.6).
 *
 * A move is not a setting: it stops the app, copies its files across and
 * starts it again somewhere else. So it says that, and goes through
 * approval like anything else that can lose data — the copy it takes first
 * is what makes it safe, and the folders it leaves behind are what make it
 * reversible.
 */
export function ServerSection() {
  const { projectId, row, act } = useProject();
  const [servers, setServers] = useState<ServerSummary[] | null>(null);
  const [moveTo, setMoveTo] = useState('');

  useEffect(() => {
    void query<ServerSummary[]>('server.list').then(
      (list) => {
        // A builder compiles and an edge routes; neither runs an app, so
        // neither is somewhere an app can be moved to.
        setServers(
          list.filter(
            (s) =>
              s.status !== 'pending' &&
              s.id !== row.serverId &&
              (s.role === undefined || s.role === 'apps'),
          ),
        );
      },
      () => {
        setServers([]);
      },
    );
  }, [row.serverId]);

  const here = servers === null ? null : servers.length === 0 ? [] : servers;
  return (
    <Section
      title="Where it runs"
      hint="Its files are on that server's disk, so moving it means copying them across."
    >
      {here === null && <Skeleton className="h-10" />}
      {here?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          This is your only server, so there is nowhere else to put it.
        </p>
      )}
      {here && here.length > 0 && (
        <div className="grid gap-3">
          <select
            aria-label="Move to"
            value={moveTo}
            onChange={(e) => {
              setMoveTo(e.target.value);
            }}
            className="h-10 max-w-sm rounded-md border border-border bg-surface-raised px-3 text-sm"
          >
            <option value="">Leave it where it is</option>
            {here.map((s) => (
              <option key={s.id} value={s.id}>
                Move to {s.name}
              </option>
            ))}
          </select>
          {moveTo !== '' && (
            <>
              <p className="text-sm text-muted-foreground">
                The app stops, a copy of its files is taken and put back on the other server, and it
                starts there. Its files stay on this server too until you delete them.
              </p>
              <Button
                variant="danger"
                size="sm"
                className="justify-self-start"
                onClick={() =>
                  void act('project.move', { projectId, serverId: moveTo }, 'Moving the app')
                }
              >
                Move it
              </Button>
            </>
          )}
        </div>
      )}
    </Section>
  );
}

interface StorageStatus {
  /** What each holds as the server last measured it, and the size it was given. */
  folders: { name: string; path: string; sizeBytes: number | null; limit: string | null }[];
  flagged: { path: string; why: string; status: 'permanent' | 'temporary' | 'unprotected' }[];
  unsaved: { path: string; files: number; status: 'temporary' | 'unprotected' }[];
}

/** Where the app keeps files, and folders whose files the next deploy would delete (§17.2). */
export function StorageSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [snapshots, setSnapshots] = useState<BackupSummary[]>([]);

  useEffect(() => {
    void query<StorageStatus>('storage.status', { projectId }).then(setStatus, () => undefined);
    void query<BackupSummary[]>('backup.list')
      .then((all) => {
        setSnapshots(all.filter((backup) => backup.projectId === projectId));
      })
      .catch(() => undefined);
  }, [projectId, spec]);

  const atRisk = [
    ...(status?.unsaved ?? [])
      .filter((u) => u.status === 'unprotected')
      .map((u) => ({
        path: u.path,
        why: `${String(u.files)} files written there by the running app`,
      })),
    ...(status?.flagged ?? []).filter((f) => f.status === 'unprotected'),
  ].filter((item, i, all) => all.findIndex((x) => x.path === item.path) === i);

  return (
    <Section
      title="Files"
      hint="Files an app writes are deleted on every deploy, unless they are in a permanent folder."
    >
      {status === null && <Skeleton className="h-12" />}
      {status && status.folders.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {status.folders.map((f) => (
            <li key={f.name} className="flex flex-wrap items-center gap-2">
              <Status health="healthy">Permanent</Status>
              <span className="font-mono">{f.path}</span>
              {f.sizeBytes !== null && (
                <span className="text-muted-foreground">
                  {f.sizeBytes > 0 ? `holds ${sizeWords(f.sizeBytes)}` : 'empty'}
                  {f.limit ? `, given ${memoryWords(f.limit)}` : ''}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {atRisk.map((item) => (
        <div
          key={item.path}
          className="grid gap-2 rounded-md border border-status-warning p-3 text-sm"
        >
          <p>
            <span className="font-mono">{item.path}</span>: {item.why}. The next deploy deletes
            these files.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() =>
                void act(
                  'storage.make_persistent',
                  { projectId, mountPath: item.path },
                  `Keeping the files in ${item.path}`,
                )
              }
            >
              Keep these files
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void act(
                  'storage.ignore_path',
                  { projectId, path: item.path },
                  `Marking ${item.path} temporary`,
                )
              }
            >
              They are temporary
            </Button>
          </div>
        </div>
      ))}
      {status?.folders.length === 0 && atRisk.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No permanent folders, and nothing the app writes looks worth keeping.
        </p>
      )}
      {status && status.folders.length > 0 && (
        <div className="grid gap-2 border-t border-border pt-4">
          <p className="text-sm text-muted-foreground">
            A copy of these folders is kept before anything that could lose them. You can also keep
            one now, and put any of them back.
          </p>
          <Button
            size="sm"
            variant="secondary"
            className="justify-self-start"
            onClick={() => void act('volume.snapshot', { projectId }, 'Keeping a copy')}
          >
            Keep a copy now
          </Button>
          <ul className="grid gap-1 text-sm">
            {snapshots.slice(0, 5).map((snapshot) => (
              <li key={snapshot.id} className="flex flex-wrap items-center gap-2">
                <span>{ago(snapshot.finishedAt ?? snapshot.startedAt)}</span>
                <span className="text-muted-foreground">
                  {snapshot.status === 'done' && snapshot.verified
                    ? `${sizeWords(snapshot.sizeBytes)}, ${snapshot.volumes.join(', ')}`
                    : snapshot.status === 'failed'
                      ? (snapshot.error ?? 'it did not work')
                      : 'being kept…'}
                </span>
                {snapshot.status === 'done' && snapshot.verified && (
                  <button
                    type="button"
                    className="text-accent underline"
                    onClick={() =>
                      void act(
                        'volume.restore',
                        { projectId, snapshotId: snapshot.id },
                        'Putting the files back',
                      )
                    }
                  >
                    Put these files back
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

/**
 * Scheduled jobs and one-off commands (§17.6). A job runs **once** when its
 * time comes, not once per copy of the app — which is the difference
 * between one nightly report and three.
 */
export function ScheduleSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  const [runs, setRuns] = useState<TaskView[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void query<TaskView[]>('task.list', { projectId }).then(setRuns, () => undefined);
  }, [projectId, spec]);

  const crons = spec.schedule?.crons ?? [];
  return (
    <Section
      title="Scheduled jobs"
      hint="A job runs once when its time comes, however many copies of the app are running."
    >
      {crons.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground">Nothing is scheduled.</p>
      )}
      <ul className="grid gap-2 text-sm">
        {crons.map((cron) => (
          <li key={cron.name} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{cron.name}</span>
            <span className="font-mono text-xs">{cron.command.join(' ')}</span>
            <span className="text-muted-foreground">
              {cron.expr} ({cron.timezone})
            </span>
            <button
              type="button"
              className="text-accent underline"
              onClick={() =>
                void act('cron.delete', { projectId, name: cron.name }, `Removing ${cron.name}`)
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {adding ? (
        <form
          className="grid gap-3"
          action={(form) => {
            setAdding(false);
            void act(
              'cron.create',
              {
                projectId,
                cron: {
                  name: formText(form, 'name'),
                  command: formText(form, 'command').split(/\s+/).filter(Boolean),
                  expr: formText(form, 'expr'),
                  timezone: formText(form, 'timezone') || 'UTC',
                },
              },
              'Adding the job',
            );
          }}
        >
          <Field label="Name" name="name" required placeholder="nightly-report" />
          <Field
            label="Command"
            name="command"
            required
            placeholder="node jobs/report.js"
            hint="Run in a copy of this app, with its settings and its folders."
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="When"
              name="expr"
              required
              placeholder="0 3 * * *"
              hint="Minute, hour, day, month, weekday."
            />
            <Field
              label="Timezone"
              name="timezone"
              defaultValue="UTC"
              hint="“3 in the morning” means yours, not the server’s."
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              Add it
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setAdding(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          className="justify-self-start"
          onClick={() => {
            setAdding(true);
          }}
        >
          Schedule a job
        </Button>
      )}

      <form
        className="grid gap-2 border-t border-border pt-4"
        action={(form) => {
          const command = formText(form, 'once').split(/\s+/).filter(Boolean);
          if (command.length === 0) return;
          void act('task.run', { projectId, command }, `Running ${command.join(' ')}`);
        }}
      >
        <Field
          label="Run something once"
          name="once"
          placeholder="node jobs/backfill.js"
          hint="Runs in a copy of this app. Nobody can tell from outside what a command does, so this one asks first."
        />
        <Button type="submit" size="sm" variant="secondary" className="justify-self-start">
          Run it
        </Button>
      </form>

      {runs.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {runs.slice(0, 8).map((run) => (
            <li key={run.id} className="flex flex-wrap items-center gap-2">
              <Status
                health={
                  run.status === 'done' ? 'healthy' : run.status === 'failed' ? 'failed' : 'neutral'
                }
              >
                {run.status === 'done' ? 'Ran' : run.status === 'failed' ? 'Failed' : 'Running'}
              </Status>
              <span className="font-mono text-xs">{run.command.join(' ')}</span>
              {run.name && <span className="text-muted-foreground">{run.name}</span>}
              <span className="text-muted-foreground">{ago(run.startedAt)}</span>
              {run.error && <span className="text-status-failed">{run.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

interface PreviewSettings {
  enabled: boolean;
  fromForks: boolean;
  max: number;
  expireAfterDays: number;
}

interface PreviewView {
  id: string;
  name: string;
  pullRequest: { number: number; title: string; branch: string; url?: string };
  url: string | null;
  running: boolean;
}

/**
 * A copy of this app per pull request (§26 M6, ADR 0020).
 *
 * Off until somebody turns it on, because it builds and runs code on your
 * servers every time somebody opens a pull request. The two settings that
 * matter are here and nothing else is: how many at once, and previews
 * from forks — which is the one that hands this app's settings to
 * somebody else's code, so it says exactly that.
 */
export function PreviewsSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  const [previews, setPreviews] = useState<PreviewView[] | null>(null);
  /**
   * What was asked for, until the spec says it happened.
   *
   * A box bound straight to the spec springs back the moment it is
   * ticked — the change is a plan, and the plan takes a few seconds —
   * so the screen said "off" while the toast beside it said "turning
   * on". This holds the answer the person gave until the spec catches
   * up, and lets go if the change failed, because the spec is still
   * what is true.
   */
  const [asked, setAsked] = useState<{
    spec: EditableSpec;
    values: Partial<PreviewSettings>;
  } | null>(null);
  const stored = spec.preview ?? { enabled: false, fromForks: false, max: 5, expireAfterDays: 7 };
  // Remembered against the spec it was asked about, so a reloaded row
  // lets go of it by itself — including when the change failed, because
  // the row is reloaded either way and the spec is still what is true.
  const waiting = asked?.spec === spec ? asked.values : null;
  const preview = { ...stored, ...waiting };

  useEffect(() => {
    void query<PreviewView[]>('preview.list', { projectId }).then(setPreviews, () => {
      setPreviews([]);
    });
  }, [projectId, spec]);

  const configure = (next: Partial<PreviewSettings>, what: string) => {
    setAsked({ spec, values: { ...waiting, ...next } });
    void act('preview.configure', { projectId, preview: { ...stored, ...next } }, what);
  };

  const fromGit = spec.source?.type === 'git';
  return (
    <Section
      title="Previews"
      hint="A copy of this app for every pull request, at its own address, gone when the pull request closes."
    >
      {!fromGit ? (
        <p className="text-sm text-muted-foreground">
          Previews follow pull requests, so they need an app that deploys from a repository.
        </p>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={preview.enabled}
              disabled={waiting !== null}
              onChange={(event) => {
                configure(
                  { enabled: event.target.checked },
                  event.target.checked ? 'Turning previews on' : 'Turning previews off',
                );
              }}
            />
            Build a preview for every pull request
          </label>
          {preview.enabled && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={preview.fromForks}
                  disabled={waiting !== null}
                  onChange={(event) => {
                    configure(
                      { fromForks: event.target.checked },
                      'Changing what previews are built for',
                    );
                  }}
                />
                Also for pull requests from forks
              </label>
              <p className="text-xs text-muted-foreground">
                A preview runs with this app's settings, its API keys included. A pull request from
                a fork is somebody else's code, so turning this on is handing them over.
              </p>
              <p className="text-sm text-muted-foreground">
                At most {preview.max} at once; one nobody pushes to for {preview.expireAfterDays}{' '}
                days is taken down.
              </p>
            </>
          )}
          {previews === null && <Skeleton className="h-10" />}
          {previews?.length === 0 && preview.enabled && (
            <p className="text-sm text-muted-foreground">No pull requests are open.</p>
          )}
          <ul className="grid gap-2 text-sm">
            {previews?.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">#{row.pullRequest.number}</span>
                <span>{row.pullRequest.title}</span>
                <Status health={row.running ? 'healthy' : 'warning'}>
                  {row.running ? 'Running' : 'Stopped'}
                </Status>
                {row.url && (
                  <a className="text-accent underline" href={row.url}>
                    Open
                  </a>
                )}
                <button
                  type="button"
                  className="text-accent underline"
                  onClick={() =>
                    void act(
                      'preview.close',
                      { projectId: row.id },
                      `Taking down the preview of #${String(row.pullRequest.number)}`,
                    )
                  }
                >
                  Take down
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

interface StagingAnswer {
  staging: {
    id: string;
    name: string;
    branch: string | null;
    running: boolean;
    url: string | null;
  } | null;
  promotable?: boolean;
}

/**
 * A staging copy of this app (§26 M6, ADR 0021).
 *
 * It is made from the app and starts as a copy — its keys included, so
 * that it works the first time — and then diverges: its own secrets, its
 * own data, its own address. Promoting runs in production exactly the
 * image staging has been running, not a rebuild of the same commit.
 */
export function StagingSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  const [answer, setAnswer] = useState<StagingAnswer | null>(null);

  useEffect(() => {
    void query<StagingAnswer>('staging.get', { projectId }).then(setAnswer, () => {
      setAnswer({ staging: null });
    });
  }, [projectId, spec]);

  if (spec.source?.type !== 'git') return null;
  const staging = answer?.staging;
  return (
    <Section
      title="Staging"
      hint="A copy of this app following another branch, with its own settings and its own data."
    >
      {answer === null && <Skeleton className="h-10" />}
      {answer !== null && !staging && (
        <form
          className="grid gap-3"
          action={(form) => {
            void act(
              'staging.create',
              { projectId, branch: formText(form, 'branch').trim() },
              'Making a staging copy',
            );
          }}
        >
          <Field
            label="Branch it follows"
            name="branch"
            defaultValue="develop"
            required
            hint="It starts as a copy of this app, keys included, so it works straight away. Replace the ones that must differ."
          />
          <Button type="submit" className="justify-self-start">
            Make a staging copy
          </Button>
        </form>
      )}
      {staging && (
        <div className="grid gap-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{staging.name}</span>
            {staging.branch && <span className="text-muted-foreground">{staging.branch}</span>}
            <Status health={staging.running ? 'healthy' : 'warning'}>
              {staging.running ? 'Running' : 'Stopped'}
            </Status>
            {staging.url && (
              <a className="text-accent underline" href={staging.url}>
                Open
              </a>
            )}
          </div>
          <p className="text-muted-foreground">
            {answer.promotable
              ? 'Staging is running something this app is not. Promoting runs exactly that here — the same build, not a new one.'
              : 'This app is already running what staging is running.'}
          </p>
          <Button
            className="justify-self-start"
            disabled={!answer.promotable}
            onClick={() => void act('staging.promote', { projectId }, `Promoting ${staging.name}`)}
          >
            Promote to production
          </Button>
        </div>
      )}
    </Section>
  );
}
