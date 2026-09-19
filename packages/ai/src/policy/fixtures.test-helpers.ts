import {
  newId,
  SCOPE_FIELD,
  type OperationDefinition,
  type OperationName,
  type Role,
  type ScopeKind,
} from '@vdeploy/contracts';
import type { AiActor, HumanActor, Target } from './types.js';

export const ORG = newId('organization');

export function human(role: Role, overrides: Partial<HumanActor> = {}): HumanActor {
  return {
    kind: 'human',
    origin: 'dashboard',
    userId: newId('user'),
    orgId: ORG,
    role,
    stepUpAt: null,
    ...overrides,
  };
}

export function ai(role: Role, overrides: Partial<AiActor> = {}): AiActor {
  return {
    kind: 'ai',
    origin: 'ai',
    userId: newId('user'),
    orgId: ORG,
    role,
    aiSessionId: newId('aiSession'),
    model: 'claude-opus-5',
    mode: 'autopilot',
    tainted: false,
    ...overrides,
  };
}

export function projectTarget(overrides: Partial<Target> = {}): Target & { id: string } {
  return {
    kind: 'project',
    id: newId('project'),
    orgId: ORG,
    serverId: newId('server'),
    aiManaged: true,
    production: false,
    projectAutoApply: ['safe'],
    ...overrides,
  } as Target & { id: string };
}

export function serverTarget(overrides: Partial<Target> = {}): Target & { serverId: string } {
  const serverId = newId('server');
  return {
    kind: 'server',
    id: serverId,
    orgId: ORG,
    serverId,
    aiManaged: true,
    production: false,
    projectAutoApply: ['safe', 'sensitive'],
    ...overrides,
  } as Target & { serverId: string };
}

export function orgTarget(overrides: Partial<Target> = {}): Target {
  return {
    kind: 'org',
    id: null,
    orgId: ORG,
    serverId: null,
    aiManaged: true,
    production: false,
    projectAutoApply: ['safe', 'sensitive'],
    ...overrides,
  };
}

export function databaseTarget(overrides: Partial<Target> = {}): Target {
  return {
    kind: 'database',
    id: newId('database'),
    orgId: ORG,
    serverId: newId('server'),
    aiManaged: true,
    production: false,
    projectAutoApply: ['safe', 'sensitive'],
    ...overrides,
  };
}

export function targetFor(scope: ScopeKind): Target {
  if (scope === 'project') return projectTarget();
  if (scope === 'server') return serverTarget();
  if (scope === 'database') return databaseTarget();
  return orgTarget();
}

const SPEC = {
  apiVersion: 'vdeploy/v1',
  kind: 'Application',
  metadata: { name: 'blog' },
  source: { type: 'image', image: 'nginx:1.27' },
  build: { strategy: 'image' },
};
const CRON = { name: 'nightly', command: ['node', 'job.js'], expr: '0 3 * * *' };

const EXTRA_INPUT: Partial<Record<OperationName, Record<string, unknown>>> = {
  'deployment.get': { deploymentId: newId('deployment') },
  'deployment.logs': { deploymentId: newId('deployment') },
  'release.get': { releaseId: newId('release') },
  'release.rollback': { releaseId: newId('release') },
  'project.scale': { replicas: 1 },
  'project.create': { spec: SPEC },
  'project.update_spec': { spec: SPEC },
  'env.set': { key: 'NODE_ENV', value: 'production' },
  'env.unset': { key: 'NODE_ENV' },
  'domain.add': { host: 'blog.example.com' },
  'domain.remove': { host: 'blog.example.com' },
  'tls.configure': { host: 'blog.example.com', challenge: 'http-01' },
  'network.middleware': { middleware: {} },
  'loadbalancer.configure': { loadBalancer: {} },
  'scaling.rules': { scaling: {} },
  'health.configure': { health: {} },
  'resources.limits': { resources: {} },
  'deploy.strategy': { deploy: {} },
  'database.create': { name: 'blog-db', engine: 'postgres', version: '16' },
  'cron.create': { cron: CRON },
  'cron.update': { cron: CRON },
  'volume.create': { volume: { name: 'uploads', mountPath: '/app/uploads' } },
  'storage.make_persistent': { mountPath: '/app/uploads' },
  'backup.schedule': { expr: '0 3 * * *', timezone: 'UTC', keepLocal: 7, keepOffsite: 30 },
  'backup.download': { backupId: newId('backup') },
  'backup.restore': { backupId: newId('backup') },
  'registry.add': { host: 'ghcr.io' },
  'git.connect': { provider: 'github', installationId: '12345' },
  'volume.delete': { volume: 'uploads' },
  'secret.rotate': { secretId: newId('secret') },
  'secret.read_value': { secretId: newId('secret') },
  'task.run': { command: ['node', 'migrate.js'] },
  'server.add': { name: 'server-02' },
  'user.invite': { email: 'someone@example.com', role: 'developer' },
  'user.remove': { userId: newId('user') },
  'user.set_role': { userId: newId('user'), role: 'viewer' },
  'audit.export': { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' },
  'api_key.create': { name: 'ci', scope: 'read' },
  'api_key.revoke': { keyId: 'key_01J9Z3Q8S7M2K4X6V1B5N0C9D8' },
  'urls.configure': { mode: 'wildcard', baseDomain: 'apps.example.com' },
  'server.set_address': { ipv4: '8.8.4.4' },
};

/** A valid input for any operation, naming the given target. */
export function sampleInput(op: OperationDefinition, target: Target): Record<string, unknown> {
  const field = SCOPE_FIELD[op.scope];
  return {
    ...(field ? { [field]: target.id } : {}),
    ...EXTRA_INPUT[op.name as OperationName],
  };
}
