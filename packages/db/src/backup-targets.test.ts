import { newId } from '@vdeploy/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backupTargetSecrets,
  dismissOffsiteWarning,
  finishOffsiteCheck,
  liveBackupTarget,
  offsiteDismissedAt,
  queueOffsiteCheck,
  removeBackupTarget,
  setBackupTarget,
} from './backup-targets.js';
import { createChannel, listDeliveries, notifyBackupResult } from './notifications.js';
import { backupTargets, organization, servers, user } from './schema/index.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

let t: TestDatabase;
let orgId: string;
let serverId: string;
let userId: string;
const KEY = Buffer.alloc(32, 9);

const target = (repository = 's3:https://s3.example.com/acme/vdeploy') => ({
  orgId,
  repository,
  region: 'eu-central-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'a-secret-nobody-should-see',
  password: 'the-key-that-must-not-be-lost',
});

beforeAll(async () => {
  t = await startTestDatabase();
  orgId = newId('organization');
  userId = newId('user');
  serverId = newId('server');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(user).values({ id: userId, name: 'Owner', email: 'owner@example.com' });
  await t.db.insert(servers).values({ id: serverId, orgId, name: 'server-01', status: 'online' });
}, 120_000);

afterAll(async () => {
  await t.stop();
});

describe('where copies go', () => {
  it('stores nothing in the clear, and gives it all back', async () => {
    const row = await t.db.transaction((tx) =>
      setBackupTarget(tx, KEY, target(), new Date('2026-09-25T00:00:00Z')),
    );
    const stored = JSON.stringify(row);
    expect(stored).not.toContain('a-secret-nobody-should-see');
    expect(stored).not.toContain('the-key-that-must-not-be-lost');

    const secrets = await backupTargetSecrets(t.db, KEY, row);
    expect(secrets).toEqual({
      password: 'the-key-that-must-not-be-lost',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'a-secret-nobody-should-see',
    });
    // Another installation's key opens nothing.
    await expect(backupTargetSecrets(t.db, Buffer.alloc(32, 1), row)).rejects.toThrow();
  });

  it('keeps exactly one live target, so nothing is protected by halves', async () => {
    await t.db.transaction((tx) =>
      setBackupTarget(tx, KEY, target('s3:https://s3.example.com/second/vdeploy'), new Date()),
    );
    const live = await liveBackupTarget(t.db, orgId);
    expect(live?.repository).toBe('s3:https://s3.example.com/second/vdeploy');
    // The one it replaced is still on record: its snapshots are still out there.
    expect(await t.db.select().from(backupTargets)).toHaveLength(2);
  });

  it('is not trusted until a server has actually reached it', async () => {
    const before = await liveBackupTarget(t.db, orgId);
    expect(before?.status).toBe('pending');
    const checkId = await t.db.transaction((tx) =>
      queueOffsiteCheck(tx, before?.id ?? '', serverId, new Date()),
    );

    // An answer about some other check changes nothing.
    await finishOffsiteCheck(t.db, { checkId: 'chk_other', ok: true, log: '' }, new Date());
    expect((await liveBackupTarget(t.db, orgId))?.status).toBe('pending');

    await finishOffsiteCheck(
      t.db,
      { checkId, ok: false, error: 'wrong password or no key found', log: '' },
      new Date(),
    );
    const failed = await liveBackupTarget(t.db, orgId);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('wrong password or no key found');
  });

  it('stops sending copies without touching what is already there', async () => {
    expect(await removeBackupTarget(t.db, orgId, new Date())).toBe(true);
    expect(await liveBackupTarget(t.db, orgId)).toBeNull();
    // Nothing to remove the second time, and nothing pretends otherwise.
    expect(await removeBackupTarget(t.db, orgId, new Date())).toBe(false);
  });

  it('remembers that someone accepted the risk, and that they changed their mind', async () => {
    expect(await offsiteDismissedAt(t.db, orgId)).toBeNull();
    const at = new Date('2026-09-25T09:00:00Z');
    await dismissOffsiteWarning(t.db, orgId, userId, true, at);
    expect(await offsiteDismissedAt(t.db, orgId)).toEqual(at);
    await dismissOffsiteWarning(t.db, orgId, userId, false, new Date());
    expect(await offsiteDismissedAt(t.db, orgId)).toBeNull();
  });
});

describe('what people are told about a backup', () => {
  const database = { id: newId('database'), name: 'blog-db' };
  const at = new Date('2026-09-25T03:00:00Z');

  beforeAll(async () => {
    await createChannel(
      t.db,
      KEY,
      {
        orgId,
        name: 'ops',
        config: { kind: 'email', to: ['ops@example.com'] },
        triggers: ['backup_failed'],
      },
      at,
    );
  });

  const titles = async () => (await listDeliveries(t.db, orgId)).map((delivery) => delivery.title);

  it('says when a backup did not work, and why', async () => {
    await notifyBackupResult(
      t.db,
      orgId,
      database,
      { ok: false, verified: false, error: 'the backup file is empty: nothing was saved' },
      at,
    );
    expect(await titles()).toContain('The backup of blog-db did not work');
  });

  it('says when a good backup never left the server it protects', async () => {
    await notifyBackupResult(
      t.db,
      orgId,
      database,
      {
        ok: true,
        verified: true,
        offsite: { ok: false, error: 'your storage refused the copy' },
      },
      new Date('2026-09-26T03:00:00Z'),
    );
    expect(await titles()).toContain('The backup of blog-db never left the server');
  });

  it('says nothing when everything worked', async () => {
    const before = (await titles()).length;
    await notifyBackupResult(
      t.db,
      orgId,
      database,
      { ok: true, verified: true, offsite: { ok: true } },
      new Date('2026-09-27T03:00:00Z'),
    );
    expect(await titles()).toHaveLength(before);
  });
});
