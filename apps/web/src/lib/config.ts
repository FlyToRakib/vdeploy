import { parse, stringify } from 'yaml';

/** The parts of a project spec the config screen edits; the rest is carried as it is. */
export interface EditableSpec {
  network?: {
    containerPort: number;
    domains: {
      host: string;
      tls?: { challenge?: string; [key: string]: unknown };
      twin?: boolean;
    }[];
    redirects?: MovedPath[];
    middleware?: Middleware;
    loadBalancer?: LoadBalancer;
    [key: string]: unknown;
  };
  runtime: {
    replicas: number;
    env: ({ key: string; value: string } | { key: string; secretRef: string; version?: number })[];
    resources: { memory: { limit: string; request?: string }; [key: string]: unknown };
    [key: string]: unknown;
  };
  /** Where the code comes from; only a repository can have previews. */
  source?: { type: string; [key: string]: unknown };
  /** A copy of this app per pull request (§26 M6). */
  preview?: {
    enabled: boolean;
    fromForks: boolean;
    max: number;
    expireAfterDays: number;
  };
  /** Scheduled jobs (§17.6): each runs once when its time comes. */
  schedule?: {
    crons: { name: string; command: string[]; expr: string; timezone: string }[];
  };
  /** How the platform knows the app is up, alive and ready (§18). */
  health?: { startup?: Probe; liveness?: Probe; readiness?: Probe };
  [key: string]: unknown;
}

export interface LoadBalancer {
  sticky?: { enabled: boolean; cookie?: string };
  retry?: { attempts: number };
  responseTimeout?: string;
  [key: string]: unknown;
}

/**
 * Time until the next DNS look, as a countdown a person watches (§30 ⑤):
 * "1:23" under an hour, "about 2 hours" past it, "now" once it is due.
 */
export function countdownWords(ms: number): string {
  if (ms <= 0) return 'now';
  const seconds = Math.ceil(ms / 1000);
  if (seconds >= 3600) {
    const hours = Math.round(seconds / 3600);
    return `in about ${String(hours)} hour${hours === 1 ? '' : 's'}`;
  }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `in ${String(m)}:${String(s).padStart(2, '0')}`;
}

/** How long an app may take to start answering, in the choices the form offers. */
export const WAIT_CHOICES = ['30s', '1m', '5m'] as const;

/**
 * Load balancing from the form's answers (§13). What the form does not
 * show — the health check the router runs, a circuit breaker — is kept as
 * it is; a retry keeps its number of attempts, and starts at two.
 */
export function withLoadBalancing(
  lb: LoadBalancer | undefined,
  answers: { sticky: boolean; retry: boolean; wait: string },
): LoadBalancer {
  const out: LoadBalancer = { ...lb, sticky: { ...lb?.sticky, enabled: answers.sticky } };
  delete out.retry;
  delete out.responseTimeout;
  if (answers.retry) out.retry = lb?.retry ?? { attempts: 2 };
  if (answers.wait) out.responseTimeout = answers.wait;
  return out;
}

export interface Probe {
  type: 'http' | 'tcp';
  path?: string;
  interval?: string;
  timeout?: string;
  failureThreshold?: number;
}

/** How often a check may run, in the words the form offers. */
export const CHECK_EVERY = ['10s', '30s', '1m', '5m'] as const;

/**
 * The two checks that run after an app has started, from the form's
 * answers: a path turns a check on, an empty one turns it off. The
 * startup check is kept as it is — it is set in the raw spec, because the
 * default (a connection on the app's port) is right for nearly everyone.
 */
export function withChecks(
  health: EditableSpec['health'],
  answers: { alive: string; aliveEvery: string; ready: string; readyEvery: string },
): NonNullable<EditableSpec['health']> {
  const check = (path: string, every: string, before?: Probe): Probe | undefined => {
    const trimmed = path.trim();
    if (trimmed === '') return undefined;
    return {
      ...before,
      type: 'http',
      path: trimmed.startsWith('/') ? trimmed : `/${trimmed}`,
      interval: every,
    };
  };
  const out: NonNullable<EditableSpec['health']> = {};
  if (health?.startup) out.startup = health.startup;
  const liveness = check(answers.alive, answers.aliveEvery, health?.liveness);
  const readiness = check(answers.ready, answers.readyEvery, health?.readiness);
  if (liveness) out.liveness = liveness;
  if (readiness) out.readiness = readiness;
  return out;
}

