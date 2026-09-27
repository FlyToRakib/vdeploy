import { ApplicationSpec, VDeployError, type DatabaseEngine } from '@vdeploy/contracts';

/**
 * The template catalog (§15, §26): the apps a non-coder actually came here
 * to run, each as a recipe rather than as an instruction to read.
 *
 * A template is **data, and only data**. It produces an ordinary spec that
 * goes through the same planner, the same gate and the same agent guard as
 * anything else — so there is no field here that could grant a privilege
 * the spec cannot express, and picking a template can never be a way in.
 *
 * Two things every recipe gets right that a person following a README
 * usually does not:
 *
 *   - the folders that must survive a deploy, named up front, so the first
 *     upgrade does not delete every upload;
 *   - the settings the app cannot start without, including the ones that
 *     must be secret and different on every install.
 *
 * Images are named by tag. The deploy pipeline resolves a tag to a digest
 * and pins the release to it, exactly as it does for any other image
 * project: what runs is a digest, and it does not move underneath anybody.
 */

/** A setting the app needs. */
export interface TemplateSetting {
  key: string;
  /** A fixed value; absent means it is generated or comes from the database. */
  value?: string;
  /**
   * Bytes of randomness VDeploy makes on the server, stored as a secret and
   * never shown. An app whose encryption key came from its own README is an
   * app every install of which shares a key.
   */
  generate?: number;
  /** Which part of the linked database this carries. */
  from?: 'host' | 'port' | 'user' | 'password' | 'name' | 'url';
}

/** A database this app cannot run without. */
export interface TemplateDatabase {
  engine: DatabaseEngine;
  version: string;
}

export interface Template {
  name: string;
  title: string;
  /** One sentence, in the words somebody would use to search for it. */
  what: string;
  /** What it is actually good for, said plainly. */
  goodFor: string;
  image: string;
  port: number;
  memory: string;
  /** Folders whose files must outlive every deploy. */
  volumes: { name: string; mountPath: string }[];
  settings: TemplateSetting[];
  database?: TemplateDatabase;
  /** An HTTP path that answers once it is up; absent falls back to a TCP check. */
  healthPath?: string;
  /** What is still left to do once it is running, in one sentence. */
  afterwards: string;
}

export const TEMPLATES: readonly Template[] = [
  {
    name: 'wordpress',
    title: 'WordPress',
    what: 'The website and blog software about half the web runs on.',
    goodFor: 'A blog, a shop, a company site — anything you want to edit without code.',
    image: 'wordpress:6-apache',
    port: 80,
    memory: '512Mi',
    // Themes, plugins and every uploaded image live here. This one folder is
    // the difference between an upgrade and a disaster.
    volumes: [{ name: 'content', mountPath: '/var/www/html' }],
    settings: [
      { key: 'WORDPRESS_DB_HOST', from: 'host' },
      { key: 'WORDPRESS_DB_USER', from: 'user' },
      { key: 'WORDPRESS_DB_PASSWORD', from: 'password' },
      { key: 'WORDPRESS_DB_NAME', from: 'name' },
    ],
    database: { engine: 'mariadb', version: '11' },
    afterwards: 'Open the site and pick a username and password for yourself.',
  },
  {
    name: 'ghost',
    title: 'Ghost',
    what: 'Publishing software for writers, with paid subscriptions built in.',
    goodFor: 'A newsletter or a magazine you charge for.',
    image: 'ghost:5-alpine',
    port: 2368,
    memory: '768Mi',
    volumes: [{ name: 'content', mountPath: '/var/lib/ghost/content' }],
    settings: [
      { key: 'database__client', value: 'mysql' },
      { key: 'database__connection__host', from: 'host' },
      { key: 'database__connection__port', from: 'port' },
      { key: 'database__connection__user', from: 'user' },
      { key: 'database__connection__password', from: 'password' },
      { key: 'database__connection__database', from: 'name' },
      { key: 'NODE_ENV', value: 'production' },
    ],
    database: { engine: 'mysql', version: '8.4' },
    afterwards: 'Go to /ghost to make your account, and set the site address in its settings.',
  },
  {
    name: 'umami',
    title: 'Umami',
    what: 'Website statistics that do not follow your visitors around.',
    goodFor: 'Seeing what people read, without cookie banners.',
    image: 'ghcr.io/umami-software/umami:postgresql-v2',
    port: 3000,
    memory: '512Mi',
    volumes: [],
    settings: [
      { key: 'DATABASE_URL', from: 'url' },
      // Every install gets its own; a shared one would let anybody sign sessions.
      { key: 'APP_SECRET', generate: 32 },
    ],
    database: { engine: 'postgres', version: '17' },
    healthPath: '/api/heartbeat',
    afterwards: 'Sign in as admin with the password umami, and change it at once.',
  },
  {
    name: 'n8n',
    title: 'n8n',
    what: 'Joins your tools together: when this happens, do that.',
    goodFor: 'Automating the copying between forms, spreadsheets and email.',
    image: 'docker.n8n.io/n8nio/n8n:1',
    port: 5678,
    memory: '768Mi',
    volumes: [{ name: 'data', mountPath: '/home/node/.n8n' }],
    settings: [
      // Without this, n8n makes its own on first start and every rebuild
      // loses the credentials it encrypted.
      { key: 'N8N_ENCRYPTION_KEY', generate: 32 },
      { key: 'DB_TYPE', value: 'postgresdb' },
      { key: 'DB_POSTGRESDB_HOST', from: 'host' },
      { key: 'DB_POSTGRESDB_PORT', from: 'port' },
      { key: 'DB_POSTGRESDB_USER', from: 'user' },
      { key: 'DB_POSTGRESDB_PASSWORD', from: 'password' },
      { key: 'DB_POSTGRESDB_DATABASE', from: 'name' },
    ],
    database: { engine: 'postgres', version: '17' },
    healthPath: '/healthz',
    afterwards: 'Open it and make the owner account before anyone else finds it.',
  },
  {
    name: 'uptime-kuma',
    title: 'Uptime Kuma',
    what: 'Watches your sites and tells you the moment one stops answering.',
    goodFor: 'Knowing your site is down before a customer tells you.',
    image: 'louislam/uptime-kuma:1',
    port: 3001,
    memory: '256Mi',
    volumes: [{ name: 'data', mountPath: '/app/data' }],
    settings: [],
    afterwards: 'Open it, make your account, and add the first thing to watch.',
  },
  {
    name: 'vaultwarden',
    title: 'Vaultwarden',
    what: 'A password manager only you hold the keys to, which Bitwarden apps can use.',
    goodFor: 'Sharing passwords with a small team without a subscription.',
    image: 'vaultwarden/server:1',
    port: 80,
    memory: '256Mi',
    volumes: [{ name: 'data', mountPath: '/data' }],
    // The admin page is off unless a token exists, and a guessable one is
    // worse than no admin page at all.
    settings: [{ key: 'ADMIN_TOKEN', generate: 48 }],
    healthPath: '/alive',
    afterwards: 'Open it and make your account. Turn off new sign-ups once everyone is in.',
  },
  {
    name: 'gitea',
    title: 'Gitea',
    what: 'Your own place to keep code, with issues and pull requests.',
    goodFor: 'Private repositories without paying per person.',
    image: 'gitea/gitea:1',
    port: 3000,
    memory: '512Mi',
    volumes: [{ name: 'data', mountPath: '/data' }],
    settings: [{ key: 'GITEA__server__ROOT_URL', value: '' }],
    afterwards: 'Finish the short setup page, and make the first account — it becomes the admin.',
  },
] as const;

