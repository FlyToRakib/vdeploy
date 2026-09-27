import { ApplicationSpec, VDeployError, type DatabaseEngine } from '@vdeploy/contracts';
import { parse } from 'yaml';
import { ENGINES } from './databases.js';
import { volumeNameFor } from './spec-edit.js';

/**
 * Reading a `docker-compose.yml` (§15) — the way in from anywhere else.
 *
 * This is a **reading**, not an execution. It produces a preview: one
 * proposed project per service, one managed database per service that is
 * one, and a plain list of everything it will not carry over and why.
 * Nothing is created until a person looks at that list and agrees.
 *
 * The list matters more than the mapping. A compose file can say
 * `privileged: true`, `cap_add: SYS_ADMIN`, a host path, a host port, the
 * host's own network — things VDeploy's spec deliberately cannot express
 * (§25 L6, ADR 0003). Silently dropping them would be two failures at once:
 * an app that mysteriously does not work, and a person who believes it was
 * imported faithfully. So every one is named, in the words of what it meant.
 */

/** What an import would make, and what it would not. */
export interface ComposeImport {
  /** Services that become apps. */
  apps: ImportedApp[];
  /** Services that are a database VDeploy runs itself. */
  databases: ImportedDatabase[];
  /** Directives that will not come across, and what each one meant. */
  refused: ComposeNote[];
  /** Things carried over differently, so nothing is a surprise later. */
  changed: ComposeNote[];
}

export interface ComposeNote {
  service: string;
  what: string;
  why: string;
}

export interface ImportedApp {
  /** The service's name, made into a name VDeploy can use. */
  name: string;
  spec: ApplicationSpec;
  /** Services this one names in `depends_on` or in its settings. */
  needs: string[];
}

export interface ImportedDatabase {
  name: string;
  engine: DatabaseEngine;
  version: string;
}

/** Directives that cannot cross, with what each one actually meant. */
const REFUSED: Record<string, string> = {
  privileged: 'it asks for full control of the server, which VDeploy never grants',
  cap_add: 'it asks for kernel privileges an app does not need',
  devices: 'it asks to reach the server’s hardware directly',
  device_cgroup_rules: 'it asks to reach the server’s hardware directly',
  pid: 'it asks to see every other process on the server',
  ipc: 'it asks to share memory with the rest of the server',
  userns_mode: 'it asks to change how users are mapped on the server',
  sysctls: 'it asks to change kernel settings for the whole server',
  security_opt: 'it asks to turn off the protections around a container',
  cgroup_parent: 'it asks to place itself outside VDeploy’s limits',
  network_mode: 'it asks to use the server’s own network instead of its own',
  build: 'VDeploy builds from your source rather than from a compose build section',
  deploy: 'placement and replicas are set in VDeploy, not in the file',
  profiles: 'VDeploy runs what you import, with no profiles to switch between',
};

/** Compose images VDeploy would rather run as a managed database (§17.3). */
function engineOf(image: string): { engine: DatabaseEngine; version: string } | null {
  const [repository, tag] = splitImage(image);
  for (const [engine, profile] of Object.entries(ENGINES)) {
    if (repository !== profile.repository) continue;
    const major = (tag ?? '').split('.')[0] ?? '';
    const version = profile.versions.find((v) => v === tag || v.split('.')[0] === major);
    return { engine: engine as DatabaseEngine, version: version ?? profile.versions[0] ?? '' };
  }
  return null;
}

function splitImage(image: string): [string, string | null] {
  const at = image.indexOf('@');
  const bare = at === -1 ? image : image.slice(0, at);
  const colon = bare.lastIndexOf(':');
  // A colon inside a registry's host and port is not a tag.
  if (colon === -1 || bare.slice(colon).includes('/')) return [bare, null];
  return [bare.slice(0, colon), bare.slice(colon + 1)];
}

/** A compose service name as a name VDeploy can use in a hostname. */
function nameOf(service: string): string {
  const cleaned = service
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (cleaned === '') return 'app';
  return /^[a-z]/.test(cleaned) ? cleaned : `app-${cleaned}`;
}

/** Compose accepts a list or a map for settings; both mean the same thing. */
function settings(raw: unknown): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const push = (key: string, value: unknown) => {
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) return;
    if (value === null || value === undefined) {
      out.push({ key, value: '' });
      return;
    }
    // A scalar is a setting; anything else is compose saying something
    // VDeploy has no place to put.
    if (typeof value === 'string') out.push({ key, value });
    else if (typeof value === 'number' || typeof value === 'boolean') {
      out.push({ key, value: String(value) });
    }
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const eq = entry.indexOf('=');
      if (eq > 0) push(entry.slice(0, eq), entry.slice(eq + 1));
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) push(key, value);
  }
  return out.slice(0, 256);
}

