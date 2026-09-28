import type { PlanView } from '@vdeploy/contracts';

/**
 * What the CLI says back.
 *
 * Two audiences, and they want opposite things: a person wants the answer
 * in a sentence, and a script wants the JSON it can act on. `--json` gives
 * the second exactly what the API returned, unchanged, so a script never
 * depends on prose that might be reworded.
 */

const colour = (code: string, text: string) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text;

export const dim = (text: string) => colour('2', text);
export const bold = (text: string) => colour('1', text);
const red = (text: string) => colour('31', text);
const amber = (text: string) => colour('33', text);
const green = (text: string) => colour('32', text);

/**
 * A plan, in the words a person needs to decide.
 *
 * The important part is the first line: a change that is waiting is not a
 * failure, and saying "pending approval" without saying *why* leaves
 * somebody staring at a command that appears to have done nothing.
 */
export function renderPlan(plan: PlanView): string {
  const lines: string[] = [];
  const waiting = plan.status === 'pending_approval';
  lines.push(
    waiting
      ? amber(`Waiting for someone to approve it.`)
      : plan.status === 'applied'
        ? green('Done.')
        : `${bold(plan.status)}.`,
  );
  lines.push(dim(`  plan ${plan.id} · ${plan.operation} · risk: ${plan.tier}`));

  for (const reason of plan.reasons) lines.push(`  ${reason}`);

  const changes = plan.plan.changes;
  if (changes.length > 0) {
    lines.push('', bold('  What changes'));
    for (const change of changes.slice(0, 12)) {
      const before = change.before === null ? dim('nothing') : JSON.stringify(change.before);
      lines.push(`  ${change.path}: ${before} → ${JSON.stringify(change.after)}`);
    }
    if (changes.length > 12) lines.push(dim(`  …and ${String(changes.length - 12)} more`));
  }

  const radius = plan.plan.blastRadius;
  const risky: string[] = [];
  if (radius.downtime !== 'none') risky.push(`downtime: ${radius.downtime}`);
  if (radius.dataAtRisk.length > 0) risky.push(`at risk: ${radius.dataAtRisk.join(', ')}`);
  if (risky.length > 0) lines.push('', `  ${red(risky.join(' · '))}`);

  if (waiting) {
    lines.push('', dim(`  Approve it in the dashboard, or: vdeploy plan approve ${plan.id}`));
  }
  if (plan.error) lines.push('', `  ${red(plan.error.message)}`);
  return lines.join('\n');
}

/**
 * A read's answer.
 *
 * A list of rows becomes a table, because that is what a list is for; one
 * object becomes its fields; anything else is printed as it came. Nothing
 * is truncated silently — a value too wide to show is shown anyway, since
 * a table that lies about what is in it is worse than one that wraps.
 */
export function renderResult(value: unknown): string {
  if (value === null || value === undefined) return dim('Nothing.');
  if (Array.isArray(value)) {
    if (value.length === 0) return dim('Nothing yet.');
    if (!value.every((row) => typeof row === 'object' && row !== null)) {
      return value.map((row) => String(row)).join('\n');
    }
    return table(value as Record<string, unknown>[]);
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const width = Math.max(...entries.map(([key]) => key.length));
    return entries.map(([key, v]) => `${dim(key.padEnd(width))}  ${cell(v)}`).join('\n');
  }
  return JSON.stringify(value);
}

/**
 * How wide a cell looks, which is not how long it is: the colour codes
 * around a value take no space on screen, and counting them would push
 * every column after it out of line.
 */
function visibleWidth(text: string): number {
  let width = 0;
  let inEscape = false;
  for (const char of text) {
    if (char === '\u001b') inEscape = true;
    else if (inEscape) inEscape = char !== 'm';
    else width++;
  }
  return width;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return dim('—');
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function table(rows: Record<string, unknown>[]): string {
  // Only the columns worth a column: a field that is an object in every
  // row belongs in `--json`, not squeezed into a terminal.
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) =>
    rows.some((row) => {
      const value = row[key];
      return value === null || typeof value !== 'object';
    }),
  );
  const width = Object.fromEntries(
    columns.map((key) => [
      key,
      Math.max(key.length, ...rows.map((row) => visibleWidth(cell(row[key])))),
    ]),
  );
  const head = columns.map((key) => dim(key.padEnd(width[key] ?? key.length))).join('  ');
  const body = rows.map((row) =>
    columns
      .map((key) => {
        const text = cell(row[key]);
        return text + ' '.repeat(Math.max(0, (width[key] ?? 0) - visibleWidth(text)));
      })
      .join('  ')
      .trimEnd(),
  );
  return [head, ...body].join('\n');
}