/** Memory sizes people pick from; anything else is set in the raw spec. */
export const MEMORY_CHOICES = ['128Mi', '256Mi', '512Mi', '1Gi', '2Gi', '4Gi'] as const;

/** "512Mi" → "512 MB", "1Gi" → "1 GB". */
export function memoryWords(limit: string): string {
  const m = /^(\d+(?:\.\d+)?)(Mi|Gi)$/.exec(limit);
  if (!m) return limit;
  return `${m[1] ?? ''} ${m[2] === 'Gi' ? 'GB' : 'MB'}`;
}

/** The secret a setting's value is kept in: DATABASE_URL → database_url. */
export function secretNameFor(key: string): string {
  const name = key
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, 63);
  return /^[a-z]/.test(name) ? name : `s_${name}`.slice(0, 63);
}

/** A copy of the spec with these domains; a domain with no settings gets the defaults. */
export function withDomains(spec: EditableSpec, hosts: readonly string[]): EditableSpec {
  if (!spec.network) throw new Error('This app has no port, so it cannot have a domain');
  const current = new Map(spec.network.domains.map((d) => [d.host, d]));
  return {
    ...spec,
    network: { ...spec.network, domains: hosts.map((host) => current.get(host) ?? { host }) },
  };
}

/** A copy of the spec with this memory limit; the request never exceeds it. */
/** Who may reach the app (§13): the parts of the middleware the screen edits. */
export interface Middleware {
  auth?:
    { type: 'basic'; secretRef: string; realm?: string } | { type: 'forward'; address: string };
  ipDenyList?: string[];
  [key: string]: unknown;
}

/** The middleware with one part changed, the rest kept as it is; undefined removes a part. */
export function withMiddleware(
  spec: EditableSpec,
  change: { [K in keyof Middleware]?: Middleware[K] | undefined },
): Middleware {
  const merged = { ...spec.network?.middleware, ...change };
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
}

export interface MovedPath {
  from: string;
  to: string;
  permanent?: boolean;
}

/** The app's moved pages, replaced whole (§13); a path given without its slash gets one. */
export function withMovedPaths(spec: EditableSpec, moved: readonly MovedPath[]): EditableSpec {
  if (!spec.network) throw new Error('This app has no port, so nothing can be redirected');
  const path = (p: string) => (p.startsWith('/') ? p : `/${p}`);
  return {
    ...spec,
    network: {
      ...spec.network,
      redirects: moved.map((m) => ({
        ...m,
        from: path(m.from.trim()),
        to: /^https?:\/\//.test(m.to.trim()) ? m.to.trim() : path(m.to.trim()),
      })),
    },
  };
}

/** Turns a domain's www or bare twin on or off (§30 ⑤), leaving the rest of it alone. */
export function withTwin(spec: EditableSpec, host: string, on: boolean): EditableSpec {
  if (!spec.network) throw new Error('This app has no port, so it cannot have a domain');
  return {
    ...spec,
    network: {
      ...spec.network,
      domains: spec.network.domains.map((d) => (d.host === host ? { ...d, twin: on } : d)),
    },
  };
}

export function withMemory(spec: EditableSpec, limit: string): EditableSpec {
  const { memory } = spec.runtime.resources;
  return {
    ...spec,
    runtime: {
      ...spec.runtime,
      resources: {
        ...spec.runtime.resources,
        memory: { ...memory, limit, request: smaller(memory.request, limit) },
      },
    },
  };
}

function megabytes(q: string): number {
  const m = /^(\d+(?:\.\d+)?)(Mi|Gi)$/.exec(q);
  return m ? Number(m[1]) * (m[2] === 'Gi' ? 1024 : 1) : Number.NaN;
}

function smaller(request: string | undefined, limit: string): string {
  if (!request) return limit;
  return megabytes(request) > megabytes(limit) ? limit : request;
}

/** A domain as typed: lowercase, no scheme, path or trailing dot. */
export function cleanHost(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
}

export function specToYaml(spec: unknown): string {
  return stringify(spec, { lineWidth: 0 });
}

/** The spec from YAML, or where the YAML is wrong. */
export function yamlToSpec(text: string): { spec: unknown } | { error: string } {
  try {
    const spec: unknown = parse(text);
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      return { error: 'The spec must be a set of fields, starting with apiVersion.' };
    }
    return { spec };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'That is not valid YAML.' };
  }
}
