import { z } from 'zod';
import { idSchema } from '../ids.js';
import { ApplicationSpec } from '../spec/application.js';
import {
  Build,
  Deploy,
  EnvKey,
  Health,
  Network,
  Preview,
  ResourceName,
  Runtime,
  Scaling,
  Schedule,
} from '../spec/sections.js';
import { Memory } from '../spec/quantities.js';
import { AiGrants } from '../grants.js';
import { RestoreMode } from '../backups.js';
import { BackupPolicy, DatabaseEngine, DatabaseVersion } from '../databases.js';
import { FolderPath } from '../files.js';
import { ChannelConfig, NotificationTrigger } from '../notifications.js';
import { PluginManifest } from '../plugins.js';
import { PreviewRef } from '../previews.js';
import { EmailDomain, SsoSettings } from '../sso.js';
import { MAX_SECRET_BYTES, SecretName } from '../secrets.js';
import { UrlSettings } from '../urls.js';
import { operation, query, Role, type OperationDefinition } from './define.js';

const projectId = idSchema('project');
const serverId = idSchema('server');
const databaseId = idSchema('database');
const P = { projectId };
const S = { serverId };
const obj = z.strictObject;
const CronEntry = Schedule.shape.crons.unwrap().element;

/**
 * The operation catalog (§24). One definition per operation, consumed by the
 * API, the CLI, the AI tool registry, MCP and the dashboard forms. Adding a
 * capability means adding one entry here — and the policy engine gates it the
 * moment it exists.
 */
