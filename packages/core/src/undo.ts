import type { ApplicationSpec } from '@vdeploy/contracts';
import { diffSpecs } from './diff.js';

/** One side of the last change: the release, as far as undoing it cares. */
export interface ChangeSide {
  spec: ApplicationSpec;
  image: string;
  secretVersions: Record<string, number>;
}

/** "512Mi" → "512 MB"; anything else as written. */
function memory(limit: unknown): string {
  const m = /^(\d+(?:\.\d+)?)(Mi|Gi)$/.exec(String(limit));
  return m ? `${m[1] ?? ''} ${m[2] === 'Gi' ? 'GB' : 'MB'}` : String(limit);
}

const list = (names: string[]) => names.join(', ');

/** The parts of the spec a person thinks in, and what each is called. */
const AREAS: [prefix: string, words: string][] = [
  ['health', 'Its health checks'],
  ['deploy', 'How a new version replaces the old one'],
  ['build', 'How it is built'],
  ['source', 'Where its code comes from'],
  ['network.middleware', 'How traffic reaches it'],
  ['network.loadBalancer', 'How traffic is shared between its copies'],
  ['schedule', 'Its scheduled jobs'],
  ['scaling', 'When it adds or removes copies'],
  ['runtime.command', 'The command it starts with'],
  ['runtime.resources.cpu', 'How much processor it may use'],
];

/**
 * What the last change to an app did, in words somebody can weigh before
 * undoing it (§30 ⑦, §31 #9). "network.domains changed" is useless to the
 * person this is for; "Added the address shop.example.com" is not.
 *
 * Settings are named and never shown: a value typed into one could be a
 * password, and the undo button is not the place to learn that.
 */
export function changeWords(before: ChangeSide, after: ChangeSide): string[] {
  const lines: string[] = [];
  const said = new Set<string>();
  const once = (key: string, line: string) => {
    if (said.has(key)) return;
    said.add(key);
    lines.push(line);
  };
  if (before.image !== after.image) once('image', 'A new version of its code');

  for (const change of diffSpecs(before.spec, after.spec)) {
    const { path } = change;
    if (path === 'runtime.resources.memory.limit') {
      once(path, `Memory ${memory(change.before)} → ${memory(change.after)}`);
    } else if (path === 'runtime.replicas') {
      once(path, `Copies ${String(change.before)} → ${String(change.after)}`);
    } else if (path === 'network.containerPort') {
      once(path, `The port it answers on ${String(change.before)} → ${String(change.after)}`);
    } else if (path === 'network.domains') {
      const hosts = (value: unknown) =>
        new Set(((value ?? []) as { host: string }[]).map((d) => d.host));
      const was = hosts(change.before);
      const is = hosts(change.after);
      const added = [...is].filter((h) => !was.has(h));
      const removed = [...was].filter((h) => !is.has(h));
      if (added.length) once('domains+', `Added the address ${list(added)}`);
      if (removed.length) once('domains-', `Removed the address ${list(removed)}`);
      if (!added.length && !removed.length) once(path, 'How its addresses get certificates');
    } else if (path === 'runtime.env') {
      const keyed = (value: unknown) =>
        new Map(((value ?? []) as { key: string }[]).map((e) => [e.key, JSON.stringify(e)]));
      const was = keyed(change.before);
      const is = keyed(change.after);
      const added = [...is.keys()].filter((k) => !was.has(k));
      const removed = [...was.keys()].filter((k) => !is.has(k));
      const changed = [...is.keys()].filter((k) => was.has(k) && was.get(k) !== is.get(k));
      if (added.length) once('env+', `Added the setting ${list(added)}`);
      if (changed.length) once('env~', `Changed the setting ${list(changed)}`);
      if (removed.length) once('env-', `Removed the setting ${list(removed)}`);
    } else if (path === 'runtime.volumes') {
      const folders = (value: unknown) =>
        new Set(((value ?? []) as { mountPath: string }[]).map((v) => v.mountPath));
      const was = folders(change.before);
      const is = folders(change.after);
      const added = [...is].filter((f) => !was.has(f));
      const removed = [...was].filter((f) => !is.has(f));
      if (added.length) once('volumes+', `Made ${list(added)} a permanent folder`);
      if (removed.length) once('volumes-', `Stopped keeping ${list(removed)}`);
    } else {
      const area = AREAS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}.`));
      once(area?.[0] ?? path, area?.[1] ?? `The setting ${path}`);
    }
  }

  const secrets = new Set([
    ...Object.keys(before.secretVersions),
    ...Object.keys(after.secretVersions),
  ]);
  if ([...secrets].some((id) => before.secretVersions[id] !== after.secretVersions[id])) {
    once('secrets', 'A secret value it reads');
  }
  return lines;
}
