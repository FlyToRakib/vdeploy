import { createHmac, generateKeyPairSync } from 'node:crypto';
import { ApplicationSpec, newId } from '@vdeploy/contracts';
import { hashOf } from '@vdeploy/core';
import { githubInstallations, plans, projects, user } from '@vdeploy/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Browser, ORIGIN, startTestApp, type TestApp } from '../test-helpers.js';

let t: TestApp;
let owner: Browser;
let orgId: string;
const PASSWORD = 'correct horse battery 42';
const HOOK_SECRET = 'github-webhook-secret';

/** A stand-in GitHub: installation 501 belongs to the person holding code "good". */
const github = {
  api: [] as string[],
  fetch: (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    github.api.push(url);
    if (url === 'https://gh.test/login/oauth/access_token') {
      const { code } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        code: string;
      };
      return Promise.resolve(Response.json(code === 'good' ? { access_token: 'ghu_person' } : {}));
    }
    if (url.startsWith('https://api.gh.test/user/installations')) {
      return Promise.resolve(Response.json({ installations: [{ id: 501 }] }));
    }
    if (url === 'https://api.gh.test/app/installations/501') {
      return Promise.resolve(
        Response.json({
          id: 501,
          account: { login: 'Acme', type: 'Organization' },
          repository_selection: 'selected',
          suspended_at: null,
        }),
      );
    }
    return Promise.resolve(new Response('not here', { status: 404 }));
  },
};

function hook(event: string, payload: unknown, secret = HOOK_SECRET) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return t.app.inject({
    method: 'POST',
    url: '/api/v1/github/webhook',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': `d-${Math.random().toString(36).slice(2)}`,
      'x-hub-signature-256': signature,
    },
  });
}

const push = (files: string[], ref = 'refs/heads/main') => ({
  ref,
  after: 'f'.repeat(40),
  deleted: false,
  repository: { full_name: 'acme/site' },
  installation: { id: 501 },
  commits: [{ added: [], modified: files, removed: [] }],
});

async function gitProject(name: string, paths: string[] = [], over: Record<string, unknown> = {}) {
  const spec = ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name },
    source: { type: 'git', provider: 'github', repo: 'acme/site', branch: 'main', paths },
    build: { strategy: 'dockerfile' },
    ...over,
  });
  const id = newId('project');
  await t.database.db.insert(projects).values({
    id,
    orgId,
    name,
    spec,
    specHash: hashOf(spec),
    currentReleaseId: newId('release'),
  });
  return id;
}

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  t = await startTestApp({
    github: {
      app: {
        appId: '1234',
        privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
        apiUrl: 'https://api.gh.test',
        webUrl: 'https://gh.test',
        clientId: 'Iv1.client',
        clientSecret: 'client-secret',
        fetch: github.fetch,
      },
      slug: 'vdeploy-test',
      webhookSecret: HOOK_SECRET,
    },
  });
  owner = new Browser(t.app, 'Owner/1.0');
  const res = await owner.request('POST', '/api/v1/setup', {
    name: 'Owner',
    email: 'owner@example.com',
    password: PASSWORD,
    organization: 'Acme',
  });
  orgId = res.json<{ organizationId: string }>().organizationId;
}, 120_000);

afterAll(async () => {
  await t.stop();
});

describe('connecting GitHub', () => {
  it('links an installation only for a person GitHub vouches for, from their own install link', async () => {
    const install = await owner.request('GET', '/api/v1/github/install');
    const { url } = install.json<{ url: string }>();
    expect(url).toMatch(/^https:\/\/gh\.test\/apps\/vdeploy-test\/installations\/new\?state=/);
    const state = new URL(url).searchParams.get('state') ?? '';

    const forged = await owner.request(
      'GET',
      `/api/v1/github/callback?installation_id=501&code=good&state=${state}x`,
    );
    expect(forged.headers.location).toMatch(/github=error&reason=expired/);

    const stranger = await owner.request(
      'GET',
      `/api/v1/github/callback?installation_id=501&code=bad&state=${state}`,
    );
    expect(stranger.headers.location).toMatch(/github=error&reason=forbidden/);

    const ok = await owner.request(
      'GET',
      `/api/v1/github/callback?installation_id=501&code=good&state=${state}`,
    );
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe(`${ORIGIN}/settings/github?github=connected&account=Acme`);
    const listed = await owner.request('POST', '/api/v1/operations/github.installations', {
      input: {},
    });
    expect(listed.json<{ result: { account: string }[] }>().result).toMatchObject([
      { account: 'Acme', installationId: 501, repositorySelection: 'selected' },
    ]);
  });

  it('refuses a webhook GitHub did not sign', async () => {
    const res = await hook('push', push(['index.js']), 'not-the-secret');
    expect(res.statusCode).toBe(401);
  });

  it('deploys the pushed commit of every project on that branch, honouring path filters', async () => {
    const site = await gitProject('site');
    const api = await gitProject('api', ['apps/api/**']);
    const res = await hook('push', push(['apps/web/page.tsx']));
    expect(res.statusCode).toBe(202);
    const { deployed } = res.json<{ deployed: { projectId: string; status: string }[] }>();
    expect(deployed).toEqual([{ projectId: site, status: 'queued' }]);
    const [queued] = await t.database.db.select().from(plans).where(eq(plans.projectId, site));
    expect(queued).toMatchObject({
      operation: 'project.deploy_commit',
      args: { projectId: site, commit: 'f'.repeat(40) },
    });
    expect(queued?.actor).toMatchObject({ origin: 'webhook' });

    const apiPush = await hook('push', push(['apps/api/src/server.ts']));
    expect(
      apiPush
        .json<{ deployed: { projectId: string }[] }>()
        .deployed.map((d) => d.projectId)
        .sort(),
    ).toEqual([site, api].sort());

    const otherBranch = await hook('push', push(['x'], 'refs/heads/feature'));
    expect(otherBranch.json<{ deployed: unknown[] }>().deployed).toEqual([]);
  });

  it('forgets an installation when it is removed on GitHub', async () => {
    const res = await hook('installation', { action: 'deleted', installation: { id: 501 } });
    expect(res.statusCode).toBe(204);
    const rows = await t.database.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, 501));
    expect(rows).toEqual([]);
  });
});

