import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { VDeployError } from '@vdeploy/contracts';

/**
 * GitHub App access (M2 2.15, ADR 0010). The network goes through an
 * injected `fetch`, so tests run against a stand-in GitHub.
 */
export interface GithubAppConfig {
  appId: string;
  /** The app's RSA private key, PEM. */
  privateKey: string;
  /** https://api.github.com, or a stand-in in tests. */
  apiUrl: string;
  fetch?: typeof fetch;
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** The app's own identity: a JWT signed with its key, valid for nine minutes. */
export function appJwt(appId: string, privateKey: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: appId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

/** GitHub signs every webhook with the app's secret: `sha256=<hex HMAC of the raw body>`. */
export function verifyGithubSignature(
  secret: string,
  body: Buffer | string,
  header: string | undefined,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A monorepo path filter (`apps/api/**`): `**` crosses folders, `*` and `?` do not. */
export function pathMatcher(patterns: readonly string[]): (path: string) => boolean {
  if (patterns.length === 0) return () => true;
  const regexes = patterns.map((pattern) => {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern.charAt(i);
      if (c === '*' && pattern[i + 1] === '*') {
        // "a/**/b" also matches "a/b"; a trailing "**" matches everything below.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else if (c === '*') out += '[^/]*';
      else if (c === '?') out += '[^/]';
      else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out.replace(/^\//, '')}$`);
  });
  return (path) => regexes.some((r) => r.test(path.replace(/^\//, '')));
}

async function call<T>(
  config: GithubAppConfig,
  path: string,
  auth: string,
  init: { method?: string } = {},
): Promise<T> {
  const res = await (config.fetch ?? fetch)(`${config.apiUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${auth}`,
      'user-agent': 'VDeploy',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (res.status === 404) throw new VDeployError('not_found', `GitHub has no ${path}`);
  if (!res.ok) throw new VDeployError('unavailable', `GitHub answered ${res.status}; try again`);
  return (await res.json()) as T;
}

export interface GithubInstallationInfo {
  id: number;
  account: { login: string; type: string };
  repository_selection: 'all' | 'selected';
  suspended_at: string | null;
}

/** What GitHub says about an installation of this app. */
export function getInstallation(config: GithubAppConfig, installationId: number, now: Date) {
  return call<GithubInstallationInfo>(
    config,
    `/app/installations/${installationId}`,
    appJwt(config.appId, config.privateKey, now),
  );
}

/** A token for one installation, good for an hour; ask again for each job. */
export async function installationToken(
  config: GithubAppConfig,
  installationId: number,
  now: Date,
): Promise<string> {
  const { token } = await call<{ token: string }>(
    config,
    `/app/installations/${installationId}/access_tokens`,
    appJwt(config.appId, config.privateKey, now),
    { method: 'POST' },
  );
  return token;
}

export interface GithubRepository {
  full_name: string;
  private: boolean;
  default_branch: string;
}

/** The repositories one installation can read (at most 300: the picker, not an index). */
export async function installationRepositories(
  config: GithubAppConfig,
  token: string,
): Promise<GithubRepository[]> {
  const repos: GithubRepository[] = [];
  for (let page = 1; page <= 3; page++) {
    const { repositories } = await call<{ repositories: GithubRepository[] }>(
      config,
      `/installation/repositories?per_page=100&page=${page}`,
      token,
    );
    repos.push(...repositories);
    if (repositories.length < 100) break;
  }
  return repos;
}

/** The commit a branch points at now. */
export async function branchHead(
  config: GithubAppConfig,
  token: string,
  repo: string,
  branch: string,
): Promise<string> {
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  const { sha } = await call<{ sha: string }>(config, `/repos/${repo}/commits/${ref}`, token);
  return sha;
}

/** Where a commit's source is downloaded from (GitHub redirects to a signed link). */
export function tarballPath(repo: string, sha: string): string {
  return `/repos/${repo}/tarball/${encodeURIComponent(sha)}`;
}

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** https://github.com, or a stand-in in tests. */
  webUrl: string;
}

/**
 * Proves the person finishing an installation can see it: the code GitHub
 * hands back is exchanged for their own token, and the installation must be
 * among theirs. Without this, anyone who learned an installation id could
 * link someone else's repositories to their org.
 */
export async function userCanSeeInstallation(
  config: GithubAppConfig & GithubOAuthConfig,
  code: string,
  installationId: number,
): Promise<boolean> {
  const doFetch = config.fetch ?? fetch;
  const res = await doFetch(`${config.webUrl}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    }),
  });
  if (!res.ok) return false;
  const { access_token: token } = (await res.json()) as { access_token?: string };
  if (!token) return false;
  for (let page = 1; page <= 10; page++) {
    const { installations } = await call<{ installations: { id: number }[] }>(
      config,
      `/user/installations?per_page=100&page=${page}`,
      token,
    );
    if (installations.some((i) => i.id === installationId)) return true;
    if (installations.length < 100) return false;
  }
  return false;
}
