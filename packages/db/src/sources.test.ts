import { newId, readSpec } from '@vdeploy/contracts';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { projectsForPush } from './github.js';
import { gitConnections, organization, projects, user } from './schema/index.js';
import {
  connectGit,
  connectionById,
  connectionFor,
  disconnectGit,
  hostFor,
  listConnections,
} from './sources.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

let t: TestDatabase;
let orgId: string;
let otherOrg: string;
let userId: string;

const kek = randomBytes(32);
const now = new Date('2026-09-28T12:00:00Z');

beforeAll(async () => {
  t = await startTestDatabase();
  orgId = newId('organization');
  otherOrg = newId('organization');
  userId = newId('user');
  await t.db.insert(organization).values([
    { id: orgId, name: 'Acme', slug: orgId.toLowerCase() },
    { id: otherOrg, name: 'Other', slug: otherOrg.toLowerCase() },
  ]);
  await t.db.insert(user).values({ id: userId, name: 'Owner', email: 'owner@example.com' });
}, 120_000);

afterAll(async () => {
  await t.stop();
});

beforeEach(async () => {
  await t.db.delete(projects);
  await t.db.delete(gitConnections);
});

const connect = (input: Partial<Parameters<typeof connectGit>[2]> = {}) =>
  connectGit(t.db, kek, {
    orgId,
    provider: 'gitlab',
    token: 'glpat-secret-value',
    connectedBy: userId,
    now,
    ...input,
  });

describe('naming a host', () => {
  it('falls back to the provider own address', () => {
    expect(hostFor('gitlab')).toBe('https://gitlab.com');
    expect(hostFor('bitbucket', '')).toBe('https://bitbucket.org');
  });

  it('spells one host one way, so one host is one row', () => {
    expect(hostFor('gitlab', 'https://git.example.com/')).toBe('https://git.example.com');
    expect(hostFor('gitlab', 'https://git.example.com')).toBe('https://git.example.com');
  });

  it('refuses a token sent in the clear', () => {
    expect(() => hostFor('gitlab', 'http://git.example.com')).toThrow(/https/);
  });

  it('refuses an address that is not one, or carries a path', () => {
    expect(() => hostFor('gitlab', 'git.example.com')).toThrow(/web address/);
    expect(() => hostFor('gitlab', 'https://git.example.com/gitlab')).toThrow(/server only/);
  });

  it('refuses to pretend Bitbucket can be run in-house', () => {
    expect(() => hostFor('bitbucket', 'https://bitbucket.example.com')).toThrow(/only at/);
  });
});

describe('connecting a host', () => {
  it('keeps the token out of what anyone is shown', async () => {
    const view = await connect({ host: 'https://git.example.com' });
    expect(view).toMatchObject({ provider: 'gitlab', host: 'https://git.example.com' });
    expect(JSON.stringify(view)).not.toContain('glpat-secret-value');

    const listed = await listConnections(t.db, orgId);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('glpat-secret-value');
  });

  it('stores the token encrypted, never as itself', async () => {
    await connect();
    const [row] = await t.db.select().from(gitConnections);
    expect(row?.tokenSealed).not.toContain('glpat-secret-value');
    expect(row?.tokenSealed.length).toBeGreaterThan(20);
  });

  it('hands the token back to the fetcher that needs it', async () => {
    await connect();
    const connection = await connectionFor(t.db, kek, orgId, 'gitlab');
    expect(connection).toEqual({
      provider: 'gitlab',
      host: 'https://gitlab.com',
      token: 'glpat-secret-value',
    });
  });

  it('replaces the token rather than keeping two for one host', async () => {
    const first = await connect();
    const second = await connect({ token: 'glpat-the-new-one' });
    expect(second.id).toBe(first.id);
    expect(await listConnections(t.db, orgId)).toHaveLength(1);
    const connection = await connectionFor(t.db, kek, orgId, 'gitlab');
    expect(connection.token).toBe('glpat-the-new-one');
  });

  it('keeps two different hosts apart', async () => {
    await connect();
    await connect({ host: 'https://git.example.com' });
    expect(await listConnections(t.db, orgId)).toHaveLength(2);
    expect((await connectionFor(t.db, kek, orgId, 'gitlab')).host).toBe('https://gitlab.com');
  });
});

