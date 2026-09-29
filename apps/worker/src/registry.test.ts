import { describe, expect, it } from 'vitest';
import { parseImage, pinImage, type RegistryAccess } from './registry.js';

const DIGEST = `sha256:${'c'.repeat(64)}`;

describe('parseImage', () => {
  it.each([
    ['nginx', 'docker.io', 'library/nginx', 'latest', 'nginx'],
    ['nginx:1.27', 'docker.io', 'library/nginx', '1.27', 'nginx'],
    ['acme/app:v2', 'docker.io', 'acme/app', 'v2', 'acme/app'],
    ['ghcr.io/acme/app:v1', 'ghcr.io', 'acme/app', 'v1', 'ghcr.io/acme/app'],
    ['localhost:5000/app', 'localhost:5000', 'app', 'latest', 'localhost:5000/app'],
    [`nginx@${DIGEST}`, 'docker.io', 'library/nginx', DIGEST, 'nginx'],
  ])('%s', (image, registry, repository, reference, name) => {
    expect(parseImage(image)).toEqual({ registry, repository, reference, name });
  });
});

/** A registry that demands an anonymous bearer token, like Docker Hub. */
function fakeRegistry(status = 200): { access: RegistryAccess; calls: string[] } {
  const calls: string[] = [];
  const access: RegistryAccess = {
    baseUrl: (registry) => `https://${registry}`,
    fetch: (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const authorized = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (url.startsWith('https://auth.example/token')) {
        return Promise.resolve(Response.json({ token: 'anon' }));
      }
      if (!authorized) {
        return Promise.resolve(
          new Response(null, {
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer realm="https://auth.example/token",service="registry",scope="repository:library/nginx:pull"',
            },
          }),
        );
      }
      return Promise.resolve(
        new Response(null, {
          status,
          headers: status === 200 ? { 'docker-content-digest': DIGEST } : {},
        }),
      );
    },
  };
  return { access, calls };
}

describe('pinImage', () => {
  it('resolves a tag to its digest through the anonymous token flow', async () => {
    const { access, calls } = fakeRegistry();
    expect(await pinImage('nginx:1.27', access)).toBe(`nginx@${DIGEST}`);
    expect(calls).toEqual([
      'HEAD https://docker.io/v2/library/nginx/manifests/1.27',
      'GET https://auth.example/token?service=registry&scope=repository%3Alibrary%2Fnginx%3Apull',
      'HEAD https://docker.io/v2/library/nginx/manifests/1.27',
    ]);
  });

  it('keeps an image that is already pinned, without any network', async () => {
    const { access, calls } = fakeRegistry();
    expect(await pinImage(`ghcr.io/acme/app@${DIGEST}`, access)).toBe(`ghcr.io/acme/app@${DIGEST}`);
    expect(calls).toEqual([]);
  });

  it('retries a flaky network before succeeding', async () => {
    const { access } = fakeRegistry();
    let failures = 1;
    const flaky: RegistryAccess = {
      ...access,
      fetch: (url, init) =>
        failures-- > 0 ? Promise.reject(new TypeError('fetch failed')) : access.fetch(url, init),
    };
    expect(await pinImage('nginx:1.27', flaky)).toBe(`nginx@${DIGEST}`);
  });

  it('explains a missing image in plain words', async () => {
    await expect(pinImage('nginx:no-such-tag', fakeRegistry(404).access)).rejects.toThrow(
      /does not exist, or its tag is misspelled/,
    );
  });
});

describe('a private registry', () => {
  const login = { username: 'acme-bot', password: 'ghp_token' };
  const basic = `Basic ${Buffer.from('acme-bot:ghp_token').toString('base64')}`;

  it('asks the token service as the organization, not anonymously', async () => {
    const tokenAuth: (string | undefined)[] = [];
    const access: RegistryAccess = {
      baseUrl: (registry) => `https://${registry}`,
      fetch: (url, init) => {
        const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
        if (url.startsWith('https://auth.example/token')) {
          tokenAuth.push(auth);
          return Promise.resolve(Response.json(auth === basic ? { token: 'mine' } : {}));
        }
        if (auth !== 'Bearer mine') {
          return Promise.resolve(
            new Response(null, {
              status: 401,
              headers: { 'www-authenticate': 'Bearer realm="https://auth.example/token"' },
            }),
          );
        }
        return Promise.resolve(
          new Response(null, { status: 200, headers: { 'docker-content-digest': DIGEST } }),
        );
      },
    };
    expect(await pinImage('ghcr.io/acme/private:v1', access, login)).toBe(
      `ghcr.io/acme/private@${DIGEST}`,
    );
    expect(tokenAuth).toEqual([basic]);
    // Without the sign-in it says where to add one, not just "no access".
    await expect(pinImage('ghcr.io/acme/private:v1', access)).rejects.toThrow(
      /sign in to ghcr.io under Registries/,
    );
  });

  it('signs in to a registry that only asks for a password', async () => {
    const access: RegistryAccess = {
      baseUrl: (registry) => `https://${registry}`,
      fetch: (_url, init) => {
        const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
        return Promise.resolve(
          auth === basic
            ? new Response(null, { status: 200, headers: { 'docker-content-digest': DIGEST } })
            : new Response(null, {
                status: 401,
                headers: { 'www-authenticate': 'Basic realm="registry"' },
              }),
        );
      },
    };
    expect(await pinImage('registry.acme.dev/shop:v2', access, login)).toBe(
      `registry.acme.dev/shop@${DIGEST}`,
    );
  });
});
