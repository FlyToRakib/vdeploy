import { ApplicationSpec, newId } from '@vdeploy/contracts';
import { hashOf } from '@vdeploy/core';
import { plans, projects, session } from '@vdeploy/db';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Browser, startTestApp, type TestApp } from '../test-helpers.js';

let t: TestApp;
let owner: Browser;
let orgId: string;
let connectionId: string;
let webhookSecret: string;

const PASSWORD = 'correct horse battery 42';
const TOKEN = 'glpat-a-read-only-token';

/** A stand-in GitLab: it knows one token and refuses every other. */
const gitlab = {
  asked: [] as string[],
  fetch: (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    gitlab.asked.push(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    // GitLab takes its own header, Bitbucket a bearer; both mean this token.
    const proved =
      headers['private-token'] === TOKEN || headers.authorization === `Bearer ${TOKEN}`;
    return Promise.resolve(new Response('', { status: proved ? 200 : 401 }));
  },
};

async function connect(token = TOKEN, host?: string) {
  await owner.request('POST', '/api/v1/auth/step-up', { password: PASSWORD });
  return owner.request('POST', '/api/v1/operations/git.connect_token', {
    input: { provider: 'gitlab', token, ...(host ? { host } : {}) },
  });
}

async function gitProject(
  name: string,
  source: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
) {
  const spec = ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name },
    source: { type: 'git', provider: 'gitlab', repo: 'acme/team/site', branch: 'main', ...source },
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

function hook(headers: Record<string, string>, payload: unknown, id = connectionId) {
  return t.app.inject({
    method: 'POST',
    url: `/api/v1/git/webhook/${id}`,
    payload: JSON.stringify(payload),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const gitlabPush = (files: string[], ref = 'refs/heads/main') => ({
  ref,
  after: 'f'.repeat(40),
  total_commits_count: 1,
  project: { path_with_namespace: 'acme/team/site' },
  commits: [{ added: [], modified: files, removed: [] }],
});

beforeAll(async () => {
  t = await startTestApp({ fetch: gitlab.fetch });
  owner = new Browser(t.app, 'Owner/1.0');
  const res = await owner.request('POST', '/api/v1/setup', {
    name: 'Owner',
    email: 'owner@example.com',
    password: PASSWORD,
    organization: 'Acme',
  });
  orgId = res.json<{ organizationId: string }>().organizationId;

  const connected = await connect();
  const result = connected.json<{
    result: { id: string; webhook: { url: string; secret: string } };
  }>().result;
  connectionId = result.id;
  webhookSecret = result.webhook.secret;
}, 120_000);

afterAll(async () => {
  await t.stop();
});

beforeEach(async () => {
  await t.database.db.delete(plans);
  await t.database.db.delete(projects);
  t.queued.length = 0;
});

describe('connecting GitLab', () => {
  it('checks the token against the host before storing it', async () => {
    expect(gitlab.asked).toContain('https://gitlab.com/api/v4/user');
    const refused = await connect('glpat-not-the-one');
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: { code: 'invalid_input' } });
  });

  it('will not connect without a fresh sign-in', async () => {
    // A token pasted by whoever walked past an unlocked screen is the
    // case step-up exists for, so age the last one out of its window.
    await t.database.db.update(session).set({ stepUpAt: null });
    const stale = await owner.request('POST', '/api/v1/operations/git.connect_token', {
      input: { provider: 'gitlab', token: TOKEN },
    });
    expect(stale.json()).toMatchObject({ error: { code: 'step_up_required' } });
  });

  it('shows the webhook once and never lists the secret again', async () => {
    const listed = await owner.request('POST', '/api/v1/operations/git.connections', {
      input: {},
    });
    const result = listed.json<{
      result: { id: string; host: string; webhookUrl: string }[];
    }>().result;
    expect(result).toMatchObject([
      { id: connectionId, provider: 'gitlab', host: 'https://gitlab.com' },
    ]);
    expect(result[0]?.webhookUrl).toContain(`/api/v1/git/webhook/${connectionId}`);
    const body = JSON.stringify(result);
    expect(body).not.toContain(webhookSecret);
    expect(body).not.toContain(TOKEN);
  });
});

describe('a push that cannot prove who sent it', () => {
  it('deploys nothing, and says the same thing for a connection that is not here', async () => {
    const wrong = await hook(
      { 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': 'guessed' },
      gitlabPush([]),
    );
    expect(wrong.statusCode).toBe(401);

    const missing = await hook(
      { 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': webhookSecret },
      gitlabPush([]),
      newId('gitConnection'),
    );
    // An unknown id answers exactly as a wrong secret does: a caller
    // learns nothing about which connections exist here.
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual(wrong.json());

    const none = await hook({ 'x-gitlab-event': 'Push Hook' }, gitlabPush([]));
    expect(none.statusCode).toBe(401);
    expect(t.queued).toEqual([]);
  });
});

describe('a push that does prove it', () => {
  const signed = { 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': '' };
  const good = () => ({ ...signed, 'x-gitlab-token': webhookSecret });

  it('deploys the apps reading that repository and branch', async () => {
    const id = await gitProject('site');
    await gitProject('other', { repo: 'acme/team/elsewhere' });
    await gitProject('later', { branch: 'next' });

    const res = await hook(good(), gitlabPush(['src/index.ts']));
    expect(res.statusCode).toBe(202);
    expect(res.json<{ deployed: { projectId: string }[] }>().deployed).toMatchObject([
      { projectId: id },
    ]);
    expect(t.queued).toHaveLength(1);
  });

  it('honours a monorepo path filter when GitLab said what changed', async () => {
    await gitProject('site', { paths: ['apps/web/**'] });
    const elsewhere = await hook(good(), gitlabPush(['apps/api/main.ts']));
    expect(elsewhere.json<{ deployed: unknown[] }>().deployed).toEqual([]);
    const inside = await hook(good(), gitlabPush(['apps/web/page.tsx']));
    expect(inside.json<{ deployed: unknown[] }>().deployed).toHaveLength(1);
  });

  it('ignores a tag, a deleted branch and anything that is not a push', async () => {
    await gitProject('site');
    expect((await hook(good(), gitlabPush([], 'refs/tags/v1'))).statusCode).toBe(204);
    expect((await hook(good(), { ...gitlabPush([]), after: '0'.repeat(40) })).statusCode).toBe(204);
    expect(
      (await hook({ ...good(), 'x-gitlab-event': 'Tag Push Hook' }, gitlabPush([]))).statusCode,
    ).toBe(204);
    expect(t.queued).toEqual([]);
  });

  it('does not deploy an app that reads the same name somewhere else', async () => {
    await gitProject('github-one', { provider: 'github', repo: 'acme/team/site' });
    await gitProject('own-gitlab', { host: 'https://git.example.com' });
    const res = await hook(good(), gitlabPush([]));
    expect(res.json<{ deployed: unknown[] }>().deployed).toEqual([]);
    expect(t.queued).toEqual([]);
  });

  it('deploys each app once however many times the hook is delivered', async () => {
    await gitProject('site');
    await hook(good(), gitlabPush([]));
    await hook(good(), gitlabPush([]));
    expect(t.queued).toHaveLength(1);
  });

  it('answers a body that is not JSON without deploying anything', async () => {
    await gitProject('site');
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/git/webhook/${connectionId}`,
      payload: 'not json',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-event': 'Push Hook',
        'x-gitlab-token': webhookSecret,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(t.queued).toEqual([]);
  });
});

describe('a Bitbucket push', () => {
  let bitbucketId: string;
  let bitbucketSecret: string;

  beforeEach(async () => {
    if (bitbucketId) return;
    await owner.request('POST', '/api/v1/auth/step-up', { password: PASSWORD });
    const res = await owner.request('POST', '/api/v1/operations/git.connect_token', {
      input: { provider: 'bitbucket', token: TOKEN },
    });
    const result = res.json<{ result: { id: string; webhook: { secret: string } } }>().result;
    bitbucketId = result.id;
    bitbucketSecret = result.webhook.secret;
  });

  it('is proved by a signature, not a shared header', async () => {
    await gitProject('site', { provider: 'bitbucket', repo: 'acme/site' });
    const payload = {
      repository: { full_name: 'acme/site' },
      push: { changes: [{ new: { type: 'branch', name: 'main', target: { hash: 'abc1234' } } }] },
    };
    const body = JSON.stringify(payload);
    const sign = (secret: string) =>
      `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

    const forged = await t.app.inject({
      method: 'POST',
      url: `/api/v1/git/webhook/${bitbucketId}`,
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-event-key': 'repo:push',
        'x-hub-signature': sign('not the secret'),
      },
    });
    expect(forged.statusCode).toBe(401);

    const real = await t.app.inject({
      method: 'POST',
      url: `/api/v1/git/webhook/${bitbucketId}`,
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-event-key': 'repo:push',
        'x-hub-signature': sign(bitbucketSecret),
      },
    });
    expect(real.statusCode).toBe(202);
    expect(real.json<{ deployed: unknown[] }>().deployed).toHaveLength(1);
  });
});

describe('a merge request', () => {
  const merge = (over: Record<string, unknown> = {}) => ({
    object_attributes: {
      iid: 7,
      title: 'Fix the thing',
      action: 'open',
      source_branch: 'fix-the-thing',
      target_branch: 'main',
      last_commit: { id: 'a'.repeat(40) },
      source: { path_with_namespace: 'acme/team/site' },
      target: { path_with_namespace: 'acme/team/site' },
      ...over,
    },
  });

  const hookMr = (payload: unknown) =>
    hook({ 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-token': webhookSecret }, payload);

  async function addPreview(parentId: string, number: number) {
    const spec = ApplicationSpec.parse({
      apiVersion: 'vdeploy/v1',
      kind: 'Application',
      metadata: { name: `site-pr-${String(number)}` },
      source: {
        type: 'git',
        provider: 'gitlab',
        repo: 'acme/team/site',
        branch: 'fix-the-thing',
      },
      build: { strategy: 'dockerfile' },
    });
    const id = newId('project');
    await t.database.db.insert(projects).values({
      id,
      orgId,
      name: spec.metadata.name,
      spec,
      specHash: hashOf(spec),
      previewOf: parentId,
      previewRef: {
        provider: 'gitlab',
        host: 'https://gitlab.com',
        repo: 'acme/team/site',
        number,
        branch: 'fix-the-thing',
        title: 'Fix the thing',
      },
    });
    return id;
  }

  const previews = { enabled: true, fromForks: false, max: 2, expireAfterDays: 7 };

  it('makes a preview of the app the branch is aimed at', async () => {
    const id = await gitProject('site', {}, { preview: previews });
    const res = await hookMr(merge());
    expect(res.statusCode).toBe(202);
    const opened = res.json<{ previews: { projectId: string; status: string; plan?: string }[] }>()
      .previews;
    expect(opened).toMatchObject([{ projectId: id, status: 'opened' }]);
    expect(typeof opened[0]?.plan).toBe('string');
    const [plan] = await t.database.db.select().from(plans);
    expect(plan?.operation).toBe('preview.open');
    // The step carries the app, which is what makes the apply insert a new
    // project rather than write over the one being previewed.
    expect(plan?.plan.steps).toContainEqual(
      expect.objectContaining({ kind: 'update_spec', previewOf: id }),
    );
    expect(t.queued).toHaveLength(1);
  });

  it('is not made for an app the pull request is not aimed at', async () => {
    await gitProject('site', { branch: 'develop' }, { preview: previews });
    const res = await hookMr(merge());
    expect(res.json<{ previews: unknown[] }>().previews).toEqual([]);
    expect(t.queued).toEqual([]);
  });

  it('is not made at all unless somebody turned previews on', async () => {
    await gitProject('site');
    const res = await hookMr(merge());
    expect(res.json<{ previews: unknown[] }>().previews).toEqual([]);
    expect(t.queued).toEqual([]);
  });

  it('will not run a fork with this app settings, and says so', async () => {
    const id = await gitProject('site', {}, { preview: previews });
    const res = await hookMr(merge({ source: { path_with_namespace: 'someone/site' } }));
    const answered = res.json<{
      previews: { projectId: string; status: string; reason: string }[];
    }>().previews;
    expect(answered).toMatchObject([{ projectId: id, status: 'refused' }]);
    expect(answered[0]?.reason).toMatch(/comes from a fork/);
    expect(t.queued).toEqual([]);
  });

  it('deploys the preview it already has rather than making another', async () => {
    const id = await gitProject('site', {}, { preview: previews });
    const preview = await addPreview(id, 7);
    const res = await hookMr(merge({ action: 'update' }));
    expect(res.json<{ previews: { status: string; preview: string }[] }>().previews).toEqual([
      { projectId: id, status: 'deployed', preview },
    ]);
    const [plan] = await t.database.db.select().from(plans);
    expect(plan?.operation).toBe('project.deploy_commit');
    expect(plan?.projectId).toBe(preview);
  });

  it('stops at the limit rather than filling the machine', async () => {
    const id = await gitProject('site', {}, { preview: previews });
    await addPreview(id, 101);
    await addPreview(id, 102);
    const res = await hookMr(merge());
    const answered = res.json<{
      previews: { projectId: string; status: string; reason: string }[];
    }>().previews;
    expect(answered).toMatchObject([{ projectId: id, status: 'refused' }]);
    expect(answered[0]?.reason).toMatch(/already has 2 previews/);
  });

  it('takes the preview down when the merge request ends, however it ends', async () => {
    for (const action of ['close', 'merge']) {
      await t.database.db.delete(plans);
      await t.database.db.delete(projects);
      t.queued.length = 0;
      const id = await gitProject('site', {}, { preview: previews });
      const preview = await addPreview(id, 7);
      const res = await hookMr(merge({ action }));
      expect(res.json<{ previews: { status: string }[] }>().previews).toEqual([
        { projectId: id, status: 'closed', preview },
      ]);
      const [plan] = await t.database.db.select().from(plans);
      // Sensitive, not destructive: a preview that needed somebody woken
      // up to remove it is a preview that never goes away.
      expect(plan?.operation).toBe('preview.close');
      expect(plan?.tier).toBe('sensitive');
      expect(t.queued).toHaveLength(1);
    }
  });

  it('says nothing happened when a merge request it never previewed closes', async () => {
    const id = await gitProject('site', {}, { preview: previews });
    const res = await hookMr(merge({ action: 'close' }));
    expect(res.json<{ previews: { status: string }[] }>().previews).toEqual([
      { projectId: id, status: 'unchanged' },
    ]);
    expect(t.queued).toEqual([]);
  });
});
