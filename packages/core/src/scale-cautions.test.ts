import { ApplicationSpec } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POOL, poolSize, scaleCautions } from './scale-cautions.js';

const spec = (over: Record<string, unknown> = {}) =>
  ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name: 'shop' },
    source: { type: 'image', image: 'nginx:1.27' },
    build: { strategy: 'image' },
    network: { containerPort: 3000, domains: [] },
    ...over,
  });

describe('before an app grows', () => {
  it('reads the pool from the settings that name it, or assumes the usual one', () => {
    expect(poolSize(spec())).toBe(DEFAULT_POOL);
    expect(poolSize(spec({ runtime: { env: [{ key: 'DB_POOL', value: '4' }] } }))).toBe(4);
    expect(
      poolSize(
        spec({
          runtime: {
            env: [{ key: 'DATABASE_URL', value: 'postgres://a@db/x?connection_limit=3' }],
          },
        }),
      ),
    ).toBe(3);
  });

  it('says plainly when sign-ins live in files, and gently when it cannot tell', () => {
    const files = spec({ runtime: { env: [{ key: 'SESSION_DRIVER', value: 'file' }] } });
    expect(scaleCautions(files, 3, [])[0]).toMatch(/SESSION_DRIVER=file/);
    expect(scaleCautions(spec(), 3, [])[0]).toMatch(/^If it keeps sign-ins/);
    // Sticky sessions already keep each visitor on one copy.
    const sticky = spec({
      network: {
        containerPort: 3000,
        domains: [],
        loadBalancer: { sticky: { enabled: true } },
      },
    });
    expect(scaleCautions(sticky, 3, [])).toEqual([]);
    // Nor is anything said going from three to four: it was said at two.
    expect(scaleCautions(spec({ runtime: { replicas: 3 } }), 4, [])).toEqual([]);
  });

  it('warns before the connections a database allows run out', () => {
    const grown = spec({ runtime: { replicas: 2 } });
    const shop = { name: 'shop-db', engine: 'postgres', otherConnections: 40 };
    // 4 copies × 10 + 40 = 80 of 100: the edge.
    expect(scaleCautions(grown, 4, [shop]).join()).toMatch(/up to 80 of the 100/);
    expect(scaleCautions(grown, 3, [shop])).toEqual([]);
    // Redis has no such limit to run into.
    expect(scaleCautions(grown, 20, [{ name: 'cache', engine: 'redis' }])).toEqual([]);
  });
});
