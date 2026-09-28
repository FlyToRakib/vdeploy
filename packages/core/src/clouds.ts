import { VDeployError } from '@vdeploy/contracts';

/**
 * Servers VDeploy makes for you (§26 M6, ADR 0024).
 *
 * Three providers, one interface, and the interface is small on purpose:
 * make a machine, ask what became of it, throw it away, and list what
 * sizes and places are on offer. Everything that happens *after* the
 * machine exists is the part VDeploy already had — the same installer,
 * the same enrollment token, the same agent connecting outbound — so
 * provisioning is a way of reaching the existing first step, not a
 * second way of adding a server.
 *
 * Each provider's shapes come from its documented public API. They are
 * kept in one file, beside each other, because the differences are the
 * whole content: Hetzner names an image, DigitalOcean names a different
 * spelling of the same image, and Vultr wants a numeric id it will only
 * tell you if you ask.
 */

export type CloudProvider = 'hetzner' | 'digitalocean' | 'vultr';

export const CLOUD_LABELS: Readonly<Record<CloudProvider, string>> = {
  hetzner: 'Hetzner Cloud',
  digitalocean: 'DigitalOcean',
  vultr: 'Vultr',
};

/** Where a provider answers, and what it calls its own machines. */
const API: Readonly<Record<CloudProvider, string>> = {
  hetzner: 'https://api.hetzner.cloud/v1',
  digitalocean: 'https://api.digitalocean.com/v2',
  vultr: 'https://api.vultr.com/v2',
};

/** A place a machine can be put. */
export interface CloudRegion {
  id: string;
  label: string;
}

/** A size a machine can be, with what it costs so nobody is surprised. */
export interface CloudSize {
  id: string;
  label: string;
  vcpus: number;
  memoryMb: number;
  diskGb: number;
  /** Monthly price in the provider's own currency, when it says one. */
  monthly: number | null;
  currency: string | null;
  /** Where this size can actually be had. */
  regions: string[];
}

/** A machine, as far as VDeploy needs to know. */
export interface CloudMachine {
  /** The provider's id for it, which is how it is later destroyed. */
  id: string;
  /** `building` until it has an address and is running. */
  status: 'building' | 'running' | 'gone';
  ipv4: string | null;
}

export interface CloudAccount {
  provider: CloudProvider;
  token: string;
}

export interface MachineRequest {
  name: string;
  region: string;
  size: string;
  /** Run at first boot: the one command that installs and enrolls the agent. */
  userData: string;
  /** Public keys to put on it, so a person is not locked out of their own machine. */
  sshKeys?: readonly string[];
}

/** Ubuntu 24.04, spelled the way each provider spells it. */
const IMAGE: Readonly<Record<CloudProvider, string>> = {
  hetzner: 'ubuntu-24.04',
  digitalocean: 'ubuntu-24-04-x64',
  // Vultr wants a numeric id, looked up by this name at request time.
  vultr: 'Ubuntu 24.04 LTS x64',
};

type Fetcher = typeof fetch;

async function ask(
  account: CloudAccount,
  path: string,
  init: RequestInit = {},
  fetchImpl: Fetcher = fetch,
): Promise<unknown> {
  const where = CLOUD_LABELS[account.provider];
  let response: Response;
  try {
    response = await fetchImpl(`${API[account.provider]}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${account.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new VDeployError('unavailable', `${where} could not be reached from this VDeploy.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new VDeployError(
      'forbidden',
      `${where} refused that token. It may have expired, or it may not be allowed to make servers.`,
    );
  }
  if (response.status === 404) throw new VDeployError('not_found', `${where} has no such server.`);
  if (response.status === 204) return {};
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new VDeployError(
      response.status >= 500 ? 'unavailable' : 'invalid_input',
      `${where} answered ${String(response.status)}: ${messageIn(body) ?? 'no reason given'}`,
    );
  }
  return body;
}

