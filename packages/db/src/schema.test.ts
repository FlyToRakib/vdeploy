import { newId } from '@vdeploy/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, organization, projects, releases } from './schema/index.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await t.stop();
});

const spec = {
  apiVersion: 'vdeploy/v1',
  kind: 'Application',
  metadata: { name: 'blog', labels: {} },
} as never;

async function seedRelease() {
  const orgId = newId('organization');
  const projectId = newId('project');
  const releaseId = newId('release');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(projects).values({ id: projectId, orgId, name: 'blog', spec, specHash: 'h' });
  await t.db.insert(releases).values({
    id: releaseId,
    projectId,
    version: 1,
    spec,
    specHash: 'h',
    image: `nginx@sha256:${'a'.repeat(64)}`,
    secretVersions: {},
  });
  return { orgId, projectId, releaseId };
}

/** Drizzle wraps driver errors; the Postgres message is on `cause`. */
async function refusal(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
    return 'not refused';
  } catch (error) {
    return (error as { cause?: { message?: string } }).cause?.message ?? String(error);
  }
}

describe('schema', () => {
  it('refuses to change a release', async () => {
    const { releaseId } = await seedRelease();
    expect(
      await refusal(t.db.execute(sql`update releases set image = 'x' where id = ${releaseId}`)),
    ).toMatch(/append-only/);
  });

  it('refuses to update, delete or truncate audit records', async () => {
    await t.db.insert(auditLog).values({
      id: newId('auditEntry'),
      chain: '',
      occurredAt: new Date(),
      actor: { system: 'test' },
      action: 'test.event',
      outcome: 'succeeded',
      details: {},
      prevHash: '0'.repeat(64),
      hash: '1'.repeat(64),
    });
    expect(await refusal(t.db.execute(sql`update audit_log set action = 'x'`))).toMatch(
      /append-only/,
    );
    expect(await refusal(t.db.execute(sql`delete from audit_log`))).toMatch(/append-only/);
    expect(await refusal(t.db.execute(sql`truncate audit_log`))).toMatch(/append-only/);
  });

  it('allows a project name again only after the old project is deleted', async () => {
    const { orgId, projectId } = await seedRelease();
    const again = { id: newId('project'), orgId, name: 'blog', spec, specHash: 'h' };
    await expect(t.db.insert(projects).values(again)).rejects.toThrow();
    await t.db.execute(sql`update projects set deleted_at = now() where id = ${projectId}`);
    await expect(t.db.insert(projects).values(again)).resolves.toBeDefined();
  });
});
