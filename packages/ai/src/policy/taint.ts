import type { OperationDefinition, ReadCategory } from '@vdeploy/contracts';

/**
 * Reads whose content an attacker can write: container logs, commit messages
 * and PR titles in deploy history, repository files. Reading any of them
 * taints the session (§8 L4).
 */
const UNTRUSTED_READS: ReadonlySet<ReadCategory> = new Set([
  'logs',
  'deployHistory',
  'sourceFiles',
]);

export function taintsSession(op: OperationDefinition): boolean {
  return op.reads !== null && UNTRUSTED_READS.has(op.reads);
}

export const UNTRUSTED_MAX_LINES = 200;
export const UNTRUSTED_MAX_BYTES = 32 * 1024;

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

function sanitize(text: string): string {
  let clean = text
    .replace(ANSI, '')
    .replace(CONTROL, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  const lines = clean.split('\n');
  if (lines.length > UNTRUSTED_MAX_LINES) {
    clean = lines.slice(-UNTRUSTED_MAX_LINES).join('\n');
  }
  if (Buffer.byteLength(clean) > UNTRUSTED_MAX_BYTES) {
    clean = Buffer.from(clean).subarray(-UNTRUSTED_MAX_BYTES).toString('utf8');
  }
  // The frame must be unforgeable from inside: no content can close it.
  return clean.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attribute(value: string): string {
  return value.replace(/[^\w.-]/g, '_');
}

/**
 * Frames attacker-controllable text before it reaches a model: ANSI stripped,
 * control characters escaped, the tail kept (200 lines / 32 KB), angle
 * brackets escaped so the content cannot close its own frame.
 */
export function frameUntrusted(text: string, source: string, project: string): string {
  return `<untrusted source="${attribute(source)}" project="${attribute(project)}">\n${sanitize(text)}\n</untrusted>`;
}
