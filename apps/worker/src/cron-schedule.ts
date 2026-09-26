import { readSpec } from '@vdeploy/contracts';
import { cronMatches, dueSince, parseCron } from '@vdeploy/core';
import { lastFirings, queueTask, schedulableProjects, type Database } from '@vdeploy/db';

export interface CronDeps {
  db: Database;
  now: () => Date;
  logError: (err: unknown, projectId: string) => void;
}

/**
 * Scheduled jobs that fire without anyone remembering them (§17.6). The
 * schedule is read in the timezone the person wrote it in, a firing missed
 * while the worker was busy is late rather than lost, and each firing is
 * queued once — the unique index on (project, name, minute) means two
 * workers looking at the same moment still produce one run.
 *
 * It runs once, not once per replica: the run is one container on the
 * server, which is where three replicas would otherwise mean three copies
 * of every nightly email.
 */
export async function runDueCrons(deps: CronDeps): Promise<number> {
  const now = deps.now();
  let queued = 0;
  for (const project of await schedulableProjects(deps.db)) {
    const crons = readSpec(project.spec).schedule.crons;
    if (crons.length === 0 || !project.serverId || !project.releaseId) continue;
    const serverId = project.serverId;
    const releaseId = project.releaseId;
    try {
      const fired = await lastFirings(deps.db, project.id);
      for (const cron of crons) {
        // The clock starts when the project was made, so adding a job does
        // not immediately run every firing it has ever missed.
        const since = fired.get(cron.name) ?? project.createdAt;
        if (!dueSince(cron.expr, since, now, cron.timezone)) continue;
        const queuedRow = await deps.db.transaction((tx) =>
          queueTask(tx, {
            orgId: project.orgId,
            projectId: project.id,
            serverId,
            releaseId,
            command: cron.command,
            reason: 'scheduled',
            name: cron.name,
            firedAt: firingMinute(cron.expr, since, now, cron.timezone),
          }),
        );
        if (queuedRow) queued += 1;
      }
    } catch (err) {
      deps.logError(err, project.id);
    }
  }
  return queued;
}

/**
 * The minute this run is *for*, which is what makes a firing identifiable:
 * the latest matching minute at or before now. A run queued late is still
 * the 03:00 run, and queueing it twice is refused because of that.
 */
export function firingMinute(expr: string, since: Date, now: Date, timezone: string): Date {
  const schedule = parseCron(expr);
  const start = new Date(Math.max(since.getTime(), now.getTime() - MAX_LATENESS_MS));
  let latest = start;
  for (let at = new Date(Math.floor(start.getTime() / 60_000) * 60_000 + 60_000); at <= now;) {
    if (cronMatches(schedule, at, timezone)) latest = at;
    at = new Date(at.getTime() + 60_000);
  }
  return new Date(Math.floor(latest.getTime() / 60_000) * 60_000);
}

/**
 * How far back a late firing is still recognisable as itself. Beyond this a
 * run is queued for the current minute: the point is not to replay a week of
 * missed nightly reports when a worker comes back.
 */
const MAX_LATENESS_MS = 6 * 60 * 60_000;