/** Whatever each provider calls the sentence explaining a refusal. */
function messageIn(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const shape = body as { error?: unknown; message?: unknown };
  if (typeof shape.message === 'string') return shape.message;
  if (typeof shape.error === 'string') return shape.error;
  if (typeof shape.error === 'object' && shape.error !== null) {
    const nested = (shape.error as { message?: unknown }).message;
    if (typeof nested === 'string') return nested;
  }
  return null;
}

function list(body: unknown, key: string): unknown[] {
  const found = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(found) ? found : [];
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
/** Two providers number their machines and one names them; both are ids here. */
const numberOrString = (value: unknown): string | null =>
  typeof value === 'number' ? String(value) : str(value);

/** Whether a token works at all, asked before it is stored. */
export async function checkCloudToken(
  account: CloudAccount,
  fetchImpl: Fetcher = fetch,
): Promise<void> {
  // The cheapest authenticated read each provider offers.
  const path = account.provider === 'hetzner' ? '/locations' : '/regions';
  await ask(account, path, {}, fetchImpl);
}

export async function cloudRegions(
  account: CloudAccount,
  fetchImpl: Fetcher = fetch,
): Promise<CloudRegion[]> {
  if (account.provider === 'hetzner') {
    const body = await ask(account, '/locations', {}, fetchImpl);
    return list(body, 'locations').flatMap((row) => {
      const one = row as { name?: unknown; city?: unknown; country?: unknown };
      const id = str(one.name);
      return id ? [{ id, label: `${str(one.city) ?? id}, ${str(one.country) ?? ''}`.trim() }] : [];
    });
  }
  if (account.provider === 'digitalocean') {
    const body = await ask(account, '/regions', {}, fetchImpl);
    return list(body, 'regions').flatMap((row) => {
      const one = row as { slug?: unknown; name?: unknown; available?: unknown };
      const id = str(one.slug);
      return id && one.available !== false ? [{ id, label: str(one.name) ?? id }] : [];
    });
  }
  const body = await ask(account, '/regions', {}, fetchImpl);
  return list(body, 'regions').flatMap((row) => {
    const one = row as { id?: unknown; city?: unknown; country?: unknown };
    const id = str(one.id);
    return id ? [{ id, label: `${str(one.city) ?? id}, ${str(one.country) ?? ''}`.trim() }] : [];
  });
}

export async function cloudSizes(
  account: CloudAccount,
  fetchImpl: Fetcher = fetch,
): Promise<CloudSize[]> {
  if (account.provider === 'hetzner') {
    const body = await ask(account, '/server_types', {}, fetchImpl);
    return list(body, 'server_types').flatMap((row) => {
      const one = row as {
        name?: unknown;
        description?: unknown;
        cores?: unknown;
        memory?: unknown;
        disk?: unknown;
        deprecated?: unknown;
        prices?: unknown;
      };
      const id = str(one.name);
      if (!id || one.deprecated === true) return [];
      const prices = Array.isArray(one.prices) ? one.prices : [];
      const first = prices[0] as { price_monthly?: { gross?: unknown } } | undefined;
      return [
        {
          id,
          label: str(one.description) ?? id,
          vcpus: num(one.cores),
          // Hetzner reports memory in GB, as a number that can be 0.5.
          memoryMb: Math.round(num(one.memory) * 1024),
          diskGb: num(one.disk),
          monthly: Number(first?.price_monthly?.gross ?? 0) || null,
          currency: 'EUR',
          regions: prices.flatMap((price) => {
            const where = str((price as { location?: unknown }).location);
            return where ? [where] : [];
          }),
        },
      ];
    });
  }
  if (account.provider === 'digitalocean') {
    const body = await ask(account, '/sizes?per_page=200', {}, fetchImpl);
    return list(body, 'sizes').flatMap((row) => {
      const one = row as {
        slug?: unknown;
        description?: unknown;
        vcpus?: unknown;
        memory?: unknown;
        disk?: unknown;
        price_monthly?: unknown;
        available?: unknown;
        regions?: unknown;
      };
      const id = str(one.slug);
      if (!id || one.available === false) return [];
      return [
        {
          id,
          label: str(one.description) ?? id,
          vcpus: num(one.vcpus),
          memoryMb: num(one.memory),
          diskGb: num(one.disk),
          monthly: num(one.price_monthly) || null,
          currency: 'USD',
          regions: Array.isArray(one.regions)
            ? one.regions.filter((r): r is string => typeof r === 'string')
            : [],
        },
      ];
    });
  }
  const body = await ask(account, '/plans?per_page=500', {}, fetchImpl);
  return list(body, 'plans').flatMap((row) => {
    const one = row as {
      id?: unknown;
      vcpu_count?: unknown;
      ram?: unknown;
      disk?: unknown;
      monthly_cost?: unknown;
      locations?: unknown;
    };
    const id = str(one.id);
    if (!id) return [];
    return [
      {
        id,
        label: id,
        vcpus: num(one.vcpu_count),
        memoryMb: num(one.ram),
        diskGb: num(one.disk),
        monthly: num(one.monthly_cost) || null,
        currency: 'USD',
        regions: Array.isArray(one.locations)
          ? one.locations.filter((r): r is string => typeof r === 'string')
          : [],
      },
    ];
  });
}

/** Vultr names its images by number, and will only say which if asked. */
async function vultrImageId(account: CloudAccount, fetchImpl: Fetcher): Promise<number> {
  const body = await ask(account, '/os?per_page=500', {}, fetchImpl);
  const wanted = IMAGE.vultr.toLowerCase();
  for (const row of list(body, 'os')) {
    const one = row as { id?: unknown; name?: unknown };
    if (str(one.name)?.toLowerCase() === wanted && typeof one.id === 'number') return one.id;
  }
  throw new VDeployError(
    'unavailable',
    `Vultr does not currently offer ${IMAGE.vultr}, which is what VDeploy installs on.`,
  );
}

export async function createMachine(
  account: CloudAccount,
  request: MachineRequest,
  fetchImpl: Fetcher = fetch,
): Promise<CloudMachine> {
  if (account.provider === 'hetzner') {
    const body = await ask(
      account,
      '/servers',
      {
        method: 'POST',
        body: JSON.stringify({
          name: request.name,
          server_type: request.size,
          location: request.region,
          image: IMAGE.hetzner,
          user_data: request.userData,
          ...(request.sshKeys?.length ? { ssh_keys: request.sshKeys } : {}),
          labels: { vdeploy: 'true' },
        }),
      },
      fetchImpl,
    );
    return readHetzner((body as { server?: unknown }).server);
  }
  if (account.provider === 'digitalocean') {
    const body = await ask(
      account,
      '/droplets',
      {
        method: 'POST',
        body: JSON.stringify({
          name: request.name,
          region: request.region,
          size: request.size,
          image: IMAGE.digitalocean,
          user_data: request.userData,
          ...(request.sshKeys?.length ? { ssh_keys: request.sshKeys } : {}),
          tags: ['vdeploy'],
        }),
      },
      fetchImpl,
    );
    return readDigitalOcean((body as { droplet?: unknown }).droplet);
  }
  const body = await ask(
    account,
    '/instances',
    {
      method: 'POST',
      body: JSON.stringify({
        label: request.name,
        hostname: request.name,
        region: request.region,
        plan: request.size,
        os_id: await vultrImageId(account, fetchImpl),
        // Vultr is the one that wants this encoded.
        user_data: Buffer.from(request.userData, 'utf8').toString('base64'),
        ...(request.sshKeys?.length ? { sshkey_id: [...request.sshKeys] } : {}),
        tags: ['vdeploy'],
      }),
    },
    fetchImpl,
  );
  return readVultr((body as { instance?: unknown }).instance);
}

export async function getMachine(
  account: CloudAccount,
  id: string,
  fetchImpl: Fetcher = fetch,
): Promise<CloudMachine> {
  try {
    if (account.provider === 'hetzner') {
      const body = await ask(account, `/servers/${encodeURIComponent(id)}`, {}, fetchImpl);
      return readHetzner((body as { server?: unknown }).server);
    }
    if (account.provider === 'digitalocean') {
      const body = await ask(account, `/droplets/${encodeURIComponent(id)}`, {}, fetchImpl);
      return readDigitalOcean((body as { droplet?: unknown }).droplet);
    }
    const body = await ask(account, `/instances/${encodeURIComponent(id)}`, {}, fetchImpl);
    return readVultr((body as { instance?: unknown }).instance);
  } catch (error) {
    // A machine the provider has never heard of is a machine that is
    // gone, which is an answer rather than a failure.
    if (error instanceof VDeployError && error.code === 'not_found') {
      return { id, status: 'gone', ipv4: null };
    }
    throw error;
  }
}

export async function destroyMachine(
  account: CloudAccount,
  id: string,
  fetchImpl: Fetcher = fetch,
): Promise<void> {
  const path =
    account.provider === 'hetzner'
      ? `/servers/${encodeURIComponent(id)}`
      : account.provider === 'digitalocean'
        ? `/droplets/${encodeURIComponent(id)}`
        : `/instances/${encodeURIComponent(id)}`;
  try {
    await ask(account, path, { method: 'DELETE' }, fetchImpl);
  } catch (error) {
    // Already gone is the outcome that was wanted.
    if (!(error instanceof VDeployError && error.code === 'not_found')) throw error;
  }
}

function readHetzner(server: unknown): CloudMachine {
  const one = server as
    { id?: unknown; status?: unknown; public_net?: { ipv4?: { ip?: unknown } } } | undefined;
  // Hetzner numbers its machines; VDeploy keeps every provider's id as
  // the string it will send back.
  const id = numberOrString(one?.id);
  if (!id) throw new VDeployError('unavailable', 'Hetzner Cloud answered no server.');
  const ipv4 = str(one?.public_net?.ipv4?.ip);
  return {
    id,
    status: str(one?.status) === 'running' && ipv4 ? 'running' : 'building',
    ipv4,
  };
}

function readDigitalOcean(droplet: unknown): CloudMachine {
  const one = droplet as
    { id?: unknown; status?: unknown; networks?: { v4?: unknown } } | undefined;
  const id = numberOrString(one?.id);
  if (!id) throw new VDeployError('unavailable', 'DigitalOcean answered no droplet.');
  const networks = Array.isArray(one?.networks?.v4) ? one.networks.v4 : [];
  const found = networks.find((net) => (net as { type?: unknown }).type === 'public') as
    { ip_address?: unknown } | undefined;
  const ipv4 = str(found?.ip_address);
  return {
    id,
    status: str(one?.status) === 'active' && ipv4 ? 'running' : 'building',
    ipv4,
  };
}

function readVultr(instance: unknown): CloudMachine {
  const one = instance as
    { id?: unknown; status?: unknown; server_status?: unknown; main_ip?: unknown } | undefined;
  const id = str(one?.id);
  if (!id) throw new VDeployError('unavailable', 'Vultr answered no instance.');
  const ipv4 = str(one?.main_ip);
  // Vultr hands out 0.0.0.0 while it is still thinking.
  const address = ipv4 === '0.0.0.0' ? null : ipv4;
  return {
    id,
    status: str(one?.status) === 'active' && address ? 'running' : 'building',
    ipv4: address,
  };
}

/**
 * What a new machine runs the first time it boots.
 *
 * It is the same one command the dashboard shows somebody who is adding
 * a server by hand — deliberately, because two ways of installing an
 * agent is one of them being wrong on a Tuesday. `set -eu` so a half
 * install is a machine that never enrolls rather than one that looks
 * connected and is not.
 */
export function firstBoot(installUrl: string, token: string): string {
  if (!/^https?:\/\/[^\s'"]+$/.test(installUrl) || !/^[\w.-]+$/.test(token)) {
    throw new VDeployError('internal', 'That install command cannot be put in a script safely');
  }
  return `#!/bin/sh
set -eu
curl -fsSL '${installUrl}' | sh -s -- --token '${token}'
`;
}
