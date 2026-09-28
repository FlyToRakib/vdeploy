import { OPERATIONS } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from './reference.js';

const doc = openApiDocument('https://vdeploy.example.com') as {
  paths: Record<string, { post?: { description: string; security: unknown[]; tags: string[] } }>;
  info: { description: string };
  components: { securitySchemes: Record<string, unknown> };
};

describe('the public API describes itself from the catalog (§26 M6)', () => {
  /*
   * A reference written by hand is wrong the first time somebody adds an
   * operation and does not notice — and what people would trust it about
   * is exactly what it would be wrong about: which calls can delete their
   * data. So there is nothing to keep in step.
   */
  it('documents every operation there is, and invents none', () => {
    const documented = Object.keys(doc.paths)
      .filter((path) => path.includes('/operations/'))
      .map((path) => path.split('/operations/')[1])
      .sort();
    expect(documented).toEqual(OPERATIONS.map((o) => o.name).sort());
  });

  it('says plainly which calls no key can make', () => {
    for (const operation of OPERATIONS) {
      const entry = doc.paths[`/api/v1/operations/${operation.name}`]?.post;
      if (operation.tier !== 'human_only') continue;
      // No security scheme at all: not "some other key", but nobody.
      expect(entry?.security).toEqual([]);
      expect(entry?.description).toMatch(/reserved for a\s+signed-in person/);
    }
  });

  it('offers a key or a session for everything a key may call', () => {
    for (const operation of OPERATIONS) {
      if (operation.tier === 'human_only') continue;
      const entry = doc.paths[`/api/v1/operations/${operation.name}`]?.post;
      expect(entry?.security).toEqual([{ apiKey: [] }, { session: [] }]);
    }
  });

  it('warns where a change needs the password again', () => {
    const stepUp = OPERATIONS.filter((o) => o.stepUp && o.tier !== 'human_only');
    for (const operation of stepUp) {
      expect(doc.paths[`/api/v1/operations/${operation.name}`]?.post?.description).toMatch(
        /password again/,
      );
    }
  });

  it('explains that a plan waiting for approval is not a failure', () => {
    expect(doc.info.description).toMatch(/202.+plan waiting for approval/s);
    expect(doc.info.description).toMatch(/not an error/);
  });

  it('carries a schema for every input, so a caller reads what is enforced', () => {
    for (const operation of OPERATIONS) {
      const path = `/api/v1/operations/${operation.name}`;
      const entry = doc.paths[path]?.post as unknown as
        | {
            requestBody: {
              content: Record<string, { schema: { properties: { input: unknown } } }>;
            };
          }
        | undefined;
      const json = entry?.requestBody.content['application/json'];
      const schema = json?.schema.properties.input;
      expect(schema, operation.name).toBeTruthy();
    }
  });

  it('groups them the way people look for them', () => {
    const tags = new Set(
      Object.values(doc.paths as Record<string, Record<string, { tags?: string[] }>>).flatMap(
        (entry) => Object.values(entry).flatMap((verb) => verb.tags ?? []),
      ),
    );
    for (const expected of ['project', 'database', 'backup', 'server', 'plans']) {
      expect([...tags]).toContain(expected);
    }
  });
});
