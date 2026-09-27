import { newId } from '@vdeploy/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backups, organization, projects, servers, transfers, user } from './schema/index.js';
import { startTestDatabase, type TestDatabase } from './testing.js';
import { allowTransfer, claimTransfer } from './transfers.js';

let t: TestDatabase;
let orgId: string;
let fromServer: string;
let toServer: string;
let backupId: string;
let projectId: string;

const now = new Date('2026-09-28T12:00:00Z');

beforeAll(async () => {
  t = await startTestDatabase();
  orgId = newId('organization');
  fromServer = newId('server');
  toServer = newId('server');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(user).values({ id: newId('user'), name: 'Owner', email: 'owner@example.com' });
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
      allowTransfer(tx, { orgId, backupId, toServerId: toServer, now }),
    );
    const claim = await t.db.transaction((tx) =>
      claimTransfer(tx, allowed.id, allowed.token, now),
    );
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
      allowTransfer(tx, { orgId, backupId, toServerId: toServer, now }),
    );
    await t.db.transaction((tx) => claimTransfer(tx, allowed.id, allowed.token, now));
    await expect(
      t.db.transaction((tx) => claimTransfer(tx, allowed.id, allowed.token, now)),
    ).rejects.toThrow(/not available/);
  });

  it('keeps only the hash of the token', async () => {
    const allowed = await t.db.transaction((tx) =>
      allowTransfer(tx, { orgId, backupId, toServerId: toServer, now }),
    );
    const [row] = await t.db.select().from(transfers);
    expect(row?.tokenHash).not.toBe(allowed.token);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a wrong token, and one that has expired', async () => {
    const allowed = await t.db.transaction((tx) =>
      allowTransfer(tx, { orgId, backupId, toServerId: toServer, now }),
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
      allowTransfer(tx, { orgId, backupId, toServerId: toServer, now }),
    );
    await t.db.delete(backups);
    await expect(
      t.db.transaction((tx) => claimTransfer(tx, allowed.id, allowed.token, now)),
    ).rejects.toThrow(/not available|no longer here/);
  });
});