/** One template by name, or null. */
export function findTemplate(name: string): Template | null {
  return TEMPLATES.find((t) => t.name === name) ?? null;
}

/**
 * The spec a template stands for. What is stored and approved is this — an
 * ordinary image project — not the word "wordpress": the gate shows the
 * person what will actually run, and the agent never learns that a template
 * was involved at all.
 *
 * Settings that carry part of a database, or that VDeploy generates, are
 * deliberately absent: they are added once the project exists and can own
 * secrets, by the steps that follow.
 */
export function templateSpec(templateName: string, projectName: string): ApplicationSpec {
  const template = findTemplate(templateName);
  if (!template) {
    throw new VDeployError('not_found', `There is no template called ${templateName}`);
  }
  return ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: {
      name: projectName,
      // Kept so the screen can say where this came from; nothing reads it to decide anything.
      labels: { template: template.name },
    },
    source: { type: 'image', image: template.image },
    build: { strategy: 'image' },
    runtime: {
      resources: { memory: { request: template.memory, limit: template.memory } },
      volumes: template.volumes,
      env: template.settings
        .filter((s) => s.value !== undefined && s.generate === undefined && s.from === undefined)
        .map((s) => ({ key: s.key, value: s.value ?? '' })),
    },
    network: { containerPort: template.port },
    ...(template.healthPath
      ? { health: { startup: { type: 'http', path: template.healthPath } } }
      : {}),
  });
}

/** The settings a template needs VDeploy to make up, once the project exists. */
export function templateSecrets(templateName: string): { key: string; bytes: number }[] {
  const template = findTemplate(templateName);
  return (template?.settings ?? [])
    .filter((s) => s.generate !== undefined)
    .map((s) => ({ key: s.key, bytes: s.generate ?? 32 }));
}

/** How a template wants its database given to it: as parts, or as one address. */
export function templateLink(
  templateName: string,
): { parts: Record<string, string> } | { envKey: string } | null {
  const template = findTemplate(templateName);
  if (!template?.database) return null;
  const url = template.settings.find((s) => s.from === 'url');
  if (url) return { envKey: url.key };
  const parts: Record<string, string> = {};
  for (const setting of template.settings) {
    if (setting.from && setting.from !== 'url') parts[setting.from] = setting.key;
  }
  return Object.keys(parts).length > 0 ? { parts } : null;
}
