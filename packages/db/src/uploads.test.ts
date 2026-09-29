import { newId } from '@vdeploy/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEEP_UPLOADS_DAYS, pruneUploads, uploadRefusal } from './builds.js';
import { builds, organization, projects, servers, uploads } from './schema/index.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

let t: TestDatabase;
const orgId = newId('organization');
const serverId = newId('server');
const now = new Date('2026-09-29T12:00:00Z');
const old = new Date(now.getTime() - (KEEP_UPLOADS_DAYS + 1) * 24 * 60 * 60_000);
const actor = { userId: null, origin: 'user' } as never;

async function upload(createdAt: Date) {
  const id = newId('upload');
  await t.db.insert(uploads).values({
    id,
    orgId,
    sha256: 'a'.repeat(64),
    size: 4,
    data: Buffer.from('src!'),
    createdBy: actor,
    createdAt,
  });
  return id;
}

async function bytesOf(id: string) {
  const [row] = await t.db.select().from(uploads).where(eq(uploads.id, id));
  return row;
}

beforeAll(async () => {
  t = await startTestDatabase();
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(servers).values({
    id: serverId,
    orgId,
    name: 'app-01',
    status: 'online',
    agentPublicKey: 'a'.repeat(44),
  });
}, 120_000);

afterAll(async () => {
  await t.stop();
});

describe('uploads nothing needs any more (§6)', () => {
  it('clears old bytes, and keeps what a live app builds from or a build is using', async () => {
    const forgotten = await upload(old);
    const recent = await upload(new Date(now.getTime() - 60_000));
    const source = await upload(old);
    const building = await upload(old);
    const deletedAppSource = await upload(old);
    const spec = (uploadId: string) => ({ source: { type: 'archive', uploadId } }) as never;
    await t.db.insert(projects).values([
      {
        id: newId('project'),
        orgId,
        serverId,
        name: 'shop',
        spec: spec(source),
        specHash: 'x'.repeat(64),
      },
      {
        id: newId('project'),
        orgId,
        serverId,
        name: 'gone',
        spec: spec(deletedAppSource),
        specHash: 'x'.repeat(64),
        deletedAt: now,
      },
    ]);
    await t.db.insert(builds).values({
      id: newId('build'),
      orgId,
      serverId,
      uploadId: building,
      kind: 'build',
      strategy: 'railpack',
      options: { context: '.', args: {} },
      status: 'running',
    });

    expect(await pruneUploads(t.db, now)).toBe(2);
    for (const kept of [recent, source, building]) {
      expect((await bytesOf(kept))?.data).not.toBeNull();
    }
    for (const cleared of [forgotten, deletedAppSource]) {
      const row = await bytesOf(cleared);
      expect(row?.data).toBeNull();
      expect(row?.clearedAt).toEqual(now);
    }
    // Asked for again, a cleared upload says why rather than "not there".
    expect(uploadRefusal({ received: false, clearedAt: now })).toContain('Upload it again');
    expect(uploadRefusal({ received: false, clearedAt: null })).toContain('not there');
    expect(uploadRefusal({ received: true, clearedAt: null })).toBeNull();
    expect(await pruneUploads(t.db, now)).toBe(0);
  });
});
