import type { ApplicationSpec } from '@vdeploy/contracts';
import { stringify } from 'yaml';

/** What an export needs beyond the spec: names for the ids it refers to. */
export interface ExportInput {
  spec: ApplicationSpec;
  /** What the current release runs, when there is one. */
  image: string | null;
  /** Secret id → its name, for the settings that are secrets. */
  secretNames: Record<string, string>;
  /** The databases it reads, and the setting each arrives in. */
  databases: { name: string; engine: string; as: string }[];
}

export interface ExportFile {
  name: string;
  content: string;
}

/**
 * Everything about an app, in files that work without VDeploy (§17.7):
 * the spec as VDeploy keeps it, a Compose file that runs the same thing,
 * and the settings it needs. Leaving should cost an afternoon, not a
 * rewrite — "no lock-in by obscurity" is a large part of why anybody
 * trusts a tool with their data.
 *
 * Secret values are never in it. They are named, and left for the person
 * to fill in: an export is a file that gets emailed and committed, and
 * the undo of a leaked password is not a thing this can offer.
 */
export function exportProject(input: ExportInput): ExportFile[] {
  const name = input.spec.metadata.name;
  return [
    { name: `${name}.vdeploy.yaml`, content: specFile(input.spec) },
    { name: 'compose.yaml', content: composeFile(input) },
    { name: '.env', content: envFile(input) },
  ];
}

function specFile(spec: ApplicationSpec): string {
  return `# ${spec.metadata.name}, as VDeploy keeps it. Another VDeploy reads this as it is;
# its secrets are referred to by id, and their names are in .env.\n${stringify(spec)}`;
}

/** 512Mi → 512M, 1Gi → 1G: Compose's spelling of the same amounts. */
function composeMemory(limit: string): string {
  return limit.replace(/i$/, '');
}

/** What builds or pulls the app outside VDeploy, and what a person has to know about it. */
function origin(input: ExportInput): { service: Record<string, unknown>; notes: string[] } {
  const { spec } = input;
  const { source, build } = spec;
  const name = spec.metadata.name;
  if (source.type === 'image') {
    // The digest that is running, when there is one, rather than a tag that may have moved.
    const pinned = input.image?.includes('@sha256:') ? input.image : source.image;
    return { service: { image: pinned }, notes: [] };
  }
  const dockerfileBuild = (context: string) => ({
    build: {
      context,
      ...(build.dockerfile ? { dockerfile: build.dockerfile } : {}),
      ...(build.target ? { target: build.target } : {}),
      ...(Object.keys(build.args).length ? { args: build.args } : {}),
    },
  });
  if (source.type === 'git') {
    const host = (source.host ?? 'https://github.com').replace(/\/$/, '');
    const repo = `${host}/${source.repo}.git#${source.branch}`;
    if (build.strategy === 'dockerfile') {
      const context = build.context === '.' ? repo : `${repo}:${build.context}`;
      return { service: dockerfileBuild(context), notes: [] };
    }
    return {
      service: { image: name },
      notes: [
        `Built by Railpack from ${repo}, which needs no Dockerfile. Build the image first:`,
        `  git clone ${host}/${source.repo}.git && railpack build ${source.repo.split('/').pop() ?? '.'} --name ${name}`,
      ],
    };
  }
  // An upload, or a template: the files are the person's own.
  if (build.strategy === 'dockerfile') {
    return {
      service: dockerfileBuild(`./${name}`),
      notes: [`Put the folder you uploaded next to this file, as ./${name}.`],
    };
  }
  return {
    service: { image: name },
    notes: [
      `Built by Railpack from the folder you uploaded. Put it next to this file and build it first:`,
      `  railpack build ./${name} --name ${name}`,
    ],
  };
}

function composeFile(input: ExportInput): string {
  const { spec } = input;
  const name = spec.metadata.name;
  const { service, notes } = origin(input);
  const rt = spec.runtime;
  const environment: Record<string, string> = {};
  for (const e of rt.env) {
    // Secrets come from .env, which Compose reads from beside this file.
    // A plain value's own $ is doubled, or Compose would read it as a variable.
    environment[e.key] = 'value' in e ? e.value.replaceAll('$', '$$$$') : `\${${e.key}}`;
  }
  for (const db of input.databases) environment[db.as] = `\${${db.as}}`;
  const port = spec.network?.containerPort;
  Object.assign(service, {
    ...(rt.command ? { command: rt.command } : {}),
    ...(rt.user ? { user: rt.user } : {}),
    restart: rt.restartPolicy,
    ...(Object.keys(environment).length ? { environment } : {}),
    ...(port ? { ports: [`${String(port)}:${String(port)}`] } : {}),
    ...(rt.volumes.length ? { volumes: rt.volumes.map((v) => `${v.name}:${v.mountPath}`) } : {}),
    deploy: {
      replicas: rt.replicas,
      resources: {
        limits: {
          memory: composeMemory(rt.resources.memory.limit),
          cpus: String(rt.resources.cpu.limit),
        },
      },
    },
  });
  const document = {
    services: { [name]: service },
    ...(rt.volumes.length
      ? { volumes: Object.fromEntries(rt.volumes.map((v) => [v.name, {}])) }
      : {}),
  };
  const header = [
    `${name}, as a Compose file: the same image or source, settings, permanent folders and limits.`,
    ...notes,
    ...(spec.network?.domains.length
      ? [
          `It answered at ${spec.network.domains.map((d) => d.host).join(', ')}; Compose does not`,
          'route addresses or get certificates, so put a proxy such as Caddy in front of it.',
        ]
      : []),
    ...input.databases.map(
      (db) =>
        `${db.as} pointed at the ${db.engine} database ${db.name}: restore its dump and put its address in .env.`,
    ),
    ...(rt.volumes.length
      ? ['Its permanent folders start empty here: restore them from a copy taken in VDeploy.']
      : []),
  ];
  return `${header.map((line) => `# ${line}`).join('\n')}\n${stringify(document)}`;
}

/** A value as .env reads it: bare when it is simple, quoted with escapes when not. */
function envValue(value: string): string {
  return /^[\w./:@+-]*$/.test(value) ? value : JSON.stringify(value);
}

function envFile(input: ExportInput): string {
  const lines = [
    `# Settings for ${input.spec.metadata.name}. Secrets are named and left empty:`,
    '# VDeploy never puts a secret value in an export. Fill them in before starting it.',
  ];
  for (const e of input.spec.runtime.env) {
    if ('value' in e) {
      lines.push(`${e.key}=${envValue(e.value)}`);
    } else {
      lines.push(`# secret: ${input.secretNames[e.secretRef] ?? 'no longer exists'}`, `${e.key}=`);
    }
  }
  for (const db of input.databases) {
    lines.push(`# the address of the ${db.engine} database ${db.name}`, `${db.as}=`);
  }
  return `${lines.join('\n')}\n`;
}