/** The first port a service publishes, which is the one people mean. */
function portOf(service: Record<string, unknown>): number | null {
  const expose = service.expose;
  const ports = service.ports;
  const first = (list: unknown): number | null => {
    if (!Array.isArray(list)) return null;
    for (const entry of list) {
      // "8080:3000", "3000", {target: 3000}
      const text =
        typeof entry === 'string' || typeof entry === 'number'
          ? String(entry)
          : entry && typeof entry === 'object' && 'target' in entry
            ? String((entry as { target: unknown }).target)
            : '';
      const parts = text.split('/')[0]?.split(':') ?? [];
      // The container's port is the last one: "host:container" or "ip:host:container".
      const inside = Number(parts.at(-1));
      if (Number.isInteger(inside) && inside > 0 && inside < 65536) return inside;
    }
    return null;
  };
  return first(ports) ?? first(expose);
}

/**
 * Folders a service keeps. A named volume becomes a permanent folder; a
 * path on the server does not, because VDeploy's agent cannot mount one
 * (ADR 0003) — and that is said rather than quietly dropped.
 */
function folders(
  service: Record<string, unknown>,
  name: string,
  refused: ComposeNote[],
): { name: string; mountPath: string }[] {
  const out: { name: string; mountPath: string }[] = [];
  const raw = service.volumes;
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const text = typeof entry === 'string' ? entry : longForm(entry);
    const parts = text.split(':');
    if (parts.length < 2) continue;
    const [source, target] = parts;
    if (!target?.startsWith('/')) continue;
    if (source?.startsWith('/') || source?.startsWith('.') || source?.startsWith('~')) {
      refused.push({
        service: name,
        what: `the folder ${source} on the server, mounted at ${target}`,
        why: 'an app on VDeploy cannot reach the server’s own filesystem; copy what it needs into a permanent folder instead',
      });
      continue;
    }
    out.push({
      name: volumeNameFor(
        target,
        out.map((v) => v.name),
      ),
      mountPath: target,
    });
  }
  return out.slice(0, 16);
}

/** Compose also writes a mount as {source, target}; both mean the same. */
function longForm(entry: unknown): string {
  if (!entry || typeof entry !== 'object') return '';
  const { source, target } = entry as { source?: unknown; target?: unknown };
  if (typeof source !== 'string' || typeof target !== 'string') return '';
  return `${source}:${target}`;
}

/** Reads a compose file and says what importing it would make. */
export function readCompose(text: string): ComposeImport {
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    throw new VDeployError(
      'invalid_input',
      `That is not a file VDeploy can read: ${error instanceof Error ? error.message : 'it is not YAML'}`,
    );
  }
  const services = (document as { services?: unknown } | null)?.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw new VDeployError('invalid_input', 'That file has no services in it');
  }

  const result: ComposeImport = { apps: [], databases: [], refused: [], changed: [] };
  for (const [key, value] of Object.entries(services).slice(0, 32)) {
    if (!value || typeof value !== 'object') continue;
    const service = value as Record<string, unknown>;
    const name = nameOf(key);

    for (const [directive, why] of Object.entries(REFUSED)) {
      if (service[directive] !== undefined) {
        result.refused.push({ service: name, what: directive, why });
      }
    }

    const image = typeof service.image === 'string' ? service.image : '';
    if (!image) {
      result.refused.push({
        service: name,
        what: 'no image',
        why: 'this service is built from a Dockerfile; bring its source to VDeploy as a project of its own',
      });
      continue;
    }

    const engine = engineOf(image);
    if (engine) {
      // A database is not a project (ADR 0011): VDeploy runs it itself, with
      // a password it makes, on a network nothing else can reach.
      result.databases.push({ name, engine: engine.engine, version: engine.version });
      result.changed.push({
        service: name,
        what: `it becomes a managed ${engine.engine} database, not an app`,
        why: 'VDeploy backs it up, checks those backups and keeps it off the internet',
      });
      continue;
    }

    const port = portOf(service);
    if (Array.isArray(service.ports) && service.ports.length > 0) {
      result.changed.push({
        service: name,
        what: 'its published port is not published on the server',
        why: 'VDeploy gives every app an address of its own instead, and nothing else on the server is exposed',
      });
    }
    const volumes = folders(service, name, result.refused);
    result.apps.push({
      name,
      needs: dependsOn(service),
      spec: ApplicationSpec.parse({
        apiVersion: 'vdeploy/v1',
        kind: 'Application',
        metadata: { name },
        source: { type: 'image', image },
        build: { strategy: 'image' },
        runtime: {
          env: settings(service.environment),
          volumes,
        },
        ...(port ? { network: { containerPort: port } } : {}),
      }),
    });
  }

  if (result.apps.length === 0 && result.databases.length === 0) {
    throw new VDeployError('invalid_input', 'Nothing in that file could be brought across');
  }
  return result;
}

function dependsOn(service: Record<string, unknown>): string[] {
  const raw = service.depends_on;
  const names = Array.isArray(raw)
    ? raw.filter((n): n is string => typeof n === 'string')
    : raw && typeof raw === 'object'
      ? Object.keys(raw)
      : [];
  return names.map(nameOf).slice(0, 16);
}
