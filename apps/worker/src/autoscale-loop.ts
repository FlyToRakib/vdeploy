import { newId, readSpec, VDeployError } from '@vdeploy/contracts';
import { autoscale, buildPlan, type Reading } from '@vdeploy/core';
import {
  appendAudit,
  enqueuePlan,
  lastScaledAt,
  loadPlanWorld,
  metricsOf,
  notify,
  plans,
  scalableProjects,
  type Database,
  type JobSink,
} from '@vdeploy/db';

/**
 * Autoscaling, once a minute (§14).
 *
 * The decision is made here and not on the agent, and that is the whole
 * shape of it: scaling changes `runtime.replicas`, which is **spec**, and
 * the spec belongs to the control plane. So a rule firing produces an
 * ordinary `project.scale` plan — which means the resource governor
 * refuses it if the server cannot hold it, the change is in the audit log
 * with the rule that caused it, and rolling it back is the same as rolling
 * back anything else.
 *
 * An agent that decided for itself would have to be trusted with capacity
 * it cannot see, and would leave a spec that no longer describes what runs.
 */
export const COOLDOWN_MS = 5 * 60_000;

export interface AutoscaleDeps {
  db: Database;
  queue: JobSink;
  now: () => Date;
  logError: (err: unknown, projectId: string) => void;
}

/**
 * The plan a rule produces, queued the way an approved one is.
 *
 * It is built by the same planner a person's request uses, so the resource
 * governor decides whether it fits and refuses it if not, and it applies
 * through the same worker. What it skips is the *human* gate — approval,
 * step-up, the AI's grants — and it skips it because the rule itself was
 * approved when somebody put it in the spec. A cron firing works the same
 * way, for the same reason.
 */
async function queueScale(
  deps: AutoscaleDeps,
  project: { id: string; orgId: string },
  replicas: number,
): Promise<string> {
  const args = { projectId: project.id, replicas };
  const plan = buildPlan('project.scale', args, await loadPlanWorld(deps.db, project.id, args));
  const planId = newId('plan');
  await deps.db.insert(plans).values({
    id: planId,
    orgId: project.orgId,
    projectId: plan.projectId,
    operation: plan.operation,
    args,
    plan,
    planHash: plan.planHash,
    tier: plan.tier,
    blastRadius: plan.blastRadius,
    status: 'approved',
    // No person pressed anything: a rule in the spec did, and the spec
    // was approved when somebody put the rule in it. The audit entry
    // beside this one names the rule and what it changed.
    actor: { userId: '', origin: 'scheduler' as const },
    reasons: [],
    expiresAt: new Date(deps.now().getTime() + 15 * 60_000),
  });
  await enqueuePlan(deps.queue, planId);
  return planId;
}

/**
 * Apps the governor has just refused to grow, and until when.
 *
 * In memory rather than in the database on purpose: it is a politeness, not
 * a fact — it stops the same refusal being asked for every minute — and a
 * worker restart forgetting it costs one extra refusal.
 */
const refused = new Map<string, number>();

export async function runAutoscaling(deps: AutoscaleDeps): Promise<number> {
  const now = deps.now();
  let scaled = 0;
  for (const project of await scalableProjects(deps.db)) {
    try {
      const spec = readSpec(project.spec);
      if (spec.scaling.mode !== 'rules' || spec.scaling.rules.length === 0) continue;
      const held = refused.get(project.id);
      if (held !== undefined && now.getTime() < held) continue;

      // An hour is longer than any rule's window; older readings cannot
      // decide anything.
      const since = new Date(now.getTime() - 60 * 60_000);
      const decision = autoscale({
        spec,
        replicas: spec.runtime.replicas,
        series: (await metricsOf(deps.db, project.id, since)).map(toReading),
        cooledDownAt: await lastScaledAt(deps.db, project.id),
        cooldownMs: COOLDOWN_MS,
        now,
      });
      if (decision.replicas === null) continue;

      // Built by the same planner anybody's request uses: the governor
      // can refuse it, and what applies is an ordinary plan.
      const planId = await queueScale(deps, project, decision.replicas);
      const grew = decision.replicas > spec.runtime.replicas;
      await notify(
        deps.db,
        project.orgId,
        {
          trigger: 'autoscaled',
          key: `autoscale:${planId}`,
          title: `${spec.metadata.name} ${grew ? 'grew' : 'shrank'} to ${String(decision.replicas)} copies`,
          message: `A scaling rule changed ${spec.metadata.name} from ${String(spec.runtime.replicas)} to ${String(decision.replicas)} copies, because ${decision.because}.`,
          projectId: project.id,
          serverId: project.serverId,
        },
        now,
      );
      await appendAudit(deps.db, {
        chain: project.orgId,
        actor: { system: 'autoscale' },
        action: 'autoscale.applied',
        target: project.id,
        outcome: 'succeeded',
        details: {
          from: spec.runtime.replicas,
          to: decision.replicas,
          because: decision.because,
        },
      });
      scaled += 1;
    } catch (error) {
      // The governor refusing is the system working, not a fault: an app
      // that cannot grow stays the size it is, and is not asked again for
      // a while.
      if (error instanceof VDeployError && error.code === 'capacity_exceeded') {
        refused.set(project.id, now.getTime() + COOLDOWN_MS);
        // Said once an hour: an app that needs to grow and cannot is worth
        // knowing about, and a minute-by-minute retelling is not.
        const name = readSpec(project.spec).metadata.name;
        await notify(
          deps.db,
          project.orgId,
          {
            trigger: 'autoscaled',
            key: `autoscale-refused:${project.id}:${now.toISOString().slice(0, 13)}`,
            title: `${name} needs to grow, and its server has no room`,
            message: `A scaling rule asked for more copies of ${name}, and its server does not have the memory or CPU for them. ${error.message}`,
            projectId: project.id,
            serverId: project.serverId,
          },
          now,
        ).catch((err: unknown) => {
          deps.logError(err, project.id);
        });
        continue;
      }
      deps.logError(error, project.id);
    }
  }
  return scaled;
}

/** For tests: nothing is remembered between them. */
export function forgetRefusals(): void {
  refused.clear();
}

function toReading(sample: {
  at: Date;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimit: number;
  requests: number;
  replicas: number;
}): Reading {
  return {
    at: sample.at,
    cpuPercent: sample.cpuPercent,
    memoryBytes: sample.memoryBytes,
    memoryLimit: sample.memoryLimit,
    requests: sample.requests,
    // How many copies the numbers were summed across at the time, which is
    // what makes "per copy" mean anything.
    replicas: sample.replicas,
  };
}
