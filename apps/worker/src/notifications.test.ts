import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { newId, type ObservedReport } from '@vdeploy/contracts';
import { verifyWebhook } from '@vdeploy/core';
import {
  createChannel,
  listDeliveries,
  notificationChannels,
  notificationDeliveries,
  notify,
  notifyFromReport,
  notifyOfflineServers,
  organization,
  projects,
  servers,
} from '@vdeploy/db';
import { startTestDatabase, type TestDatabase } from '@vdeploy/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { safePoster, sendDueNotifications, type NotifierDeps } from './notifications.js';

let t: TestDatabase;
let orgId: string;
const SECRETS = Buffer.alloc(32, 5);
let clock = new Date('2026-09-20T10:00:00Z');
const mail: { to: string; subject: string; text: string }[] = [];
const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
let answer = 204;

function deps(overrides: Partial<NotifierDeps> = {}): NotifierDeps {
  return {
    db: t.db,
    secretsKey: SECRETS,
    now: () => clock,
    mailer: {
      send: (m) => {
        mail.push(m);
        return Promise.resolve();
      },
    },
    post: (url, body, headers) => {
      posts.push({ url, body, headers });
      return Promise.resolve(answer);
    },
    publicUrl: 'https://vdeploy.example.com',
    ...overrides,
  };
}

async function freshOrg() {
  orgId = newId('organization');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
}

beforeAll(async () => {
  t = await startTestDatabase();
}, 120_000);

beforeEach(async () => {
  await freshOrg();
  mail.length = 0;
  posts.length = 0;
  answer = 204;
  clock = new Date('2026-09-20T10:00:00Z');
});

afterAll(async () => {
  await t.stop();
});

const failed = (projectId: string, key = 'plan:1') => ({
  trigger: 'deploy_failed' as const,
  key,
  title: 'Deploy of blog failed',
  message: 'Your app answers on port 8080, but we are knocking on port 3000.',
  projectId,
});

