/**
 * `.env` files in and out (§20 Projects: "env manager with bulk
 * import/export").
 *
 * Read the way the common loaders read them, so a file that works with an
 * app locally means the same thing here: `KEY=value` lines, an optional
 * `export ` in front, `#` comments, single quotes taken literally, double
 * quotes with `\n` escapes and able to span lines (a private key), and a
 * comment after an unquoted value dropped.
 */

export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;

export interface DotenvEntry {
  key: string;
  value: string;
}

export interface Dotenv {
  entries: DotenvEntry[];
  /** Lines that were not settings, with their line number, in words. */
  problems: string[];
}

const LINE = /^\s*(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/;

export function parseDotenv(text: string): Dotenv {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const found = new Map<string, string>();
  const problems: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const match = LINE.exec(line);
    if (!match) {
      problems.push(`Line ${String(i + 1)} is not NAME=value`);
      continue;
    }
    const key = match[1] ?? '';
    let raw = match[2] ?? '';
    if (!ENV_KEY.test(key)) {
      problems.push(`Line ${String(i + 1)}: ${key} is not a setting name`);
      continue;
    }
    let value: string;
    const quote = raw[0];
    if (quote === '"' || quote === "'") {
      // A quoted value runs to its closing quote, over several lines if it must.
      const start = i;
      let end = closing(raw, quote);
      while (end < 0 && i + 1 < lines.length) {
        i += 1;
        raw += `\n${lines[i] ?? ''}`;
        end = closing(raw, quote);
      }
      if (end < 0) {
        problems.push(`Line ${String(start + 1)}: the quote around ${key} is never closed`);
        continue;
      }
      value = raw.slice(1, end);
      if (quote === '"') {
        value = value.replace(/\\([nrt"\\])/g, (_, c: string) =>
          c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c,
        );
      }
    } else {
      value = raw.replace(/\s+#.*$/, '').trim();
    }
    found.set(key, value);
  }
  return { entries: [...found].map(([key, value]) => ({ key, value })), problems };
}

/** Where a quoted value ends: the next quote of the same kind that is not escaped. */
function closing(raw: string, quote: string): number {
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === '\\' && quote === '"') {
      i += 1;
      continue;
    }
    if (raw[i] === quote) return i;
  }
  return -1;
}

/**
 * An app's settings as a `.env` file. A value stored encrypted is not in
 * it — reading one back is its own, stepped-up act — so its line is there,
 * empty, with a comment saying where the value lives.
 */
export function toDotenv(
  env: readonly ({ key: string; value: string } | { key: string; secretRef: string })[],
): string {
  const lines = env.map((e) =>
    'value' in e
      ? `${e.key}=${quoteIfNeeded(e.value)}`
      : `# ${e.key} is stored encrypted in VDeploy; its value is not in this file\n${e.key}=`,
  );
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function quoteIfNeeded(value: string): string {
  if (value === '' || /^[\w@%+=:,./-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}
