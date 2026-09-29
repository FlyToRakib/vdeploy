import { describe, expect, it } from 'vitest';
import { makeSpec } from './fixtures.test-helpers.js';
import { changeWords, type ChangeSide } from './undo.js';

const side = (overrides: Partial<ChangeSide> = {}): ChangeSide => ({
  spec: makeSpec(),
  image: 'nginx@sha256:aaa',
  secretVersions: {},
  ...overrides,
});

describe('changeWords', () => {
  it('says what changed in the words of the screen it was changed on', () => {
    const before = side({
      spec: makeSpec({
        runtime: {
          resources: { memory: { limit: '512Mi' } },
          env: [
            { key: 'MODE', value: 'a' },
            { key: 'OLD', value: 'x' },
          ],
        },
      }),
    });
    const after = side({
      spec: makeSpec({
        network: {
          containerPort: 80,
          domains: [{ host: 'blog.example.com' }, { host: 'www.example.com' }],
        },
        runtime: {
          resources: { memory: { limit: '1Gi' } },
          env: [
            { key: 'MODE', value: 'b' },
            { key: 'API_TOKEN', value: 'sk_live_do_not_show' },
          ],
        },
        health: { readiness: { type: 'http', path: '/ready' } },
      }),
    });
    const words = changeWords(before, after);
    expect(words).toEqual(
      expect.arrayContaining([
        'Memory 512 MB → 1 GB',
        'Added the address www.example.com',
        'Added the setting API_TOKEN',
        'Changed the setting MODE',
        'Removed the setting OLD',
        'Its health checks',
      ]),
    );
    // A setting is named, never shown.
    expect(words.join(' ')).not.toContain('sk_live');
  });

  it('calls new bytes new code, and a new secret version a secret', () => {
    expect(changeWords(side(), side({ image: 'nginx@sha256:bbb' }))).toEqual([
      'A new version of its code',
    ]);
    expect(
      changeWords(side({ secretVersions: { sec_1: 1 } }), side({ secretVersions: { sec_1: 2 } })),
    ).toEqual(['A secret value it reads']);
  });

  it('says one thing per area, however many fields moved in it', () => {
    const after = side({
      spec: makeSpec({ deploy: { strategy: 'recreate', drainPeriod: '5s', timeout: '2m' } }),
    });
    expect(changeWords(side(), after)).toEqual(['How a new version replaces the old one']);
  });
});