describe('a pull request', () => {
  const previews = { enabled: true, fromForks: false, max: 2, expireAfterDays: 7 };

  // Each of these asks what one pull request does to the apps that exist,
  // so the apps the one before it made must not still be here.
  beforeEach(async () => {
    await t.database.db.delete(plans);
    await t.database.db.delete(projects);
  });

  // The block before this one removes the installation on purpose.
  beforeAll(async () => {
    await t.database.db.insert(githubInstallations).values({
      installationId: 501,
      orgId,
      accountLogin: 'Acme',
      accountType: 'Organization',
      repositorySelection: 'selected',
      linkedBy: (await t.database.db.select().from(user))[0]!.id,
    });
  });

  const event = (over: Record<string, unknown> = {}, head: Record<string, unknown> = {}) => ({
    action: 'opened',
    number: 42,
    pull_request: {
      title: 'Fix the thing',
      html_url: 'https://github.com/acme/site/pull/42',
      head: {
        ref: 'fix-the-thing',
        sha: 'a'.repeat(40),
        repo: { full_name: 'acme/site' },
        ...head,
      },
      base: { ref: 'main', repo: { full_name: 'acme/site' } },
    },
    installation: { id: 501 },
    ...over,
  });

  it('makes a preview, planned like every other change', async () => {
    const id = await gitProject('preview-me', [], { preview: previews });
    const res = await hook('pull_request', event());
    expect(res.statusCode).toBe(202);
    const opened = res.json<{ previews: { projectId: string; status: string; plan?: string }[] }>()
      .previews;
    expect(opened).toMatchObject([{ projectId: id, status: 'opened' }]);
    expect(typeof opened[0]?.plan).toBe('string');
    const [plan] = await t.database.db
      .select()
      .from(plans)
      .where(eq(plans.operation, 'preview.open'));
    expect(plan?.args).toMatchObject({
      pullRequest: {
        number: 42,
        branch: 'fix-the-thing',
        url: 'https://github.com/acme/site/pull/42',
      },
    });
  });

  it('will not run a fork with this app settings', async () => {
    const id = await gitProject('no-forks', [], { preview: previews });
    const res = await hook('pull_request', event({}, { repo: { full_name: 'someone/site' } }));
    const answered = res.json<{
      previews: { projectId: string; status: string; reason: string }[];
    }>().previews;
    expect(answered).toMatchObject([{ projectId: id, status: 'refused' }]);
    expect(answered[0]?.reason).toMatch(/comes from a fork/);
  });

  it('treats a pull request from a deleted fork as a fork', async () => {
    // GitHub sends head.repo as null once the fork is gone; that is not
    // this repository, so it is not somebody this app trusts.
    const id = await gitProject('deleted-fork', [], { preview: previews });
    const res = await hook('pull_request', event({}, { repo: null }));
    const answered = res.json<{
      previews: { projectId: string; status: string; reason: string }[];
    }>().previews;
    expect(answered).toMatchObject([{ projectId: id, status: 'refused' }]);
    expect(answered[0]?.reason).toMatch(/fork/);
  });

  it('ignores an action that did not happen to the code', async () => {
    await gitProject('labelled', [], { preview: previews });
    expect((await hook('pull_request', event({ action: 'labeled' }))).statusCode).toBe(204);
  });

  it('is not signed differently from any other webhook', async () => {
    await gitProject('unsigned', [], { preview: previews });
    const res = await hook('pull_request', event(), 'not-the-secret');
    expect(res.statusCode).toBe(401);
  });
});