describe('a connection belongs to one organization', () => {
  it('is invisible to the next one', async () => {
    await connect();
    expect(await listConnections(t.db, otherOrg)).toEqual([]);
    expect(await connectionFor(t.db, kek, otherOrg, 'gitlab')).toEqual({
      provider: 'gitlab',
      host: 'https://gitlab.com',
    });
  });

  it('cannot be disconnected from the next one', async () => {
    const view = await connect();
    await expect(disconnectGit(t.db, otherOrg, view.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await listConnections(t.db, orgId)).toHaveLength(1);
    await disconnectGit(t.db, orgId, view.id);
    expect(await listConnections(t.db, orgId)).toEqual([]);
  });

  it('does not open a token copied into another organization row', async () => {
    const view = await connect();
    const [row] = await t.db.select().from(gitConnections);
    const stolen = newId('gitConnection');
    await t.db.insert(gitConnections).values({
      id: stolen,
      orgId: otherOrg,
      provider: 'gitlab',
      host: 'https://gitlab.com',
      // The exact ciphertext, moved: the associated data must refuse it.
      tokenSealed: row?.tokenSealed ?? '',
      connectedBy: userId,
    });
    await expect(connectionFor(t.db, kek, otherOrg, 'gitlab')).rejects.toThrow();
    expect(view.id).not.toBe(stolen);
  });
});

describe('a repository with no connection', () => {
  it('is still fetchable, without a token', async () => {
    expect(await connectionFor(t.db, kek, orgId, 'bitbucket')).toEqual({
      provider: 'bitbucket',
      host: 'https://bitbucket.org',
    });
  });

  it('never looks for GitHub here: GitHub has an App', async () => {
    await connect();
    expect(await connectionFor(t.db, kek, orgId, 'github')).toEqual({
      provider: 'github',
      host: 'https://github.com',
    });
  });
});

describe('finding a connection by id', () => {
  it('answers with what a webhook needs and nothing more', async () => {
    const view = await connect();
    const found = await connectionById(t.db, view.id);
    expect(found).toEqual({
      id: view.id,
      orgId,
      provider: 'gitlab',
      host: 'https://gitlab.com',
      connectedBy: userId,
    });
    expect(await connectionById(t.db, newId('gitConnection'))).toBeNull();
  });
});

describe('deciding what a push deploys', () => {
  let n = 0;
  const addProject = async (source: Record<string, unknown>) => {
    const id = newId('project');
    const name = `app-${++n}`;
    await t.db.insert(projects).values({
      id,
      orgId,
      name,
      spec: {
        apiVersion: 'vdeploy/v1',
        kind: 'Application',
        metadata: { name },
        source: { branch: 'main', ...source },
        build: { strategy: 'railpack' },
      } as never,
      specHash: 'x'.repeat(64),
    });
    return id;
  };

  it('never deploys a GitHub app because GitLab pushed the same name', async () => {
    const github = await addProject({ type: 'git', provider: 'github', repo: 'acme/app' });
    const gitlab = await addProject({ type: 'git', provider: 'gitlab', repo: 'acme/app' });

    const fromGitlab = await projectsForPush(t.db, orgId, 'acme/app', 'main', {
      provider: 'gitlab',
      host: 'https://gitlab.com',
    });
    expect(fromGitlab.map((p) => p.id)).toEqual([gitlab]);

    const fromGithub = await projectsForPush(t.db, orgId, 'acme/app', 'main');
    expect(fromGithub.map((p) => p.id)).toEqual([github]);
  });

  it('keeps two GitLabs apart', async () => {
    const own = await addProject({
      type: 'git',
      provider: 'gitlab',
      host: 'https://git.example.com',
      repo: 'acme/app',
    });
    await addProject({ type: 'git', provider: 'gitlab', repo: 'acme/app' });

    const pushed = await projectsForPush(t.db, orgId, 'acme/app', 'main', {
      provider: 'gitlab',
      host: 'https://git.example.com',
    });
    expect(pushed.map((p) => p.id)).toEqual([own]);
  });

  it('reads a spec written before providers existed as GitHub', async () => {
    const id = await addProject({ type: 'git', repo: 'acme/app' });
    const stored = readSpec((await t.db.select().from(projects))[0]?.spec);
    expect(stored.source).toMatchObject({ type: 'git', provider: 'github' });
    const pushed = await projectsForPush(t.db, orgId, 'acme/app', 'main');
    expect(pushed.map((p) => p.id)).toEqual([id]);
  });
});
