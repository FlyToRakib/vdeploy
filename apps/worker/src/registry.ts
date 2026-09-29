import { VDeployError } from '@vdeploy/contracts';

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export interface ImageReference {
  /** The name as written, without tag or digest ("nginx", "ghcr.io/acme/app"). */
  name: string;
  registry: string;
  repository: string;
  reference: string;
}

/** Splits "ghcr.io/acme/app:v1" into registry, repository and tag (docker.io by default). */
export function parseImage(image: string): ImageReference {
  const at = image.indexOf('@');
  const name0 = at >= 0 ? image.slice(0, at) : image;
  const lastColon = name0.lastIndexOf(':');
  const hasTag = lastColon > name0.lastIndexOf('/');
  const name = hasTag ? name0.slice(0, lastColon) : name0;
  const reference = at >= 0 ? image.slice(at + 1) : hasTag ? name0.slice(lastColon + 1) : 'latest';
  const first = name.split('/')[0] ?? '';
  const explicitHost =
    name.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  const registry = explicitHost ? first : 'docker.io';
  const path = explicitHost ? name.slice(first.length + 1) : name;
  const repository = registry === 'docker.io' && !path.includes('/') ? `library/${path}` : path;
  return { name, registry, repository, reference };
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface RegistryAccess {
  fetch: Fetch;
  /** Base URL of a registry's API; Docker Hub's API host differs from its name. */
  baseUrl: (registry: string) => string;
}

export const publicRegistries: RegistryAccess = {
  fetch: (input, init) => fetch(input, init),
  baseUrl: (registry) => `https://${registry === 'docker.io' ? 'registry-1.docker.io' : registry}`,
};

const RETRY_DELAYS_MS = [1000, 3000, 9000];

/**
 * Registries and networks fail transiently; a timeout is retried with backoff
 * before the plan fails — and then in words that say what to check.
 */
async function reach(access: RegistryAccess, image: string, url: string, init?: RequestInit) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await access.fetch(url, init);
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        throw new VDeployError(
          'unavailable',
          `Could not reach the registry for ${image}. Check that the server can reach the internet, then try again.`,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function challenge(header: string | null): { realm: string; params: URLSearchParams } | null {
  if (!header?.startsWith('Bearer ')) return null;
  const params = new URLSearchParams();
  for (const [, key, value] of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) {
    if (key && value !== undefined) params.set(key, value);
  }
  const realm = params.get('realm');
  if (!realm) return null;
  params.delete('realm');
  return { realm, params };
}

/**
 * Pins an image to the digest its tag points at right now. A release never
 * references a mutable tag: rollback must restore exactly what ran (§5).
 * Public images only for now; the anonymous token flow covers Docker Hub,
 * GHCR and any registry following the distribution spec.
 */
export async function pinImage(
  image: string,
  access: RegistryAccess = publicRegistries,
  login?: { username: string; password: string } | null,
): Promise<string> {
  const ref = parseImage(image);
  if (ref.reference.startsWith('sha256:')) return `${ref.name}@${ref.reference}`;
  const url = `${access.baseUrl(ref.registry)}/v2/${ref.repository}/manifests/${ref.reference}`;
  const headers: Record<string, string> = { accept: MANIFEST_TYPES };
  // A private registry is signed in to with what the organization keeps
  // for it (§15): as Basic to the token service, or to the registry itself
  // when that is all it asks for.
  const basic = login
    ? `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}`
    : null;
  let res = await reach(access, image, url, { method: 'HEAD', headers });
  if (res.status === 401 && basic && /^Basic/i.test(res.headers.get('www-authenticate') ?? '')) {
    res = await reach(access, image, url, {
      method: 'HEAD',
      headers: { ...headers, authorization: basic },
    });
  } else if (res.status === 401) {
    const auth = challenge(res.headers.get('www-authenticate'));
    if (!auth) throw new VDeployError('unavailable', `The registry for ${image} refused access`);
    const token = await reach(
      access,
      image,
      `${auth.realm}?${auth.params.toString()}`,
      basic ? { headers: { authorization: basic } } : undefined,
    );
    const body = (await token.json()) as { token?: string; access_token?: string };
    const bearer = body.token ?? body.access_token;
    if (!token.ok || !bearer) {
      throw new VDeployError(
        'unavailable',
        login
          ? `The sign-in kept for ${ref.registry} was refused; add it again with a password or token that can read ${image}`
          : `No access to ${image}. If it is private, sign in to ${ref.registry} under Registries first`,
      );
    }
    res = await reach(access, image, url, {
      method: 'HEAD',
      headers: { ...headers, authorization: `Bearer ${bearer}` },
    });
  }
  if (res.status === 404) {
    throw new VDeployError(
      'not_found',
      `The image ${image} does not exist, or its tag is misspelled`,
    );
  }
  const digest = res.headers.get('docker-content-digest');
  if (!res.ok || !digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new VDeployError('unavailable', `Could not read the digest of ${image} (${res.status})`);
  }
  return `${ref.name}@${digest}`;
}
