/** A line of an app's output, as the log stream sends it. */
export interface LogLine {
  container: string;
  stream: 'out' | 'err';
  time: string;
  text: string;
}

/** How many lines the viewer keeps; older ones fall off the top. */
export const MAX_LINES = 5000;

/** New lines appended, the oldest dropped past `max`. */
export function appendLines(
  buffer: readonly LogLine[],
  lines: readonly LogLine[],
  max = MAX_LINES,
) {
  const next = buffer.concat(lines);
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Lines containing the words searched for, case-insensitively; all of them when empty. */
export function filterLines(lines: readonly LogLine[], search: string): readonly LogLine[] {
  const needle = search.trim().toLowerCase();
  return needle ? lines.filter((l) => l.text.toLowerCase().includes(needle)) : lines;
}

/** The copy that goes into a downloaded .log file. */
export function asText(lines: readonly LogLine[]): string {
  return lines.map((l) => `${l.time} ${l.container} ${l.stream} ${l.text}`).join('\n');
}

/** Which copy a line came from: "copy 2 of version 5", not a container name. */
export function replicaLabel(container: string): string {
  const m = /-v(\d+)-r\d+-(\d+)$/.exec(container);
  return m ? `v${m[1]} #${Number(m[2]) + 1}` : container;
}

const EVENT_WORDS: Record<string, string> = {
  created: 'Started a copy',
  removed: 'Removed an old copy',
  stopped: 'Stopped',
  healed: 'Restarted after a crash',
  failed: 'Failed',
  refused: 'Refused',
  released: 'Release command ran',
  moved: 'Moved files into a permanent folder',
};

/** An agent event kind in words. */
export function eventWords(kind: string): string {
  return EVENT_WORDS[kind] ?? kind.replace(/_/g, ' ');
}
