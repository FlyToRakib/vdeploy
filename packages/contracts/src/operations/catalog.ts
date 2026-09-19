import { z } from 'zod';
import { idSchema } from '../ids.js';
import { ApplicationSpec } from '../spec/application.js';
import {
  Deploy,
  Health,
  Network,
  ResourceName,
  Runtime,
  Scaling,
  Schedule,
} from '../spec/sections.js';
import { operation, query, Role, type OperationDefinition } from './define.js';

const projectId = idSchema('project');
const serverId = idSchema('server');
const databaseId = idSchema('database');
const P = { projectId };
const S = { serverId };
const obj = z.strictObject;
const DatabaseEngine = z.enum(['postgres', 'mysql', 'mariadb', 'redis', 'mongodb']);
const CronEntry = Schedule.shape.crons.unwrap().element;

/**
 * The operation catalog (§24). One definition per operation, consumed by the
 * API, the CLI, the AI tool registry, MCP and the dashboard forms. Adding a
 * capability means adding one entry here — and the policy engine gates it the
 * moment it exists.
 */
export const OPERATIONS = [
  // ── Tier 1 · safe ───────────────────────────────────────────────────────
  query('project.list', 'org', 'List projects and their health', obj({})),
  query('project.get', 'project', 'Show a project, its spec and current state', obj(P)),
  query(
    'project.logs',
    'project',
    'Read recent container log lines',
    obj({ ...P, tail: z.number().int().min(1).max(2000).default(200) }),
  ),
  query('project.metrics', 'project', 'Read CPU, memory and network usage', obj(P)),
  query('project.events', 'project', 'Read the project event timeline', obj(P)),
  query('deployment.list', 'project', 'List deployments of a project', obj(P)),
  query(
    'deployment.get',
    'project',
    'Show one deployment and its outcome',
    obj({ ...P, deploymentId: idSchema('deployment') }),
  ),
  query(
    'deployment.logs',
    'project',
    'Read the build and deploy log of one deployment',
    obj({ ...P, deploymentId: idSchema('deployment') }),
  ),
  query('release.list', 'project', 'List releases of a project', obj(P)),
  query(
    'release.get',
    'project',
    'Show one release',
    obj({ ...P, releaseId: idSchema('release') }),
  ),
  query('server.status', 'server', 'Show whether a server and its agent are healthy', obj(S)),
  query('server.resources', 'server', 'Show server CPU, memory and disk usage', obj(S)),
  query('health.check', 'project', 'Run the health checks of a project now', obj(P)),
  operation('project.restart', 'safe', 'project', 'Restart the app containers', obj(P)),
  operation('project.redeploy', 'safe', 'project', 'Deploy the current release again', obj(P)),
  operation('project.rebuild', 'safe', 'project', 'Rebuild from source and deploy', obj(P)),
  operation(
    'project.scale',
    'safe',
    'project',
    'Change how many copies of the app run, within its declared limits',
    obj({ ...P, replicas: z.number().int().min(0).max(64) }),
  ),
  operation(
    'server.reclaim_safe',
    'safe',
    'server',
    'Free disk space from unused images and build cache, keeping every rollback target',
    obj(S),
  ),
  operation('backup.trigger', 'safe', 'project', 'Take a backup now', obj(P)),

  // ── Tier 2 · sensitive ──────────────────────────────────────────────────
  operation(
    'project.create',
    'sensitive',
    'org',
    'Create a new project from a spec',
    obj({ spec: ApplicationSpec, serverId: serverId.optional() }),
  ),
  operation(
    'project.update_spec',
    'sensitive',
    'project',
    'Replace the project spec',
    obj({ ...P, spec: ApplicationSpec }),
  ),
  operation('project.stop', 'sensitive', 'project', 'Stop the app; the site goes offline', obj(P)),
  operation('project.start', 'sensitive', 'project', 'Start a stopped app', obj(P)),
  operation(
    'env.set',
    'sensitive',
    'project',
    'Set an environment variable (secrets by reference only)',
    obj({
      ...P,
      key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,254}$/),
      value: z.string().max(32_768).optional(),
      secretRef: idSchema('secret').optional(),
    }).refine((i) => (i.value === undefined) !== (i.secretRef === undefined), {
      message: 'exactly one of value or secretRef',
    }),
  ),
  operation(
    'env.unset',
    'sensitive',
    'project',
    'Remove an environment variable',
    obj({ ...P, key: z.string().min(1).max(255) }),
  ),
  operation(
    'domain.add',
    'sensitive',
    'project',
    'Attach a domain name',
    obj({ ...P, host: Network.shape.domains.unwrap().element.shape.host }),
  ),
  operation(
    'domain.remove',
    'sensitive',
    'project',
    'Detach a domain name',
    obj({ ...P, host: z.string().min(1).max(253) }),
  ),
  operation(
    'tls.configure',
    'sensitive',
    'project',
    'Change how the HTTPS certificate is obtained',
    obj({ ...P, host: z.string().min(1).max(253), challenge: z.enum(['http-01', 'dns-01']) }),
  ),
  operation(
    'network.middleware',
    'sensitive',
    'project',
    'Change rate limits, compression, IP rules or security headers',
    obj({ ...P, middleware: Network.shape.middleware }),
  ),
  operation(
    'loadbalancer.configure',
    'sensitive',
    'project',
    'Change load balancing and sticky sessions',
    obj({ ...P, loadBalancer: Network.shape.loadBalancer }),
  ),
  operation(
    'scaling.rules',
    'sensitive',
    'project',
    'Change autoscaling rules',
    obj({ ...P, scaling: Scaling }),
  ),
  operation(
    'health.configure',
    'sensitive',
    'project',
    'Change health checks',
    obj({ ...P, health: Health }),
  ),
  operation(
    'resources.limits',
    'sensitive',
    'project',
    'Change CPU and memory limits',
    obj({ ...P, resources: Runtime.shape.resources }),
  ),
  operation(
    'deploy.strategy',
    'sensitive',
    'project',
    'Change how deploys roll out',
    obj({ ...P, deploy: Deploy }),
  ),
  operation(
    'database.create',
    'sensitive',
    'server',
    'Create a managed database, reachable only on the internal network',
    obj({
      ...S,
      name: ResourceName,
      engine: DatabaseEngine,
      version: z.string().regex(/^\d+(\.\d+)*$/),
    }),
  ),
  operation(
    'cron.create',
    'sensitive',
    'project',
    'Add a scheduled job',
    obj({ ...P, cron: CronEntry }),
  ),
  operation(
    'cron.update',
    'sensitive',
    'project',
    'Change a scheduled job',
    obj({ ...P, cron: CronEntry }),
  ),
  operation(
    'release.rollback',
    'sensitive',
    'project',
    'Return to an earlier release, exactly as it was',
    obj({ ...P, releaseId: idSchema('release') }),
  ),
  operation(
    'volume.create',
    'sensitive',
    'project',
    'Add a permanent folder',
    obj({ ...P, volume: Runtime.shape.volumes.unwrap().element }),
  ),
  operation(
    'storage.make_persistent',
    'sensitive',
    'project',
    'Turn a folder into a permanent folder, keeping the files already in it',
    obj({ ...P, mountPath: Runtime.shape.volumes.unwrap().element.shape.mountPath }),
  ),
  operation(
    'backup.schedule',
    'sensitive',
    'project',
    'Change when backups run and how long they are kept',
    obj({
      ...P,
      expr: CronEntry.shape.expr,
      timezone: z.string().min(1).max(64),
      keepLocal: z.number().int().min(1).max(365),
      keepOffsite: z.number().int().min(0).max(3650),
    }),
  ),
  operation(
    'backup.download',
    'sensitive',
    'project',
    'Download a backup file',
    obj({ ...P, backupId: idSchema('backup') }),
  ),
  operation(
    'registry.add',
    'sensitive',
    'org',
    'Allow images from a container registry',
    obj({ host: z.string().min(1).max(253), credentials: idSchema('secret').optional() }),
  ),
  operation(
    'git.connect',
    'sensitive',
    'org',
    'Connect a Git provider installation',
    obj({ provider: z.enum(['github']), installationId: z.string().regex(/^\d{1,20}$/) }),
  ),

  // ── Tier 3 · destructive — always explicit approval, snapshot first ──────
  operation(
    'project.delete',
    'destructive',
    'project',
    'Delete a project; its data is kept unless you choose otherwise',
    obj({ ...P, keepData: z.boolean().default(true) }),
  ),
  operation(
    'volume.delete',
    'destructive',
    'project',
    'Delete a permanent folder after taking a snapshot',
    obj({ ...P, volume: ResourceName }),
  ),
  operation(
    'database.delete',
    'destructive',
    'database',
    'Delete a database after taking a backup',
    obj({ databaseId }),
  ),
  operation(
    'secret.rotate',
    'destructive',
    'project',
    'Replace a secret value and restart what uses it',
    obj({ ...P, secretId: idSchema('secret') }),
  ),
  operation(
    'task.run',
    'destructive',
    'project',
    'Run a one-off command in a new container from the current release',
    obj({ ...P, command: z.array(z.string().max(4096)).min(1).max(64) }),
  ),
  operation(
    'backup.restore',
    'destructive',
    'project',
    'Restore a backup, to a new database by default',
    obj({ ...P, backupId: idSchema('backup'), mode: z.enum(['new', 'in_place']).default('new') }),
  ),
  operation('server.drain', 'destructive', 'server', 'Move every app off a server', obj(S)),

  // ── Tier 4 · human only — never in any AI tool array ────────────────────
  operation(
    'terminal.open',
    'human_only',
    'project',
    'Open an audited, recorded terminal into a container',
    obj({ ...P, replica: z.number().int().min(0).max(63).default(0) }),
    { minRole: 'developer' },
  ),
  operation(
    'secret.read_value',
    'human_only',
    'project',
    'Reveal a secret value',
    obj({ ...P, secretId: idSchema('secret') }),
    { stepUp: true },
  ),
  operation(
    'server.add',
    'human_only',
    'org',
    'Create a server enrollment token',
    obj({ name: ResourceName }),
    { stepUp: true },
  ),
  operation(
    'server.remove',
    'human_only',
    'server',
    'Remove a server from the organization',
    obj(S),
    { stepUp: true },
  ),
  operation(
    'user.invite',
    'human_only',
    'org',
    'Invite someone to the organization',
    obj({ email: z.email(), role: Role.exclude(['owner']) }),
  ),
  operation(
    'user.remove',
    'human_only',
    'org',
    'Remove someone from the organization',
    obj({ userId: idSchema('user') }),
  ),
  operation(
    'user.set_role',
    'human_only',
    'org',
    "Change someone's role",
    obj({ userId: idSchema('user'), role: Role.exclude(['owner']) }),
  ),
  operation(
    'org.update',
    'human_only',
    'org',
    'Change organization settings',
    obj({
      name: z.string().min(1).max(100).optional(),
      registration: z.enum(['invite', 'open', 'closed']).optional(),
    }),
    { minRole: 'owner', stepUp: true },
  ),
  operation(
    'audit.export',
    'human_only',
    'org',
    'Export the audit log',
    obj({ from: z.iso.datetime(), to: z.iso.datetime() }),
  ),
] as const satisfies readonly OperationDefinition[];

export type Operation = (typeof OPERATIONS)[number];
export type OperationName = Operation['name'];
export type OperationInput<N extends OperationName> = z.input<
  Extract<Operation, { name: N }>['input']
>;

const BY_NAME: ReadonlyMap<string, Operation> = new Map(OPERATIONS.map((op) => [op.name, op]));

export function findOperation(name: string): Operation | undefined {
  return BY_NAME.get(name);
}

export const OperationNameSchema = z.enum(
  OPERATIONS.map((op) => op.name) as [OperationName, ...OperationName[]],
);

/** Parsed (defaults applied) input of an operation. */
export type OperationArgs<N extends OperationName> = z.output<
  Extract<Operation, { name: N }>['input']
>;