export const OPERATIONS = [
  // ── Tier 1 · safe ───────────────────────────────────────────────────────
  query('project.list', 'org', 'config', 'List projects and their health', obj({})),
  query('project.get', 'project', 'config', 'Show a project, its spec and current state', obj(P)),
  query(
    'project.logs',
    'project',
    'logs',
    'Read recent container log lines',
    obj({ ...P, tail: z.number().int().min(1).max(2000).default(200) }),
  ),
  query('project.metrics', 'project', 'metrics', 'Read CPU, memory and network usage', obj(P)),
  query(
    'project.diagnose',
    'project',
    'logs',
    'Explain in plain words why the app is not working, and what would fix it',
    obj(P),
  ),
  query('project.events', 'project', 'deployHistory', 'Read the project event timeline', obj(P)),
  query('deployment.list', 'project', 'deployHistory', 'List deployments of a project', obj(P)),
  query(
    'deployment.get',
    'project',
    'deployHistory',
    'Show one deployment and its outcome',
    obj({ ...P, deploymentId: idSchema('deployment') }),
  ),
  query(
    'deployment.logs',
    'project',
    'logs',
    'Read the build and deploy log of one deployment',
    obj({ ...P, deploymentId: idSchema('deployment') }),
  ),
  query('release.list', 'project', 'deployHistory', 'List releases of a project', obj(P)),
  query(
    'project.export',
    'project',
    'config',
    'Export an app as files that work without VDeploy: its spec, a Compose file, and its settings with secrets named but never shown',
    obj(P),
  ),
  // Undoing it is release.rollback to the release this names: one way back,
  // for the button, the AI and the API alike (§31 #9).
  query(
    'project.last_change',
    'project',
    'deployHistory',
    'Show what the last change to an app did, in plain words, and the release that undoes it',
    obj(P),
  ),
  query('build.list', 'project', 'deployHistory', 'List the builds of a project', obj(P)),
  query(
    'storage.status',
    'project',
    'config',
    'Show which folders keep their files across deploys, and which would lose them',
    obj(P),
  ),
  query(
    'build.get',
    'org',
    'deployHistory',
    'Show one build or detection: status, what was detected, and the end of its log',
    obj({ buildId: idSchema('build') }),
  ),
  query(
    'secret.list',
    'project',
    'secretNames',
    'List the secrets of a project: names and versions, never values',
    obj(P),
  ),
  query(
    'release.get',
    'project',
    'deployHistory',
    'Show one release',
    obj({ ...P, releaseId: idSchema('release') }),
  ),
  query(
    'server.list',
    'org',
    'metrics',
    'List the servers: whether each is connected, reachable, and how many apps it runs',
    obj({}),
  ),
  query(
    'server.status',
    'server',
    'metrics',
    'Show whether a server and its agent are healthy',
    obj(S),
  ),
  query('server.resources', 'server', 'metrics', 'Show server CPU, memory and disk usage', obj(S)),
  query('health.check', 'project', 'metrics', 'Run the health checks of a project now', obj(P)),
  query('urls.get', 'org', 'config', 'Show how projects get their instant URLs', obj({})),
  query(
    'cloud.list',
    'org',
    'config',
    'List the cloud accounts VDeploy can make servers in',
    obj({}),
  ),
  query(
    'cloud.offerings',
    'org',
    'config',
    'Show the sizes and places a cloud account offers, with what each costs a month',
    obj({ cloudAccountId: idSchema('cloudAccount') }),
  ),
  query(
    'plugin.list',
    'org',
    'config',
    'List the integrations this organization has allowed, and what each may do',
    obj({}),
  ),
  query(
    'sso.list',
    'org',
    'config',
    'List the identity providers this organization signs in through, and whether each is proved',
    obj({}),
  ),
  query(
    'staging.get',
    'project',
    'config',
    'Show this app staging copy, what each of them is running, and whether they differ',
    obj(P),
  ),
  query(
    'preview.list',
    'project',
    'config',
    'List the previews of this app, one per open pull request',
    obj(P),
  ),
  query(
    'git.connections',
    'org',
    'config',
    'List the Git hosts this organization can read private repositories from',
    obj({}),
  ),
  query(
    'project.uptime',
    'project',
    'metrics',
    'Show how much of the last days an app spent serving, and every outage',
    obj({ ...P, days: z.number().int().min(1).max(90).default(30) }),
  ),
  query('status.get', 'org', 'config', 'Show the public status page settings', obj({})),
  operation(
    'status.configure',
    'sensitive',
    'org',
    'Set up the public status page: its address, its title and the apps on it',
    obj({
      slug: z
        .string()
        .regex(/^[a-z]([a-z0-9-]{1,61}[a-z0-9])?$/, 'lowercase letters, digits and hyphens'),
      title: z.string().min(1).max(120),
      enabled: z.boolean(),
      apps: z
        .array(z.strictObject({ projectId: idSchema('project'), label: z.string().min(1).max(80) }))
        .max(50),
    }),
    { minRole: 'admin' },
  ),
  query(
    'compose.read',
    'org',
    'config',
    'Read a docker-compose file and say what bringing it across would make',
    obj({ file: z.string().min(1).max(256_000) }),
  ),
  query(
    'template.list',
    'org',
    'config',
    'List the apps you can set up in one step, and what each is for',
    obj({}),
  ),
  query(
    'database.list',
    'org',
    'config',
    'List the managed databases: engine, version, size and which apps use each',
    obj({}),
  ),
  query(
    'database.get',
    'database',
    'config',
    'Show one database, the apps linked to it, and how to reach it',
    obj({ databaseId }),
  ),
  query('task.list', 'project', 'deployHistory', 'List the runs of this app’s commands', obj(P)),
  query(
    'terminal.sessions',
    'org',
    'deployHistory',
    'List the terminal sessions people have opened, and what was recorded',
    obj({}),
  ),
  query(
    'backup.checks',
    'org',
    'config',
    'Show whether the backups have actually been put back, and when',
    obj({}),
  ),
  query(
    'backup.offsite',
    'org',
    'config',
    'Show where copies of the backups go, away from the server that made them',
    obj({}),
  ),
  query(
    'backup.list',
    'org',
    'config',
    'List the backups taken: when, how big, and whether each one was checked',
    obj({ databaseId: databaseId.optional() }),
  ),
  query(
    'backup.restores',
    'org',
    'config',
    'Show the restores that were run, and whether each one worked',
    obj({}),
  ),
  query(
    'ai.settings',
    'org',
    'config',
    'Show what the AI is allowed to see and do, and what it has cost this month',
    obj({}),
  ),
  query(
    'github.installations',
    'org',
    'config',
    'List the GitHub accounts connected through the VDeploy GitHub App',
    obj({}),
  ),
  query(
    'github.repositories',
    'org',
    'config',
    'List the repositories the connected GitHub accounts let VDeploy read',
    obj({}),
  ),
  query(
    'notification.channels',
    'org',
    'config',
    'List where notifications go: email lists and webhooks, and what each is told about',
    obj({}),
  ),
  query(
    'notification.deliveries',
    'org',
    'config',
    'Show recent notifications and whether each was delivered',
    obj({ channelId: idSchema('notificationChannel').optional() }),
  ),
  query(
    'domain.status',
    'project',
    'config',
    'Show whether each domain points to the server, and exactly what to change if not',
    obj(P),
  ),
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
    'server.check_reachability',
    'safe',
    'server',
    'Check from outside that visitors can reach the server on ports 80 and 443, and what to open if not',
    obj(S),
  ),
  operation(
    'notification.channel_test',
    'safe',
    'org',
    'Send a test notification to a channel',
    obj({ channelId: idSchema('notificationChannel') }),
  ),
  operation(
    'server.reclaim_safe',
    'safe',
    'server',
    'Free disk space from unused images and build cache, keeping every rollback target',
    obj(S),
  ),
  operation('backup.trigger', 'safe', 'project', 'Take a backup now', obj(P)),
  operation(
    'database.backup',
    'safe',
    'database',
    'Take a backup of this database now, and check that it can be read',
    obj({ databaseId }),
  ),
  operation(
    'backup.check_offsite',
    'safe',
    'org',
    'Prove the offsite target still accepts copies, and say so if it does not',
    obj({}),
  ),

  // ── Tier 2 · sensitive ──────────────────────────────────────────────────
  operation(
    'source.upload',
    'sensitive',
    'org',
    'Upload source code (a .tar.gz) to build and deploy',
    obj({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().positive() }),
  ),
  operation(
    'dump.upload',
    'sensitive',
    'org',
    'Upload a database dump from somewhere else, to load into a database here',
    obj({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().positive() }),
  ),
  operation(
    'source.detect',
    'safe',
    'org',
    'Preview how uploaded source would be built, before deploying it',
    obj({ serverId, uploadId: idSchema('upload') }),
  ),
  operation(
    'project.deploy_commit',
    'sensitive',
    'project',
    "Build and deploy a commit of the project's GitHub branch (the latest when none is named)",
    obj({
      ...P,
      commit: z
        .string()
        .regex(/^[0-9a-f]{40}$/, 'must be a full commit id')
        .optional(),
    }),
  ),
  operation(
    'github.link',
    'sensitive',
    'org',
    'Connect a GitHub account where the VDeploy GitHub App was installed (proved with the code GitHub returns)',
    obj({
      installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      code: z.string().min(1).max(256),
    }),
    { minRole: 'admin' },
  ),
  operation(
    'github.unlink',
    'sensitive',
    'org',
    'Disconnect a GitHub account from this organization (the app stays installed on GitHub)',
    obj({ installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
    { minRole: 'admin' },
  ),
  operation(
    'notification.channel_create',
    'sensitive',
    'org',
    'Add an email list or a webhook that is told about failures (a webhook gets a signing secret, shown once)',
    obj({
      name: z.string().min(1).max(80),
      config: ChannelConfig,
      triggers: z.array(NotificationTrigger).max(20).optional(),
    }),
    { minRole: 'admin' },
  ),
  operation(
    'notification.channel_update',
    'sensitive',
    'org',
    'Rename a notification channel, change what it is told about, or pause it',
    obj({
      channelId: idSchema('notificationChannel'),
      name: z.string().min(1).max(80).optional(),
      triggers: z.array(NotificationTrigger).max(20).optional(),
      enabled: z.boolean().optional(),
    }),
    { minRole: 'admin' },
  ),
  operation(
    'notification.channel_delete',
    'sensitive',
    'org',
    'Remove a notification channel',
    obj({ channelId: idSchema('notificationChannel') }),
    { minRole: 'admin' },
  ),
  operation(
    'server.set_address',
    'sensitive',
    'server',
    'Set the public address a server is reached at, when it cannot be detected; empty goes back to detection',
    obj({ ...S, ipv4: z.ipv4().nullable(), ipv6: z.ipv6().nullable().default(null) }),
    { minRole: 'admin' },
  ),
  operation(
    'project.create',
    'sensitive',
    'org',
    'Create a new project from a spec',
    obj({ spec: ApplicationSpec, serverId: serverId.optional() }),
  ),
  operation(
    'project.deploy_upload',
    'sensitive',
    'project',
    'Build and deploy an uploaded folder or archive as the new version of this project',
    obj({ ...P, uploadId: idSchema('upload') }),
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
    'Set an environment variable (secrets by reference only); build settings apply at build time',
    obj({
      ...P,
      key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,254}$/),
      value: z.string().max(32_768).optional(),
      secretRef: idSchema('secret').optional(),
      target: z.enum(['runtime', 'build']).default('runtime'),
    }).refine((i) => (i.value === undefined) !== (i.secretRef === undefined), {
      message: 'exactly one of value or secretRef',
    }),
  ),
  operation(
    'env.unset',
    'sensitive',
    'project',
    'Remove an environment variable',
    obj({
      ...P,
      key: z.string().min(1).max(255),
      target: z.enum(['runtime', 'build']).default('runtime'),
    }),
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
      version: DatabaseVersion.optional(),
      size: Memory.optional(),
      memoryLimit: Memory.optional(),
    }),
  ),
  operation(
    'database.link',
    'sensitive',
    'project',
    'Give an app its database: the connection string arrives as one of its settings',
    obj({
      ...P,
      databaseId,
      envKey: EnvKey.optional(),
      /**
       * For apps that want the address in pieces rather than as one URL —
       * WordPress and Ghost among them. Each piece becomes its own setting,
       * and the password is still a secret the app reads and nobody sees.
       */
      parts: z.record(z.enum(['host', 'port', 'user', 'password', 'name']), EnvKey).optional(),
    }),
  ),
  operation(
    'database.unlink',
    'sensitive',
    'project',
    'Take a database away from an app; the data stays',
    obj({ ...P, databaseId }),
  ),
  operation(
    'database.backup_policy',
    'sensitive',
    'database',
    'Change when this database is backed up and how many copies are kept',
    obj({ databaseId, policy: BackupPolicy }),
  ),
  operation(
    'backup.dismiss_offsite_warning',
    'sensitive',
    'org',
    'Accept that backups live only on the servers that made them, and stop warning about it',
    obj({ dismissed: z.boolean().default(true) }),
    { minRole: 'admin' },
  ),
  operation(
    'database.stop',
    'sensitive',
    'database',
    'Stop a database; apps using it lose their data connection until it starts again',
    obj({ databaseId }),
  ),
  operation(
    'database.start',
    'sensitive',
    'database',
    'Start a stopped database',
    obj({ databaseId }),
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
    'cron.delete',
    'sensitive',
    'project',
    'Remove a scheduled job, so it stops running',
    obj({ ...P, name: ResourceName }),
  ),
  operation(
    'release.rollback',
    'sensitive',
    'project',
    'Return to an earlier release, exactly as it was',
    obj({ ...P, releaseId: idSchema('release') }),
  ),
  operation(
    'build.configure',
    'sensitive',
    'project',
    'Choose which server compiles this app, and whether it keeps a layer cache',
    obj({
      ...P,
      /** Null puts the build back on the server the app runs on. */
      builder: serverId.nullable(),
      cache: Build.shape.cache.optional(),
    }),
  ),
  operation(
    'volume.create',
    'sensitive',
    'project',
    'Add a permanent folder',
    obj({ ...P, volume: Runtime.shape.volumes.unwrap().element }),
  ),
  operation(
    'storage.ignore_path',
    'sensitive',
    'project',
    'Mark a flagged folder as only temporary, so it stops being flagged',
    obj({ ...P, path: Runtime.shape.volumes.unwrap().element.shape.mountPath }),
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
    'git.connect',
    'sensitive',
    'org',
    'Start connecting a Git provider: answers with where to go to install it',
    // §24 writes this as taking an installation id. It does not, and
    // deliberately: an installation belongs to whoever can see it on the
    // provider, and a bare id proves nothing (ADR 0010). This hands back
    // the place to go; `github.link` finishes it with the code the provider
    // returns, which is the proof.
    obj({ provider: z.enum(['github']) }),
    { minRole: 'admin' },
  ),
  // A staging copy is made from the app, so the app is what it is scoped
  // to — and promoting is scoped to the app as well, because production
  // is the thing being changed.
  operation(
    'staging.create',
    'sensitive',
    'project',
    'Make a staging copy of this app that follows another branch',
    obj({ ...P, branch: z.string().min(1).max(255) }),
    { minRole: 'admin' },
  ),
  operation(
    'staging.promote',
    'sensitive',
    'project',
    'Run in production exactly what staging has been running',
    obj(P),
    { minRole: 'admin', stepUp: true },
  ),
  operation(
    'preview.configure',
    'sensitive',
    'project',
    'Turn previews on or off for this app, and set how many and for how long',
    obj({ ...P, preview: Preview }),
  ),
  // Opening and closing a preview is what a pull request does to itself.
  // They are operations rather than something the webhook does directly so
  // that a preview is planned, gated and audited like every other change —
  // and so a person can make or remove one by hand.
  operation(
    'preview.open',
    'sensitive',
    'project',
    'Create the preview of one pull request of this app',
    obj({ ...P, pullRequest: PreviewRef }),
  ),
  // Closing a preview is not deleting an app: nobody put anything in it,
  // it was created automatically, and reopening the pull request makes it
  // again. So it is sensitive, and can happen without waking anybody, which
  // is the only way a preview ever actually goes away.
  operation(
    'preview.close',
    'sensitive',
    'project',
    'Take down a preview and everything it made; the app it previews is untouched',
    obj(P),
  ),
  // A token that can make servers can also make a bill, so connecting
  // one is tier 4 like every other pasted credential (ADR 0024).
  operation(
    'cloud.connect',
    'human_only',
    'org',
    'Let VDeploy make servers in your account at a cloud provider',
    obj({
      provider: z.enum(['hetzner', 'digitalocean', 'vultr']),
      name: ResourceName,
      token: z.string().min(8).max(500),
    }),
    { minRole: 'owner', stepUp: true },
  ),
  operation(
    'cloud.disconnect',
    'sensitive',
    'org',
    'Forget a cloud account; the servers it made keep running',
    obj({ cloudAccountId: idSchema('cloudAccount') }),
    { minRole: 'admin' },
  ),
  // Making a machine spends somebody's money every month it exists.
  // Tier 4, like 'server.add' beside it, which only adds a machine
  // somebody already has and pays for: a platform whose assistant can
  // order servers is one whose assistant can run up a bill, and no
  // grant in §8 counts money that is not tokens.
  operation(
    'server.provision',
    'human_only',
    'org',
    'Make a new server at a cloud provider and connect it, all in one step',
    obj({
      cloudAccountId: idSchema('cloudAccount'),
      name: ResourceName,
      region: z.string().min(1).max(64),
      size: z.string().min(1).max(64),
      role: z.enum(['apps', 'builder', 'edge']).default('apps'),
      /** Keys already at the provider, so a person is not locked out. */
      sshKeys: z.array(z.string().min(1).max(128)).max(16).default([]),
    }),
    { minRole: 'admin', stepUp: true },
  ),
  // Allowing an integration is tier 4 because it hands out a key that
  // can call VDeploy. What makes that safe is that the list of what it
  // may call is written down, shown to the person approving it, and
  // enforced above whatever its role would otherwise allow (ADR 0023) —
  // and that reading a list and agreeing to it is a thing only a person
  // can do.
  operation(
    'plugin.install',
    'human_only',
    'org',
    'Allow an integration to call a named list of operations, and give it a key',
    obj({ manifest: PluginManifest }),
    { minRole: 'owner', stepUp: true },
  ),
  operation(
    'plugin.uninstall',
    'sensitive',
    'org',
    'Remove an integration and the key it was given',
    obj({ pluginId: idSchema('plugin') }),
    { minRole: 'admin' },
  ),
  // Connecting an identity provider is tier 4 for the same reason
  // 'secret.set' is: it takes a client secret or a signing certificate
  // somebody pasted. It also decides who can sign in to this
  // organization, which is not a thing to let anything but a person do.
  operation(
    'sso.connect',
    'human_only',
    'org',
    'Let people with an email at this domain sign in through your identity provider',
    obj({ domain: EmailDomain, settings: SsoSettings }),
    { minRole: 'owner', stepUp: true },
  ),
  operation(
    'sso.verify_domain',
    'sensitive',
    'org',
    'Check the DNS record that proves this organization owns the domain',
    obj({ providerId: z.string().min(1).max(200) }),
    { minRole: 'admin' },
  ),
  operation(
    'sso.disconnect',
    'sensitive',
    'org',
    'Stop accepting sign-ins through an identity provider',
    obj({ providerId: z.string().min(1).max(200) }),
    { minRole: 'owner', stepUp: true },
  ),
  // GitLab and Bitbucket have no app to install: they take an access token
  // the person makes themselves, which is why connecting them is one call
  // rather than a round trip through the provider (ADR 0019).
  // Tier 4 for the same reason 'secret.set' is: it takes a credential a
  // person pasted. No AI session is offered a tool that wants one.
  operation(
    'git.connect_token',
    'human_only',
    'org',
    'Connect GitLab or Bitbucket with a read-only access token, including a company-run GitLab',
    obj({
      provider: z.enum(['gitlab', 'bitbucket']),
      host: z.url().max(300).optional(),
      token: z.string().min(8).max(500),
    }),
    { minRole: 'admin', stepUp: true },
  ),
  operation(
    'git.disconnect',
    'sensitive',
    'org',
    'Forget a Git host and the token stored for it',
    obj({ connectionId: idSchema('gitConnection') }),
    { minRole: 'admin' },
  ),

  // ── Tier 3 · destructive — always explicit approval, snapshot first ──────
  operation(
    'project.delete',
    'destructive',
    'project',
    'Delete a project; its data is kept unless you choose otherwise',
    obj({ ...P, keepData: z.boolean().default(true) }),
  ),
  // Putting files back is destructive in the same way restoring a database
  // is: what is there now goes, so the app stops while it happens.
  /*
   * Emptying a server (§20 Servers). It answers with what it would move
   * and where each one would go — it starts nothing itself, because a move
   * is destructive and each one is confirmed on its own. Emptying a
   * machine by accident is not a mistake anybody should be able to make in
   * one click.
   */
  query(
    'server.drain',
    'server',
    'config',
    'Show what moving everything off this server would mean, and where each app would go',
    obj(S),
  ),
  operation(
    'volume.restore',
    'destructive',
    'project',
    'Put the files from a snapshot back, replacing what is in those folders now',
    obj({ ...P, snapshotId: idSchema('backup') }),
  ),
  operation(
    'volume.snapshot',
    'safe',
    'project',
    'Keep a copy of everything in this app’s permanent folders now',
    obj(P),
  ),
  /*
   * Moving an app to another server (§17.6).
   *
   * Destructive because it stops the app and writes its folders somewhere
   * else — and because §17.6 says a move is explicit, orchestrated and
   * confirmed, never a silent reschedule. The copy it takes first is what
   * makes it recoverable; the folders it leaves behind are what makes it
   * reversible.
   */
  operation(
    'project.move',
    'destructive',
    'project',
    'Move this app, and its files, to another server',
    obj({ ...P, serverId }),
  ),
  // A folder is named, not an app: by the time data can be deleted nothing
  // is mounting it, and the app that owned it may not exist any more.
  operation(
    'volume.delete',
    'destructive',
    'server',
    'Delete a permanent folder and everything in it, after taking a copy',
    obj({ ...S, volume: z.string().min(1).max(128) }),
  ),
  // Looking at what an app wrote, and taking one file away with you (§20
  // Runtime). Both read the app's own files, which is the one read category
  // the AI is not granted by default.
  query(
    'files.list',
    'project',
    'sourceFiles',
    'List what is in one of an app’s permanent folders',
    obj({ ...P, folder: ResourceName, path: FolderPath.default('') }),
  ),
  // Tier 4 because the file leaves VDeploy, as a backup does — not because
  // it is dangerous. The role and the password stay proportionate to one
  // file out of an uploads folder; what the tier buys is that the assistant
  // can never be the one taking a customer's data off their server.
  operation(
    'files.download',
    'human_only',
    'project',
    'Download one file out of an app’s permanent folder',
    obj({ ...P, folder: ResourceName, path: FolderPath.refine((p) => p !== '', 'name a file') }),
    { minRole: 'developer', stepUp: false },
  ),
  // Sensitive as an intent; the plan raises it to destructive when it would
  // replace live data, which is what the gate then confirms.
  operation(
    'database.restore',
    'sensitive',
    'database',
    'Put a backup back: into a new database, or over this one',
    obj({
      databaseId,
      backupId: idSchema('backup'),
      mode: RestoreMode.default('new'),
      newName: ResourceName.optional(),
    }),
  ),
  // The way in from anywhere else (§17.5). Sensitive as an intent; the plan
  // raises it to destructive when it would load over data that is already here.
  operation(
    'database.import',
    'sensitive',
    'database',
    'Load a dump from somewhere else into a database here — the way in from another host',
    obj({
      databaseId,
      uploadId: idSchema('upload'),
      mode: RestoreMode.default('new'),
      newName: ResourceName.optional(),
    }),
  ),
  operation(
    'database.delete',
    'destructive',
    'database',
    'Delete a database and everything in it',
    obj({ databaseId, keepData: z.boolean().default(false) }),
  ),
  operation(
    'secret.generate',
    'sensitive',
    'project',
    'Create or replace a secret with a random value made on the server, so no one sees it',
    obj({
      ...P,
      name: SecretName,
      length: z.number().int().min(16).max(256).default(40),
      alphabet: z.enum(['alphanumeric', 'hex']).default('alphanumeric'),
    }),
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
    // Sensitive as an intent, like restoring a database on its own: putting
    // a copy back *beside* what is live touches nothing, and that is the
    // way people should check a backup. The plan raises it to destructive
    // the moment it would replace something.
    'sensitive',
    'project',
    'Restore a backup, to a new database by default',
    obj({ ...P, backupId: idSchema('backup'), mode: z.enum(['new', 'in_place']).default('new') }),
  ),

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
    'secret.set',
    'human_only',
    'project',
    'Store a secret value; it can be replaced but never shown again without step-up',
    obj({
      ...P,
      name: SecretName,
      value: z
        .string()
        .min(1)
        .refine((v) => new TextEncoder().encode(v).length <= MAX_SECRET_BYTES, 'at most 32 KiB'),
    }),
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
    'backup.set_offsite',
    'human_only',
    'org',
    'Send copies of every backup to storage of your own, away from the servers',
    obj({
      repository: z.string().min(1).max(512),
      accessKeyId: z.string().min(1).max(256),
      secretAccessKey: z.string().min(1).max(512),
      region: z.string().max(64).optional(),
      /**
       * The key that unlocks the repository. Left out, VDeploy makes one and
       * shows it once; given, it is an existing repository being re-attached.
       */
      password: z.string().min(8).max(512).optional(),
    }),
    { minRole: 'admin', stepUp: true },
  ),
  operation(
    'backup.download',
    'human_only',
    'org',
    'Download a backup as a plain file you own — the whole database leaves VDeploy',
    obj({ backupId: idSchema('backup') }),
    { stepUp: true },
  ),
  operation(
    'backup.remove_offsite',
    'human_only',
    'org',
    'Stop sending copies away; what is already there stays where it is',
    obj({}),
    { minRole: 'admin', stepUp: true },
  ),
  operation(
    'server.add',
    'human_only',
    'org',
    'Create a server enrollment token',
    obj({
      name: ResourceName,
      /**
       * A builder compiles for the others and runs nothing (§15); an edge
       * answers the internet for the others and runs nothing (§13).
       */
      role: z.enum(['apps', 'builder', 'edge']).default('apps'),
    }),
    { stepUp: true },
  ),
  operation(
    'server.set_private_traffic',
    'human_only',
    'server',
    "Let this organization's other servers reach this one privately",
    obj({
      ...S,
      enabled: z.boolean(),
      /**
       * Where the others reach it, when that is not the address the
       * internet uses: two servers in one datacentre usually talk over a
       * private network, and a machine behind NAT has no public address at
       * all. Absent means 'the address VDeploy already knows'.
       */
      address: z.string().max(255).optional(),
    }),
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
    'urls.configure',
    'human_only',
    'org',
    'Choose how projects get instant URLs; old addresses redirect to the new ones',
    UrlSettings,
  ),
  operation(
    'audit.export',
    'human_only',
    'org',
    'Export the audit log',
    obj({ from: z.iso.datetime(), to: z.iso.datetime() }),
  ),
  operation(
    'api_key.create',
    'human_only',
    'org',
    'Create an API key; it is shown exactly once',
    obj({
      name: z.string().trim().min(1).max(100),
      scope: z.enum(['read', 'deploy', 'admin']),
      expiresInDays: z.number().int().min(1).max(365).default(90),
    }),
    { stepUp: true },
  ),
  operation(
    'api_key.revoke',
    'human_only',
    'org',
    'Revoke an API key immediately',
    obj({ keyId: z.string().min(1).max(64) }),
  ),
  operation(
    'ai.configure',
    'human_only',
    'org',
    'Change what the AI is allowed to see and do',
    obj({ grants: AiGrants }),
    { stepUp: true },
  ),
  // The kill switch: always one click, never a re-authentication away (§8 L7).
  operation('ai.stop', 'human_only', 'org', 'Turn the AI off for this organization', obj({})),
  operation(
    'server.enrollment_token',
    'human_only',
    'server',
    'Create a one-time command that connects this server',
    obj(S),
    { stepUp: true },
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
