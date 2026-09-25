import { VDeployError } from '@vdeploy/contracts';

/**
 * Five-field cron, evaluated in the person's own timezone (§17.6: "back up at
 * 3 AM" must mean *their* 3 AM). Nothing here guesses: an expression that
 * cannot be read is refused in words, not silently ignored, because a
 * schedule that quietly never runs is worse than one that never existed.
 */
export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** Cron ORs the two day fields when both are restricted (Vixie behaviour). */
  dayRestricted: { ofMonth: boolean; ofWeek: boolean };
}

const NAMES: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function number(token: string, min: number, max: number, expr: string): number {
  const named = NAMES[token.toLowerCase()];
  const value = named ?? Number(token);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new VDeployError('invalid_input', `"${token}" is not a valid part of "${expr}"`);
  }
  return value;
}

function field(text: string, min: number, max: number, expr: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw new VDeployError('invalid_input', `"${part}" has no step to count by, in "${expr}"`);
    }
    let from = min;
    let to = max;
    if (range !== undefined && range !== '*') {
      const [startText, endText] = range.split('-');
      from = number(startText ?? '', min, max, expr);
      to =
        endText === undefined
          ? stepText === undefined
            ? from
            : max
          : number(endText, min, max, expr);
    }
    if (to < from) {
      throw new VDeployError('invalid_input', `"${part}" counts backwards, in "${expr}"`);
    }
    for (let value = from; value <= to; value += step) out.add(value);
  }
  return out;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new VDeployError(
      'invalid_input',
      `"${expr}" is not a schedule: it needs five parts — minute, hour, day, month and weekday`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    minute: field(minute, 0, 59, expr),
    hour: field(hour, 0, 23, expr),
    dayOfMonth: field(dayOfMonth, 1, 31, expr),
    month: field(month, 1, 12, expr),
    // Both 0 and 7 mean Sunday.
    dayOfWeek: new Set([...field(dayOfWeek, 0, 7, expr)].map((day) => (day === 7 ? 0 : day))),
    dayRestricted: { ofMonth: dayOfMonth !== '*', ofWeek: dayOfWeek !== '*' },
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock fields of an instant, in one timezone. */
export function wallClock(at: Date, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour12: false,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
      });
    } catch {
      throw new VDeployError('invalid_input', `"${timezone}" is not a timezone this server knows`);
    }
    formatters.set(timezone, formatter);
  }
  const parts = new Map(formatter.formatToParts(at).map((part) => [part.type, part.value]));
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(parts.get('year')),
    month: Number(parts.get('month')),
    day: Number(parts.get('day')),
    // Midnight comes back as 24 in some runtimes.
    hour: Number(parts.get('hour')) % 24,
    minute: Number(parts.get('minute')),
    weekday: Math.max(0, weekdays.indexOf(parts.get('weekday') ?? 'Sun')),
  };
}

/** Whether a schedule fires at this minute, read in its own timezone. */
export function cronMatches(fields: CronFields, at: Date, timezone: string): boolean {
  const now = wallClock(at, timezone);
  if (!fields.minute.has(now.minute) || !fields.hour.has(now.hour)) return false;
  if (!fields.month.has(now.month)) return false;
  const { ofMonth, ofWeek } = fields.dayRestricted;
  const day = fields.dayOfMonth.has(now.day);
  const weekday = fields.dayOfWeek.has(now.weekday);
  if (ofMonth && ofWeek) return day || weekday;
  if (ofMonth) return day;
  if (ofWeek) return weekday;
  return true;
}

const MINUTE = 60_000;
/** A year ahead: an expression that does not fire within one never fires. */
const HORIZON = 366 * 24 * 60 * MINUTE;
/** Each step skips at least a minute, so this only guards against a bug. */
const MAX_STEPS = 100_000;

/** Whether the date part of a schedule matches this day. */
function dayMatches(fields: CronFields, clock: ReturnType<typeof wallClock>): boolean {
  if (!fields.month.has(clock.month)) return false;
  const { ofMonth, ofWeek } = fields.dayRestricted;
  const day = fields.dayOfMonth.has(clock.day);
  const weekday = fields.dayOfWeek.has(clock.weekday);
  if (ofMonth && ofWeek) return day || weekday;
  if (ofMonth) return day;
  if (ofWeek) return weekday;
  return true;
}

/**
 * The next time a schedule fires after `after`, or null when it never does
 * (31 February is a valid expression and an impossible date). A day that
 * cannot match is skipped whole, so looking a year ahead costs hundreds of
 * checks rather than half a million.
 */
export function nextRun(expr: string, after: Date, timezone = 'UTC'): Date | null {
  const fields = parseCron(expr);
  // Start at the next whole minute: a schedule never fires twice in one minute.
  let at = new Date(Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE);
  const limit = at.getTime() + HORIZON;
  for (let steps = 0; steps < MAX_STEPS && at.getTime() <= limit; steps++) {
    const clock = wallClock(at, timezone);
    if (!dayMatches(fields, clock)) {
      // On to the next day in this timezone, however long today turned out to be.
      at = new Date(at.getTime() + (24 * 60 - (clock.hour * 60 + clock.minute)) * MINUTE);
      continue;
    }
    if (!fields.hour.has(clock.hour)) {
      at = new Date(at.getTime() + (60 - clock.minute) * MINUTE);
      continue;
    }
    if (!fields.minute.has(clock.minute)) {
      at = new Date(at.getTime() + MINUTE);
      continue;
    }
    return at;
  }
  return null;
}

/** Whether a schedule was due between two moments (the worker's last look and now). */
export function dueSince(expr: string, since: Date, now: Date, timezone = 'UTC'): boolean {
  const next = nextRun(expr, since, timezone);
  return next !== null && next.getTime() <= now.getTime();
}

const EVERY_MINUTE = /^(\*|\*\/1)$/;

/**
 * The schedule in plain words, with the resolved UTC time when it is not
 * already UTC — §17.6: the timezone is explicit, never implied.
 */
export function describeCron(expr: string, timezone = 'UTC', now = new Date()): string {
  const fields = parseCron(expr);
  const next = nextRun(expr, now, timezone);
  const parts = expr.trim().split(/\s+/);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const time = () => {
    const [h] = [...fields.hour];
    const [m] = [...fields.minute];
    return `${String(h ?? 0).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}`;
  };
  let when: string;
  if (EVERY_MINUTE.test(minute) && EVERY_MINUTE.test(hour)) when = 'every minute';
  else if (fields.minute.size === 1 && EVERY_MINUTE.test(hour)) when = `every hour, at ${time()}`;
  else if (
    fields.minute.size === 1 &&
    fields.hour.size === 1 &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    when = `every day at ${time()}`;
  } else if (fields.minute.size === 1 && fields.hour.size === 1 && fields.dayRestricted.ofWeek) {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    when = `every ${[...fields.dayOfWeek].map((d) => names[d] ?? '').join(' and ')} at ${time()}`;
  } else when = `on the schedule ${expr}`;
  const utc = next ? `${next.toISOString().slice(11, 16)} UTC` : null;
  if (!utc || timezone === 'UTC') return `${when} (${timezone})`;
  return `${when} (${timezone}) — ${utc} here`;
}