describe('notifications', () => {
  it('signs each webhook delivery with the channel secret, and links to the dashboard', async () => {
    const { channel, signingSecret } = await createChannel(
      t.db,
      SECRETS,
      {
        orgId,
        name: 'ops',
        config: { kind: 'webhook', url: 'https://hooks.example.com/x' },
        triggers: ['deploy_failed'],
      },
      clock,
    );
    expect(signingSecret).toMatch(/^whsec_/);
    const projectId = newId('project');
    expect(await notify(t.db, orgId, failed(projectId), clock)).toBe(1);
    expect(await sendDueNotifications(deps())).toBe(1);
    const [post] = posts;
    expect(post?.headers['x-vdeploy-event']).toBe('deploy_failed');
    expect(
      verifyWebhook(
        signingSecret!,
        post!.body,
        post!.headers['x-vdeploy-signature']!,
        clock.getTime() / 1000,
      ),
    ).toBe(true);
    const body = JSON.parse(post!.body) as { link: string; message: string };
    expect(body.link).toBe(`https://vdeploy.example.com/projects/${projectId}`);
    expect(body.message).toMatch(/port 8080/);
    // The secret is stored sealed, never as given.
    const deliveries = await listDeliveries(t.db, orgId, channel.id);
    expect(deliveries[0]?.status).toBe('sent');
  });

  it('posts to Slack, Discord and Telegram, keeping each address sealed and out of sight', async () => {
    const slackUrl = 'https://hooks.slack.com/services/T0/B0/secretpart';
    const discordUrl = 'https://discord.com/api/webhooks/123/secret-token';
    const botToken = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
    const made = await Promise.all(
      [
        { kind: 'slack' as const, webhookUrl: slackUrl },
        { kind: 'discord' as const, webhookUrl: discordUrl },
        { kind: 'telegram' as const, botToken, chatId: '-1001234567890' },
      ].map((config) =>
        createChannel(
          t.db,
          SECRETS,
          { orgId, name: config.kind, config, triggers: ['deploy_failed'] },
          clock,
        ),
      ),
    );
    // Nothing a chat can be posted to with is kept in the open, or handed back.
    for (const { channel, signingSecret } of made) {
      expect(signingSecret).toBeNull();
      expect(JSON.stringify(channel)).not.toMatch(/secret|ABCDEFG/);
    }
    const stored = JSON.stringify(await t.db.select().from(notificationChannels));
    expect(stored).not.toContain(slackUrl);
    expect(stored).not.toContain(botToken);

    const projectId = newId('project');
    await notify(
      t.db,
      orgId,
      { ...failed(projectId), title: 'Deploy of <blog> failed', message: 'hi @everyone' },
      clock,
    );
    expect(await sendDueNotifications(deps())).toBe(3);
    const to = (prefix: string) => posts.find((p) => p.url.startsWith(prefix));

    const slack = JSON.parse(to(slackUrl)!.body) as { text: string };
    expect(slack.text).toContain('*Deploy of &lt;blog&gt; failed*');
    expect(slack.text).toContain(
      `<https://vdeploy.example.com/projects/${projectId}|Open in VDeploy>`,
    );

    const discord = JSON.parse(to(discordUrl)!.body) as {
      content: string;
      allowed_mentions: { parse: string[] };
    };
    expect(discord.content).toContain('hi @everyone');
    expect(discord.allowed_mentions.parse).toEqual([]);

    const telegram = JSON.parse(
      to(`https://api.telegram.org/bot${botToken}/sendMessage`)!.body,
    ) as {
      chat_id: string;
      text: string;
    };
    expect(telegram.chat_id).toBe('-1001234567890');
    expect(telegram.text).toMatch(/^Deploy of <blog> failed\n/);

    // A chat that turns the message away says so, by name.
    answer = 404;
    await notify(t.db, orgId, failed(projectId, 'plan:2'), clock);
    await sendDueNotifications(deps());
    const errors = (await t.db.select().from(notificationDeliveries)).map((d) => d.lastError);
    expect(errors).toContain('Slack answered HTTP 404');
    expect(errors).toContain('Telegram answered HTTP 404');
  });

  it('tells each cause once, and only to channels that want it', async () => {
    await createChannel(
      t.db,
      SECRETS,
      {
        orgId,
        name: 'team',
        config: { kind: 'email', to: ['a@example.com', 'b@example.com'] },
        triggers: ['server_offline'],
      },
      clock,
    );
    const projectId = newId('project');
    expect(await notify(t.db, orgId, failed(projectId), clock)).toBe(0);
    const offline = {
      trigger: 'server_offline' as const,
      key: 'offline:srv:1',
      title: 'server-01 is offline',
      message: 'VDeploy has not heard from server-01.',
    };
    expect(await notify(t.db, orgId, offline, clock)).toBe(1);
    expect(await notify(t.db, orgId, offline, clock)).toBe(0);
    await sendDueNotifications(deps());
    expect(mail.map((m) => m.to)).toEqual(['a@example.com', 'b@example.com']);
    expect(mail[0]?.subject).toBe('[VDeploy] server-01 is offline');
    expect(mail[0]?.text).toMatch(/a server is offline for more than 5 minutes/);
  });

  it('retries a failed send with growing waits, then gives up and says why', async () => {
    const { channel } = await createChannel(
      t.db,
      SECRETS,
      {
        orgId,
        name: 'hook',
        config: { kind: 'webhook', url: 'https://hooks.example.com/y' },
        triggers: ['deploy_failed'],
      },
      clock,
    );
    await notify(t.db, orgId, failed(newId('project')), clock);
    answer = 500;
    const waits: number[] = [];
    for (let i = 0; i < 10; i++) {
      await sendDueNotifications(deps());
      const [row] = await t.db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.channelId, channel.id));
      if (row?.status === 'failed') break;
      waits.push(row!.nextAttemptAt.getTime() - clock.getTime());
      clock = row!.nextAttemptAt;
    }
    expect(waits).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]);
    const [delivery] = await listDeliveries(t.db, orgId, channel.id);
    expect(delivery).toMatchObject({
      status: 'failed',
      attempts: 6,
      lastError: 'the webhook answered HTTP 500',
    });
  });

  it('fails an email channel in plain words when no mail server is set up', async () => {
    const { channel } = await createChannel(
      t.db,
      SECRETS,
      {
        orgId,
        name: 'mail',
        config: { kind: 'email', to: ['a@example.com'] },
        triggers: ['deploy_failed'],
      },
      clock,
    );
    await notify(t.db, orgId, failed(newId('project')), clock);
    await sendDueNotifications(deps({ mailer: null }));
    const [delivery] = await listDeliveries(t.db, orgId, channel.id);
    expect(delivery?.lastError).toMatch(/email is not set up/);
  });

  it('tells about a server offline for five minutes, once per outage', async () => {
    await createChannel(
      t.db,
      SECRETS,
      {
        orgId,
        name: 'hook',
        config: { kind: 'webhook', url: 'https://hooks.example.com/z' },
        triggers: ['server_offline'],
      },
      clock,
    );
    const serverId = newId('server');
    await t.db.insert(servers).values({
      id: serverId,
      orgId,
      name: 'box',
      status: 'offline',
      lastSeenAt: new Date(clock.getTime() - 2 * 60_000),
    });
    expect(await notifyOfflineServers(t.db, clock)).toBe(0);
    clock = new Date(clock.getTime() + 4 * 60_000);
    expect(await notifyOfflineServers(t.db, clock)).toBe(1);
    expect(await notifyOfflineServers(t.db, clock)).toBe(0);

    // A server somebody is working on going quiet is not news.
    const worked = newId('server');
    await t.db.insert(servers).values({
      id: worked,
      orgId,
      name: 'rebooting',
      status: 'offline',
      lastSeenAt: new Date(clock.getTime() - 30 * 60_000),
      maintenanceSince: new Date(clock.getTime() - 60 * 60_000),
    });
    expect(await notifyOfflineServers(t.db, clock)).toBe(0);
  });

  it('turns an out-of-memory kill in a report into a plain notification, once an hour', async () => {
    await createChannel(
      t.db,
      SECRETS,
      {
        orgId,
        name: 'hook',
        config: { kind: 'webhook', url: 'https://hooks.example.com/o' },
        triggers: ['out_of_memory', 'app_crashing'],
      },
      clock,
    );
    const serverId = newId('server');
    const projectId = newId('project');
    await t.db.insert(servers).values({ id: serverId, orgId, name: 'box', status: 'online' });
    await t.db.insert(projects).values({
      id: projectId,
      orgId,
      serverId,
      name: 'shop',
      specHash: 'x',
      spec: {
        apiVersion: 'vdeploy/v1',
        kind: 'Application',
        metadata: { name: 'shop', labels: {} },
        source: { type: 'image', image: 'nginx:1' },
        build: { strategy: 'image' },
        runtime: { resources: { memory: { limit: '256Mi' } } },
      } as never,
    });
    const report: ObservedReport = {
      generation: 1,
      events: null,
      projects: [
        {
          projectId,
          replicas: [{ name: 'vd-1', state: 'exited', release: 'rel_1' }],
          evidence: [
            {
              container: 'vd-1',
              state: 'exited',
              exitCode: 137,
              oomKilled: true,
              restarts: 4,
              listening: null,
              lastOutput: 'DATABASE_PASSWORD=hunter2',
            },
          ],
        },
      ],
    };
    await notifyFromReport(t.db, serverId, report, clock);
    await notifyFromReport(t.db, serverId, report, new Date(clock.getTime() + 60_000));
    await sendDueNotifications(deps());
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]!.body) as { title: string; message: string };
    expect(body.title).toBe('shop ran out of memory');
    expect(body.message).toMatch(/256Mi/);
    // The app's own output never leaves in a notification.
    expect(posts[0]!.body).not.toMatch(/hunter2/);
  });

  it('tells about an app that runs and answers nobody, but not one that still has a copy serving', async () => {
    await createChannel(
      t.db,
      SECRETS,
      {
        orgId,
        name: 'hook',
        config: { kind: 'webhook', url: 'https://hooks.example.com/h' },
        triggers: ['health_failing'],
      },
      clock,
    );
    const serverId = newId('server');
    await t.db.insert(servers).values({ id: serverId, orgId, name: 'box', status: 'online' });
    const app = async (name: string) => {
      const id = newId('project');
      await t.db.insert(projects).values({
        id,
        orgId,
        serverId,
        name,
        specHash: 'x',
        spec: {
          apiVersion: 'vdeploy/v1',
          kind: 'Application',
          metadata: { name, labels: {} },
          source: { type: 'image', image: 'nginx:1' },
          build: { strategy: 'image' },
          health: { readiness: { type: 'http', path: '/ready' } },
        } as never,
      });
      return id;
    };
    const down = await app('shop');
    const half = await app('blog');
    const report: ObservedReport = {
      generation: 1,
      events: null,
      projects: [
        {
          projectId: down,
          replicas: [
            { name: 'vd-a', state: 'not_ready', release: 'rel_1' },
            { name: 'vd-b', state: 'not_ready', release: 'rel_1' },
          ],
        },
        {
          projectId: half,
          replicas: [
            { name: 'vd-c', state: 'ready', release: 'rel_1' },
            { name: 'vd-d', state: 'not_ready', release: 'rel_1' },
          ],
        },
      ],
    };
    await notifyFromReport(t.db, serverId, report, clock);
    await notifyFromReport(t.db, serverId, report, new Date(clock.getTime() + 60_000));
    await sendDueNotifications(deps());
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]!.body) as { title: string; message: string };
    expect(body.title).toBe('shop is running but failing its health check');
    expect(body.message).toContain('/ready');
  });

  it('says a certificate has not renewed while there are weeks left, once a day', async () => {
    await createChannel(
      t.db,
      SECRETS,
      {
        orgId,
        name: 'certs',
        config: { kind: 'webhook', url: 'https://hooks.example.com/c' },
        triggers: ['certificate_not_renewing'],
      },
      clock,
    );
    const serverId = newId('server');
    await t.db.insert(servers).values({ id: serverId, orgId, name: 'web-1', status: 'online' });
    const inDays = (days: number) => new Date(clock.getTime() + days * 86_400_000).toISOString();
    const report: ObservedReport = {
      generation: 1,
      events: null,
      projects: [],
      health: {
        at: clock.toISOString(),
        load: { one: 0, five: 0, fifteen: 0, cpus: 1 },
        swapUsedBytes: 0,
        swapTotalBytes: 0,
        inodesUsed: 0,
        inodesTotal: 0,
        docker: {
          imagesBytes: 0,
          imagesReclaimableBytes: 0,
          containersBytes: 0,
          volumesBytes: 0,
          buildCacheBytes: 0,
          buildCacheReclaimableBytes: 0,
          otherBytes: 0,
        },
        orphans: [],
        certificates: [
          // Inside the window: renewal has been failing for over a week.
          { hosts: ['shop.example.com', 'www.shop.example.com'], notAfter: inDays(12) },
          // Renewing on schedule: nothing to say.
          { hosts: ['blog.example.com'], notAfter: inDays(45) },
        ],
      },
    };
    await notifyFromReport(t.db, serverId, report, clock);
    await notifyFromReport(t.db, serverId, report, new Date(clock.getTime() + 3_600_000));
    await sendDueNotifications(deps());
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]!.body) as { title: string; message: string };
    expect(body.title).toBe('The certificate for shop.example.com has not renewed');
    expect(body.message).toMatch(/in 12 days/);
    expect(body.message).toMatch(/no longer points at web-1/);
  });
});

describe('webhook transport', () => {
  it('refuses a webhook that points inside the network', async () => {
    const post = safePoster(false);
    await expect(post('http://127.0.0.1:1/hook', '{}', {})).rejects.toThrow(/private address/);
    await expect(post('http://169.254.169.254/latest', '{}', {})).rejects.toThrow(
      /private address/,
    );
    await expect(post('http://[::1]:1/', '{}', {})).rejects.toThrow(/private address/);
  });

  it('posts the body and headers when private targets are allowed', async () => {
    let got: { body: string; headers: IncomingHttpHeaders } | null = null;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        got = { body, headers: req.headers };
        res.writeHead(202).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const status = await safePoster(true)(`http://127.0.0.1:${port}/hook`, '{"a":1}', {
        'x-vdeploy-event': 'test',
      });
      expect(status).toBe(202);
      expect(got).toMatchObject({ body: '{"a":1}', headers: { 'x-vdeploy-event': 'test' } });
    } finally {
      server.close();
    }
  });
});
