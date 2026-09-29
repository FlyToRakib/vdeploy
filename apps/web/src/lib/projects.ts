import { uploadRule } from '@vdeploy/contracts';
import type { Health } from '@/components/ui/status';

export type ProjectHealth = 'live' | 'deploying' | 'failing' | 'down' | 'stopped' | 'new';

/** A row of `project.list`. */
export interface ProjectSummary {
  id: string;
  name: string;
  serverId: string | null;
  state: ProjectHealth;
  url: string | null;
  source: string;
  replicas: { ready: number; total: number };
  updatedAt: string;
}

export const PROJECT_STATUS: Readonly<Record<ProjectHealth, { health: Health; label: string }>> = {
  live: { health: 'healthy', label: 'Live' },
  deploying: { health: 'neutral', label: 'Deploying' },
  failing: { health: 'warning', label: 'Needs a look' },
  down: { health: 'failed', label: 'Down' },
  stopped: { health: 'neutral', label: 'Stopped' },
  new: { health: 'neutral', label: 'Not deployed yet' },
};

/** Down first, then needing a look, deploying, and the rest by name. */
export function byProjectAttention(a: ProjectSummary, b: ProjectSummary): number {
  const rank: Record<ProjectHealth, number> = {
    down: 0,
    failing: 1,
    deploying: 2,
    new: 3,
    live: 4,
    stopped: 5,
  };
  return rank[a.state] - rank[b.state] || a.name.localeCompare(b.name);
}

/** What Railpack found, in the words of the detection preview (§30 ⑥). */
export interface DetectionSummary {
  /** "Node.js 22.11.0", "Python 3.12", or null when nothing was recognised. */
  runtime: string | null;
  /** A site of static files, served as they are. */
  staticSite: boolean;
  startCommand: string | null;
  warnings: string[];
}

const RUNTIME_NAMES: Record<string, string> = {
  node: 'Node.js',
  python: 'Python',
  golang: 'Go',
  go: 'Go',
  php: 'PHP',
  ruby: 'Ruby',
  rust: 'Rust',
  java: 'Java',
  deno: 'Deno',
  bun: 'Bun',
  elixir: 'Elixir',
  staticfile: 'static files',
  shell: 'a shell script',
};

type Loose = Record<string, unknown>;
const record = (v: unknown): Loose => (typeof v === 'object' && v !== null ? (v as Loose) : {});
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Reads Railpack's report defensively: any field may be missing. */
export function describeDetection(detection: unknown): DetectionSummary {
  const d = record(detection);
  const providers = Array.isArray(d.detectedProviders)
    ? d.detectedProviders.filter((p): p is string => typeof p === 'string')
    : [];
  const provider = providers[0] ?? null;
  const packages = record(d.resolvedPackages);
  const version = provider ? text(record(packages[provider]).resolvedVersion) : null;
  const metadata = record(d.metadata);
  const staticSite =
    provider === 'staticfile' || metadata.nodeSPA === 'true' || metadata.nodeSPA === true;
  const name = provider ? (RUNTIME_NAMES[provider] ?? provider) : null;
  const deploy = record(record(d.plan).deploy);
  const logs = Array.isArray(d.logs) ? d.logs.map(record) : [];
  return {
    runtime: name ? [name, version].filter(Boolean).join(' ') : null,
    staticSite,
    startCommand: text(deploy.startCmd),
    warnings: logs
      .filter((l) => l.level === 'warn' || l.level === 'error')
      .flatMap((l) => {
        const message = text(l.msg);
        return message ? [message] : [];
      }),
  };
}

/**
 * Which files of a chosen folder to upload, relative to the folder, by the
 * rule `vdeploy up` follows too.
 */
export function uploadPlan(paths: readonly string[]): { keep: string[]; secretsLeftOut: string[] } {
  const keep: string[] = [];
  const secretsLeftOut: string[] = [];
  for (const full of paths) {
    // The browser gives "folder/sub/file"; the archive holds "sub/file".
    const path = full.split('/').slice(1).join('/');
    if (!path) continue;
    const rule = uploadRule(path);
    if (rule === 'secret') secretsLeftOut.push(path);
    else if (rule === 'keep') keep.push(path);
  }
  return { keep, secretsLeftOut };
}

export { projectName } from '@vdeploy/contracts';
