import { z } from 'zod';
import { memoryBytes } from './quantities.js';
import {
  AiSettings,
  Build,
  Deploy,
  Health,
  Network,
  Placement,
  Preview,
  ResourceName,
  Runtime,
  Scaling,
  Schedule,
  Source,
} from './sections.js';

/**
 * The Application spec (§5): the desired-state document humans edit, the AI
 * proposes diffs to, and agents converge on.
 *
 * Identity (project id, org id) is deliberately NOT part of the document — it
 * lives on the envelope the spec travels in (ADR 0001). The document is
 * therefore pure desired state: two projects with identical intent hash
 * identically, and no edit to the document can move a project between orgs.
 */
const ApplicationSpecShape = z.strictObject({
  apiVersion: z.literal('vdeploy/v1'),
  kind: z.literal('Application'),
  metadata: z.strictObject({
    name: ResourceName,
    labels: z.record(ResourceName, z.string().max(63)).default({}),
  }),
  source: Source,
  build: Build,
  runtime: Runtime.prefault({}),
  network: Network.optional(),
  health: Health.prefault({}),
  deploy: Deploy.prefault({}),
  scaling: Scaling.prefault({}),
  schedule: Schedule.prefault({}),
  placement: Placement.prefault({}),
  preview: Preview.prefault({}),
  ai: AiSettings.prefault({}),
});

type Shape = z.output<typeof ApplicationSpecShape>;

function issue(ctx: z.core.$RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: 'custom', path, message });
}

function checkResources(spec: Shape, ctx: z.core.$RefinementCtx): void {
  const { cpu, memory } = spec.runtime.resources;
  if (cpu.request > cpu.limit) {
    issue(ctx, ['runtime', 'resources', 'cpu', 'request'], 'CPU request cannot exceed its limit');
  }
  if (memoryBytes(memory.request) > memoryBytes(memory.limit)) {
    issue(
      ctx,
      ['runtime', 'resources', 'memory', 'request'],
      'memory request cannot exceed its limit',
    );
  }
  if (memoryBytes(memory.limit) < 32 * 1024 ** 2) {
    issue(ctx, ['runtime', 'resources', 'memory', 'limit'], 'memory limit must be at least 32Mi');
  }
}

function checkUniqueness(spec: Shape, ctx: z.core.$RefinementCtx): void {
  const seen = (values: string[], path: (string | number)[], what: string) => {
    const set = new Set<string>();
    values.forEach((value, index) => {
      if (set.has(value)) issue(ctx, [...path, index], `duplicate ${what} "${value}"`);
      set.add(value);
    });
  };
  seen(
    spec.runtime.env.map((e) => e.key),
    ['runtime', 'env'],
    'variable',
  );
  seen(
    spec.runtime.volumes.map((v) => v.name),
    ['runtime', 'volumes'],
    'volume name',
  );
  seen(
    spec.runtime.volumes.map((v) => v.mountPath),
    ['runtime', 'volumes'],
    'mount path',
  );
  seen(spec.network?.domains.map((d) => d.host) ?? [], ['network', 'domains'], 'domain');
  seen(
    spec.schedule.crons.map((c) => c.name),
    ['schedule', 'crons'],
    'cron name',
  );
}

function checkStatefulGuards(spec: Shape, ctx: z.core.$RefinementCtx): void {
  // §17.6: two containers writing one local volume corrupts data. Refused, not warned.
  if (spec.runtime.volumes.length > 0 && spec.runtime.replicas > 1) {
    issue(
      ctx,
      ['runtime', 'replicas'],
      'an app with a permanent folder cannot run more than 1 copy — two copies writing the same folder corrupts data',
    );
  }
  if (spec.runtime.volumes.length > 0 && spec.scaling.max > 1) {
    issue(ctx, ['scaling', 'max'], 'an app with a permanent folder cannot scale past 1 copy');
  }
}

function checkConsistency(spec: Shape, ctx: z.core.$RefinementCtx): void {
  const { source, build, scaling, runtime, deploy, network } = spec;
  if (source.type === 'image' && build.strategy !== 'image') {
    issue(
      ctx,
      ['build', 'strategy'],
      'a prebuilt image source must use the "image" build strategy',
    );
  }
  // A template is a named image: it expands into one before anything runs,
  // so it is the same strategy, not a different kind of build.
  if (source.type !== 'image' && source.type !== 'template' && build.strategy === 'image') {
    issue(ctx, ['build', 'strategy'], 'the "image" build strategy requires an image source');
  }
  if (scaling.min > scaling.max) {
    issue(ctx, ['scaling', 'min'], 'scaling min cannot exceed max');
  }
  if (
    scaling.mode === 'rules' &&
    (runtime.replicas < scaling.min || runtime.replicas > scaling.max)
  ) {
    issue(ctx, ['runtime', 'replicas'], 'replicas must be within scaling min and max');
  }
  scaling.rules.forEach((rule, index) => {
    if ((rule.above === undefined) === (rule.below === undefined)) {
      issue(ctx, ['scaling', 'rules', index], 'a rule needs exactly one of "above" or "below"');
    }
  });
  if (deploy.strategy === 'canary' && !deploy.canary) {
    issue(ctx, ['deploy', 'canary'], 'the canary strategy needs canary steps');
  }
  network?.domains.forEach((domain, index) => {
    if (domain.host.startsWith('*.') && domain.tls.challenge !== 'dns-01') {
      issue(
        ctx,
        ['network', 'domains', index, 'tls'],
        'a wildcard domain needs the dns-01 challenge',
      );
    }
  });
}

export const ApplicationSpec = ApplicationSpecShape.superRefine((spec, ctx) => {
  checkResources(spec, ctx);
  checkUniqueness(spec, ctx);
  checkStatefulGuards(spec, ctx);
  checkConsistency(spec, ctx);
});

/** A spec after defaults are applied — what is stored, hashed and shipped. */
export type ApplicationSpec = z.output<typeof ApplicationSpec>;
/** What a human, the CLI or the AI may submit — defaults not yet applied. */
export type ApplicationSpecInput = z.input<typeof ApplicationSpec>;
