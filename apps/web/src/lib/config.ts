import { parse, stringify } from 'yaml';

/** The parts of a project spec the config screen edits; the rest is carried as it is. */
export interface EditableSpec {
  network?: {
    containerPort: number;
    domains: { host: string; tls?: unknown }[];
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
  [key: string]: unknown;
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
