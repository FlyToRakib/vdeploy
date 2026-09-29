import {
  DEFAULT_AI_GRANTS,
  DEFAULT_BACKUP_POLICY,
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
  'build.configure': { builder: newId('server') },
  'storage.make_persistent': { mountPath: '/app/uploads' },
  'backup.schedule': { expr: '0 3 * * *', timezone: 'UTC', keepLocal: 7, keepOffsite: 30 },
  'backup.download': { backupId: newId('backup') },
  'backup.restore': { backupId: newId('backup') },
  'git.connect': { provider: 'github' },
  'preview.configure': { preview: { enabled: true } },
  'staging.create': { branch: 'develop' },
  'project.clone': { name: 'shop-copy' },
  'deploy.lock': { reason: 'the launch is today' },
  'freeze.add': {
    reason: 'the holidays',
    from: '2026-12-24T00:00:00Z',
    until: '2026-12-27T00:00:00Z',
  },
  'freeze.remove': { freezeId: newId('deployFreeze') },
  'sso.connect': {
    domain: 'acme.example',
    settings: {
      protocol: 'oidc',
      issuer: 'https://idp.example',
      clientId: 'vdeploy',
      clientSecret: 'not-a-real-secret',
    },
  },
  'sso.verify_domain': { providerId: 'org-acme-example' },
  'sso.disconnect': { providerId: 'org-acme-example' },
  'plugin.install': {
    manifest: {
      name: 'deploy-bot',
      description: 'Deploys when the build server says so',
      operations: ['project.list'],
    },
  },
  'plugin.uninstall': { pluginId: newId('plugin') },
  'cloud.connect': { provider: 'hetzner', name: 'main', token: 'not-a-real-token' },
  'cloud.disconnect': { cloudAccountId: newId('cloudAccount') },
  'cloud.offerings': { cloudAccountId: newId('cloudAccount') },
  'server.provision': {
    cloudAccountId: newId('cloudAccount'),
    name: 'web-1',
    region: 'fsn1',
    size: 'cx22',
  },
  'preview.open': {
    pullRequest: {
      provider: 'github',
      host: 'https://github.com',
      repo: 'acme/blog',
      number: 42,
      branch: 'fix-the-thing',
      title: 'Fix the thing',
    },
  },
  'git.connect_token': { provider: 'gitlab', token: 'not-a-real-token' },
  'git.disconnect': { connectionId: newId('gitConnection') },
  'volume.delete': { volume: 'uploads' },
  'project.move': { serverId: newId('server') },
  'status.configure': { slug: 'acme', title: 'Acme status', enabled: true, apps: [] },
  'compose.read': { file: 'services:\n  web:\n    image: nginx:1.27\n' },
  'files.list': { folder: 'uploads', path: '' },
  'files.download': { folder: 'uploads', path: 'invoice.pdf' },
  'volume.restore': { snapshotId: newId('backup') },
  'cron.delete': { name: 'nightly-report' },
  'secret.rotate': { secretId: newId('secret') },
  'secret.read_value': { secretId: newId('secret') },
  'task.run': { command: ['node', 'migrate.js'] },
  'server.add': { name: 'server-02' },
  'server.set_private_traffic': { enabled: true },
  'server.set_update_channel': { channel: 'canary' },
  'server.set_maintenance': { on: true },
  'database.expose': { port: 15432 },
  'registry.add': { host: 'ghcr.io', username: 'acme-bot', password: 'read-only-token' },
  'registry.remove': { registryId: newId('registry') },
  'dns_provider.set': { provider: 'cloudflare', credentials: { CF_DNS_API_TOKEN: 'token' } },
  'user.invite': { email: 'someone@example.com', role: 'developer' },
  'user.remove': { userId: newId('user') },
  'user.set_role': { userId: newId('user'), role: 'viewer' },
  'role.create': { name: 'Deployer', base: 'developer', operations: ['project.restart'] },
  'role.update': { roleId: newId('customRole'), name: 'Releaser' },
  'role.delete': { roleId: newId('customRole') },
  'role.assign': { userId: newId('user'), roleId: newId('customRole') },
  'team.create': { name: 'payments' },
  'team.delete': { teamId: newId('team') },
  'team.add_member': { teamId: newId('team'), userId: newId('user') },
  'team.remove_member': { teamId: newId('team'), userId: newId('user') },
  'project.set_team': { teamId: newId('team') },
  'audit.export': { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' },
  'api_key.create': { name: 'ci', scope: 'read' },
  'api_key.revoke': { keyId: 'key_01J9Z3Q8S7M2K4X6V1B5N0C9D8' },
  'urls.configure': { mode: 'wildcard', baseDomain: 'apps.example.com' },
  'ai.configure': { grants: DEFAULT_AI_GRANTS },
  'database.link': { databaseId: newId('database') },
  'database.unlink': { databaseId: newId('database') },
  'database.restore': { backupId: newId('backup'), mode: 'new' },
  'database.backup_policy': { policy: DEFAULT_BACKUP_POLICY },
  'database.import': { uploadId: newId('upload'), mode: 'new' },
  'dump.upload': { sha256: 'a'.repeat(64), size: 4096 },
  'backup.set_offsite': {
    repository: 's3:https://s3.eu-central-1.amazonaws.com/example/vdeploy',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'not-a-real-key',
  },
  'backup.dismiss_offsite_warning': { dismissed: true },
  'server.set_address': { ipv4: '8.8.4.4' },
  'server.check_reachability': {},
  'notification.channel_create': {
    name: 'ops',
    config: { kind: 'webhook', url: 'https://hooks.example.com/vdeploy' },
  },
  'notification.channel_update': { channelId: newId('notificationChannel'), enabled: false },
  'notification.channel_delete': { channelId: newId('notificationChannel') },
  'notification.channel_test': { channelId: newId('notificationChannel') },
  'notification.deliveries': {},
  'project.deploy_commit': { commit: 'a'.repeat(40) },
  'github.link': { installationId: 42, code: 'oauth-code' },
  'github.unlink': { installationId: 42 },
  'secret.generate': { name: 'session_key' },
  'secret.set': { name: 'stripe_key', value: 'sk_test_x' },
  'project.basic_auth': { users: [{ name: 'sam', password: 'twelve chars ok' }] },
  'env.import': { entries: [{ key: 'LOG_LEVEL', value: 'info' }] },
  'source.upload': { sha256: 'a'.repeat(64), size: 1024 },
  'source.detect': { serverId: newId('server'), uploadId: newId('upload') },
  'build.get': { buildId: newId('build') },
  'project.deploy_upload': { uploadId: newId('upload') },
  'storage.ignore_path': { path: '/app/tmp' },
};

/** A valid input for any operation, naming the given target. */
export function sampleInput(op: OperationDefinition, target: Target): Record<string, unknown> {
  const field = SCOPE_FIELD[op.scope];
  return {
    ...(field ? { [field]: target.id } : {}),
    ...EXTRA_INPUT[op.name as OperationName],
  };
}
