import { newId } from '@vdeploy/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  backups,
  builds,
  organization,
  projects,
  servers,
  transfers,
  uploads,
  user,
} from './schema/index.js';
import { startTestDatabase, type TestDatabase } from './testing.js';
import { allowTransfer, claimTransfer } from './transfers.js';

let t: TestDatabase;
let orgId: string;
let fromServer: string;
let toServer: string;
let backupId: string;
let projectId: string;
let userId: string;

const now = new Date('2026-09-28T12:00:00Z');

beforeAll(async () => {
  t = await startTestDatabase();
  orgId = newId('organization');
  fromServer = newId('server');
  toServer = newId('server');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  userId = newId('user');
  await t.db.insert(user).values({ id: userId, name: 'Owner', email: 'owner@example.com' });
  await t.db.insert(servers).values([
    { id: fromServer, orgId, name: 'old', status: 'online' },
    { id: toServer, orgId, name: 'new', status: 'online' },
  ]);
  projectId = newId('project');
  await t.db.insert(projects).values({
    id: projectId,
    orgId,
    serverId: fromServer,
    name: 'shop',
    spec: {} as never,
    specHash: 'x'.repeat(64),
  });
}, 120_000);

beforeEach(async () => {
  await t.db.delete(transfers);
  await t.db.delete(builds);
  await t.db.delete(uploads);
  await t.db.delete(backups);
  backupId = newId('backup');
  await t.db.insert(backups).values({
    id: backupId,
    orgId,
    serverId: fromServer,
    projectId,
    kind: 'volumes',
    fileName: 'shop-folders.tar.gz',
    status: 'done',
    verified: true,
    sizeBytes: 4096,
    sha256: 'a'.repeat(64),
  });
});

afterAll(async () => {
  await t.stop();
});

describe('a file on its way between servers (§17.6)', () => {
  it('says what to send, and where it is', async () => {
    const allowed = await t.db.transaction((tx) =>
      allowTransfer(tx, { orgId, subject: { backupId }, toServerId: toServer, now }),
    );
    const claim = await t.db.transaction((tx) => claimTransfer(tx, allowed.id, allowed.token, now));
    expect(claim).toMatchObject({
      backupId,
      fromServerId: fromServer,
      fileName: 'shop-folders.tar.gz',
      sizeBytes: 4096,
    });
  });

  it('works once', async () => {
    // A retry that got half a file asks for a new token rather than
    // racing the first: spending it is the first thing that happens.
    const allowed = await t.db.transaction((tx) =>
      allowTransfer(tx, { orgId, subject: { backupId }, toServerId: toServer, now }),
    );
    await t.db.transaction((tx) => claimTransfer(tx, allowed.id, allowed.token, now));
    await expect(
      t.db.transaction((tx) => claimTransfer(tx, allowed.id, allowed.token, now)),
    ).rejects.toThrow(/not available/);
  });

  it('keeps only the hash of the token', async () => {
    const allowed = await t.db.transaction((tx) =>
      allowTransfer(tx, { orgId, subject: { backupId }, toServerId: toServer, now }),
    );
    const [row] = await t.db.select().from(transfers);
    expect(row?.tokenHash).not.toBe(allowed.token);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a wrong token, and one that has expired', async () => {
    const allowed = await t.db.transaction((tx) =>
      allowTransfer(tx, { orgId, subject: { backupId }, toServerId: toServer, now }),
    );
    await expect(
      t.db.transaction((tx) => claimTransfer(tx, allowed.id, 'not-the-token', now)),
    ).rejects.toThrow(/not available/);
    const later = new Date(now.getTime() + 2 * 60 * 60_000);
    await expect(
      t.db.transaction((tx) => claimTransfer(tx, allowed.id, allowed.token, later)),
    ).rejects.toThrow(/not available/);
  });

  it('says so when the copy it points at has gone', async () => {
    const allowed = await t.db.transaction((tx) =>
      allowTransfer(tx, { orgId, subject: { backupId }, toServerId: toServer, now }),
    );
    await t.db.delete(backups);
    await expect(
      t.db.transaction((tx) => claimTransfer(tx, allowed.id, allowed.token, now)),
    ).rejects.toThrow(/not available|no longer here/);
  });
});

describe('an image on its way from the server that built it (§15)', () => {
  /** A build that ran on the builder and kept its image for collection. */
  async function offloaded(over: Record<string, unknown> = {}) {
    const uploadId = newId('upload');
    await t.db.insert(uploads).values({
      id: uploadId,
      orgId,
      size: 1,
      sha256: 'b'.repeat(64),
      createdBy: { userId, origin: 'dashboard' },
    });
    const buildId = newId('build');
    await t.db.insert(builds).values({
      id: buildId,
      orgId,
      projectId,
      serverId: fromServer,
      uploadId,
      kind: 'build',
      strategy: 'railpack',
      options: { context: '.', args: {}, export: true },
      status: 'running',
      image: 'sha256:' + 'c'.repeat(64),
      exportSizeBytes: 90_000_000,
      exportSha256: 'd'.repeat(64),
      ...over,
    });
    return buildId;
  }

  it('says which server holds it, and what the bytes must hash to', async () => {
    const buildId = await offloaded();
    const allowed = await t.db.transaction((tx) =>
      allowTransfer(tx, { orgId, subject: { buildId }, toServerId: toServer, now }),
    );
    const claim = await t.db.transaction((tx) => claimTransfer(tx, allowed.id, allowed.token, now));
    expect(claim).toMatchObject({
      kind: 'image',
      buildId,
      fromServerId: fromServer,
      sizeBytes: 90_000_000,
      sha256: 'd'.repeat(64),
    });
  });

  // A permission to send "either or neither" is a permission to send the
  // wrong thing, so the table refuses one that names both.
  it('refuses a permission that names two things', async () => {
    const buildId = await offloaded();
    const both = t.db.insert(transfers).values({
      id: newId('transfer'),
      orgId,
      backupId,
      buildId,
      toServerId: toServer,
      tokenHash: 'e'.repeat(64),
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await expect(both).rejects.toThrow();
    expect(await t.db.select().from(transfers)).toEqual([]);
  });

  it('has nothing to send once the build has been forgotten', async () => {
    const buildId = await offloaded({ exportSha256: null, exportSizeBytes: null });
    const allowed = await t.db.transaction((tx) =>
      allowTransfer(tx, { orgId, subject: { buildId }, toServerId: toServer, now }),
    );
    await expect(
      t.db.transaction((tx) => claimTransfer(tx, allowed.id, allowed.token, now)),
    ).rejects.toThrow(/no longer here/);
  });
});
