import { ApplicationSpec, newId, type PreviewRef } from '@vdeploy/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { previewFor, previewParents, previewsOf, secretsOwner, stalePreviews } from './previews.js';
import { organization, projects } from './schema/index.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

let t: TestDatabase;
let orgId: string;
let otherOrg: string;

const now = new Date('2026-09-28T12:00:00Z');
const daysBefore = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

const spec = (name: string, over: Record<string, unknown> = {}) =>
  ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name },
    source: { type: 'git', provider: 'gitlab', repo: 'acme/shop', branch: 'main' },
    build: { strategy: 'dockerfile' },
    ...over,
  });

const ref = (over: Partial<PreviewRef> = {}): PreviewRef => ({
  provider: 'gitlab',
  host: 'https://gitlab.com',
  repo: 'acme/shop',
  number: 7,
  branch: 'fix-the-thing',
  title: 'Fix the thing',
  ...over,
});

beforeAll(async () => {
  t = await startTestDatabase();
  orgId = newId('organization');
  otherOrg = newId('organization');
  await t.db.insert(organization).values([
    { id: orgId, name: 'Acme', slug: orgId.toLowerCase() },
    { id: otherOrg, name: 'Other', slug: otherOrg.toLowerCase() },
  ]);
}, 120_000);

afterAll(async () => {
  await t.stop();
});

beforeEach(async () => {
  await t.db.delete(projects);
});

async function addApp(name: string, over: Record<string, unknown> = {}, org = orgId) {
  const id = newId('project');
  await t.db.insert(projects).values({
    id,
    orgId: org,
    name,
    spec: spec(name, over),
    specHash: 'x'.repeat(64),
  });
  return id;
}

async function addPreview(parentId: string, at: PreviewRef, updatedAt = now) {
  const id = newId('project');
  await t.db.insert(projects).values({
    id,
    orgId,
    name: `p-${at.number}-${id.slice(-4)}`,
    spec: spec('preview'),
    specHash: 'x'.repeat(64),
    previewOf: parentId,
    previewRef: at,
    updatedAt,
  });
  return id;
}

describe('which app a pull request is a preview of', () => {
  const at = { provider: 'gitlab', host: 'https://gitlab.com', repo: 'acme/shop', base: 'main' };

  it('is the one deploying the branch it wants merging into', async () => {
    const app = await addApp('shop', { preview: { enabled: true } });
    await addApp('shop-develop', {
      preview: { enabled: true },
      source: { type: 'git', provider: 'gitlab', repo: 'acme/shop', branch: 'develop' },
    });
    expect((await previewParents(t.db, orgId, at)).map((p) => p.id)).toEqual([app]);
  });

  it('is nobody until somebody turns previews on', async () => {
    await addApp('shop');
    expect(await previewParents(t.db, orgId, at)).toEqual([]);
  });

  it('is never an app reading the same name on another host', async () => {
    await addApp('shop', {
      preview: { enabled: true },
      source: {
        type: 'git',
        provider: 'gitlab',
        host: 'https://git.example.com',
        repo: 'acme/shop',
        branch: 'main',
      },
    });
    await addApp('github-shop', {
      preview: { enabled: true },
      source: { type: 'git', provider: 'github', repo: 'acme/shop', branch: 'main' },
    });
    expect(await previewParents(t.db, orgId, at)).toEqual([]);
  });

  it('is never in another organization', async () => {
    await addApp('shop', { preview: { enabled: true } }, otherOrg);
    expect(await previewParents(t.db, orgId, at)).toEqual([]);
  });

  it('is never a preview, which would preview a preview', async () => {
    const app = await addApp('shop', { preview: { enabled: true } });
    await addPreview(app, ref());
    expect((await previewParents(t.db, orgId, at)).map((p) => p.id)).toEqual([app]);
  });
});

describe('finding the preview of one pull request', () => {
  it('matches the pull request, not merely the app', async () => {
    const app = await addApp('shop', { preview: { enabled: true } });
    const seven = await addPreview(app, ref());
    await addPreview(app, ref({ number: 8 }));
    expect((await previewFor(t.db, app, ref()))?.id).toBe(seven);
    expect(await previewFor(t.db, app, ref({ number: 9 }))).toBeNull();
    // The same number on another host is another pull request.
    expect(await previewFor(t.db, app, ref({ host: 'https://git.example.com' }))).toBeNull();
    expect(await previewsOf(t.db, app)).toHaveLength(2);
  });

  it('does not find one that has been taken down', async () => {
    const app = await addApp('shop', { preview: { enabled: true } });
    const id = await addPreview(app, ref());
    await t.db.update(projects).set({ deletedAt: now });
    expect(await previewFor(t.db, app, ref())).toBeNull();
    expect(await previewsOf(t.db, app)).toEqual([]);
    expect(id).toBeTruthy();
  });
});

describe('previews nobody is looking at', () => {
  it('goes by the limit the app sets, counted from the last push to it', async () => {
    const app = await addApp('shop', { preview: { enabled: true, expireAfterDays: 3 } });
    const stale = await addPreview(app, ref({ number: 1 }), daysBefore(4));
    await addPreview(app, ref({ number: 2 }), daysBefore(2));
    expect((await stalePreviews(t.db, now)).map((p) => p.id)).toEqual([stale]);
  });

  it('counts nothing when the app that would be previewed is gone', async () => {
    const app = await addApp('shop', { preview: { enabled: true, expireAfterDays: 1 } });
    await addPreview(app, ref(), daysBefore(30));
    await t.db.update(projects).set({ deletedAt: now });
    expect(await stalePreviews(t.db, now)).toEqual([]);
  });
});

describe('whose secrets a project reads', () => {
  it('is its own, unless it is a preview', () => {
    expect(secretsOwner({ id: 'prj_app', previewOf: null })).toBe('prj_app');
    expect(secretsOwner({ id: 'prj_preview', previewOf: 'prj_app' })).toBe('prj_app');
  });
});
