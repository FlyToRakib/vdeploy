import { createHmac } from 'node:crypto';
import { VDeployError } from '@vdeploy/contracts';

/**
 * Where an app's source comes from, when it is not GitHub (§26 M6).
 *
 * GitHub has an App: an installation the owner grants, tokens minted per
 * install, webhooks signed by a shared secret (ADR 0010). GitLab and
 * Bitbucket do not work that way, and pretending they do would mean
 * building two more OAuth dances for a smaller return. They take an
 * **access token** the person makes themselves and pastes in — which is
 * stored like any other secret, can be scoped read-only at the provider,
 * and is the only credential either service really wants for this.
 *
 * It also buys the case that matters most for a platform about owning
 * your servers: a **self-hosted GitLab**. The host is part of the
 * connection rather than assumed, so `git.example.internal` works exactly
 * as `gitlab.com` does.
 *
 * Bitbucket is the cloud one only. Bitbucket Data Center answers a
 * different API at a different path, and half-supporting it would be
 * worse than saying so.
 */

export type GitProvider = 'github' | 'gitlab' | 'bitbucket';

export interface GitConnection {
  provider: GitProvider;
  /** `https://gitlab.com`, or the company's own. */
  host: string;
  /** Absent for a public repository. */
  token?: string;
}

/** The default home of each provider, when nobody names one. */
export const DEFAULT_HOST: Readonly<Record<GitProvider, string>> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
  bitbucket: 'https://bitbucket.org',
};

/** Only GitLab is ever somewhere else: the other two have one address each. */
export function canSelfHost(provider: GitProvider): boolean {
  return provider === 'gitlab';
}

/**
 * Where the provider's API answers, which is not always where its pages
 * are: Bitbucket serves downloads from `bitbucket.org` and its API from
 * `api.bitbucket.org`, and GitHub does the same trick with `api.github.com`.
 * GitLab is the one that keeps both on the host you connected — which is
 * exactly what makes a company's own GitLab work.
 */
export function apiBase(connection: GitConnection): string {
  const host = trimHost(connection.host);
  switch (connection.provider) {
    case 'gitlab':
      return `${host}/api/v4`;
    case 'bitbucket':
      return 'https://api.bitbucket.org/2.0';
    case 'github':
      return 'https://api.github.com';
  }
}

function trimHost(host: string): string {
  return host.replace(/\/+$/, '');
}

/** The host in an error sentence, without the scheme nobody needs to read. */
function named(host: string): string {
  try {
    return new URL(host).host;
  } catch {
    return host;
  }
}

/**
 * A repository path, checked before it is put in a URL.
 *
 * GitLab allows subgroups — `team/sub/project` — so this cannot be the
 * two-part name GitHub uses. What it must not be is anything that changes
 * which URL is fetched: no scheme, no host, no `..`, no query.
 */
const REPO = /^[\w.-]+(?:\/[\w.-]+)+$/;

export function checkRepo(repo: string): string {
  if (!REPO.test(repo) || repo.split('/').includes('..')) {
    throw new VDeployError(
      'invalid_input',
      `"${repo}" is not a repository path. It should look like owner/name, or team/sub/name on GitLab.`,
    );
  }
  return repo;
}

/** The headers that prove who is asking, per provider. */
export function authHeaders(connection: GitConnection): Record<string, string> {
  if (!connection.token) return {};
  switch (connection.provider) {
    case 'gitlab':
      // GitLab takes its own header for the personal, project and group
      // tokens people make by hand; a bearer is for OAuth, which this is not.
      return { 'private-token': connection.token };
    case 'bitbucket':
    case 'github':
      return { authorization: `Bearer ${connection.token}` };
  }
}

/**
 * Where the source of one commit is downloaded from.
 *
 * Each provider serves a tarball of a ref; none of them agrees on the
 * path, and two of them put the ref in a different place. It is one
 * function so that the worker asks "where is it" rather than knowing
 * three answers.
 */
export function archiveUrl(connection: GitConnection, repo: string, ref: string): string {
  const path = checkRepo(repo);
  const at = encodeURIComponent(ref);
  switch (connection.provider) {
    case 'gitlab':
      // The project is one URL-encoded segment, subgroup slashes and all.
      return `${apiBase(connection)}/projects/${encodeURIComponent(path)}/repository/archive.tar.gz?sha=${at}`;
    case 'bitbucket':
      return `${trimHost(connection.host)}/${path}/get/${at}.tar.gz`;
    case 'github':
      return `https://codeload.github.com/${path}/tar.gz/${at}`;
  }
}

/** Where to ask what commit a branch points at now. */
export function headUrl(connection: GitConnection, repo: string, branch: string): string {
  const base = apiBase(connection);
  const path = checkRepo(repo);
  const at = encodeURIComponent(branch);
  switch (connection.provider) {
    case 'gitlab':
      return `${base}/projects/${encodeURIComponent(path)}/repository/branches/${at}`;
    case 'bitbucket':
      return `${base}/repositories/${path}/refs/branches/${at}`;
    case 'github':
      return `${base}/repos/${path}/commits/${at}`;
  }
}

/** The commit id out of whatever shape that provider answered with. */
export function readHead(provider: GitProvider, body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const shape = body as {
    sha?: unknown;
    commit?: { id?: unknown };
    target?: { hash?: unknown };
  };
  const found =
    provider === 'gitlab'
      ? shape.commit?.id
      : provider === 'bitbucket'
        ? shape.target?.hash
        : shape.sha;
  return typeof found === 'string' && found.length > 0 ? found : null;
}

/**
 * What to tell somebody whose repository could not be read.
 *
 * The useful sentence is different per provider, because what they have
 * to go and do is different: GitHub is an app somebody installs, and the
 * other two are a token somebody makes. A single "check your
 * credentials" would be true and useless.
 */
export function cannotRead(
  connection: GitConnection,
  repo: string,
  branch: string,
  status: number,
): VDeployError {
  const at = `${repo}@${branch}`;
  const where = named(connection.host);
  if (status === 401 || status === 403) {
    return new VDeployError(
      'forbidden',
      connection.token
        ? `The token for ${where} was refused for ${at}. It may have expired, or it may not include read access to that repository.`
        : `${at} is not public. Connect ${where} with a read-only access token first.`,
    );
  }
  if (status === 404) {
    return new VDeployError(
      'not_found',
      connection.token
        ? `${where} has no ${at} that this token can see. Check the path and the branch, and that the token covers this project.`
        : `${where} has no public ${at}. If it is private, connect it with a read-only access token.`,
    );
  }
  return new VDeployError(
    'unavailable',
    `${where} answered ${String(status)} for ${at}; try again shortly.`,
  );
}

/**
 * Whether a token works, asked before it is stored.
 *
 * The rule is deliberately lenient: only a flat refusal means the token
 * is wrong. A read-only token that cannot see the account endpoint
 * answers 403, and that token is exactly the one people should be
 * pasting — rejecting it would push everybody towards a broader one.
 */
export async function checkToken(
  connection: GitConnection,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const where = named(connection.host);
  let response: Response;
  try {
    response = await fetchImpl(`${apiBase(connection)}/user`, {
      headers: { ...authHeaders(connection), accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new VDeployError(
      'unavailable',
      `${where} could not be reached from this VDeploy. Check the address, and that this server can get to it.`,
    );
  }
  if (response.status === 401) {
    throw new VDeployError('invalid_input', `${where} refused that token.`);
  }
  if (response.status >= 500) {
    throw new VDeployError(
      'unavailable',
      `${where} answered ${String(response.status)}; try again shortly.`,
    );
  }
}

/**
 * The shared secret a GitLab or Bitbucket project puts on its webhook.
 *
 * Derived from the installation key and the connection's own id rather
 * than stored: there is nothing extra to keep safe, and somebody who
 * loses the value can be shown it again instead of being told to make a
 * new hook. It changes only when the connection does.
 */
export function gitWebhookSecret(key: Buffer, connectionId: string): string {
  return createHmac('sha256', key).update(`git-webhook:${connectionId}`).digest('hex');
}

/** Whether the header naming the event says this was about a pull request. */
export function isPullRequestEvent(provider: GitProvider, event: string | undefined): boolean {
  if (!event) return false;
  return provider === 'gitlab' ? event === 'Merge Request Hook' : event.startsWith('pullrequest:');
}

/**
 * A pull request as each provider describes one, in the shape a preview
 * needs (§26 M6, ADR 0020).
 *
 * GitLab calls it a merge request and puts everything in one object.
 * Bitbucket nests it and names the target `destination`. Neither says
 * "fork" — what they say is which repository the source branch is on, and
 * a different one is a fork, which is the fact that actually matters.
 */
export interface PullRequestUpdate {
  repo: string;
  number: number;
  branch: string;
  base: string;
  commit: string;
  title: string;
  url?: string;
  fromFork: boolean;
  state: 'open' | 'closed';
}

export function readPullRequest(
  provider: GitProvider,
  event: string | undefined,
  payload: unknown,
): PullRequestUpdate | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return provider === 'gitlab' ? gitlabMergeRequest(payload) : bitbucketPullRequest(payload, event);
}

/** GitLab's own words for where a merge request has got to. */
const GITLAB_CLOSED = new Set(['close', 'merge']);
const GITLAB_OPEN = new Set(['open', 'reopen', 'update']);

function gitlabMergeRequest(payload: object): PullRequestUpdate | null {
  const body = payload as {
    object_attributes?: {
      iid?: unknown;
      title?: unknown;
      url?: unknown;
      action?: unknown;
      state?: unknown;
      source_branch?: unknown;
      target_branch?: unknown;
      last_commit?: { id?: unknown };
      source?: { path_with_namespace?: unknown };
      target?: { path_with_namespace?: unknown };
    };
  };
  const mr = body.object_attributes;
  if (!mr) return null;
  const repo = str(mr.target?.path_with_namespace);
  const branch = str(mr.source_branch);
  const base = str(mr.target_branch);
  const commit = str(mr.last_commit?.id);
  const number = typeof mr.iid === 'number' ? mr.iid : 0;
  const action = str(mr.action);
  if (!repo || !branch || !base || !commit || number < 1 || !action) return null;
  // An action that is neither opening nor closing — an assignee changed,
  // a label added — is not a thing that happened to the code.
  const state = GITLAB_CLOSED.has(action) ? 'closed' : GITLAB_OPEN.has(action) ? 'open' : null;
  if (!state) return null;
  const url = str(mr.url);
  return {
    repo,
    number,
    branch,
    base,
    commit,
    title: str(mr.title) ?? `Merge request !${String(number)}`,
    ...(url ? { url } : {}),
    fromFork: str(mr.source?.path_with_namespace) !== repo,
    state,
  };
}

/** Bitbucket says what happened in the header, not in the body. */
const BITBUCKET_CLOSED = new Set(['pullrequest:fulfilled', 'pullrequest:rejected']);
const BITBUCKET_OPEN = new Set(['pullrequest:created', 'pullrequest:updated']);

function bitbucketPullRequest(
  payload: object,
  event: string | undefined,
): PullRequestUpdate | null {
  const state = event
    ? BITBUCKET_CLOSED.has(event)
      ? 'closed'
      : BITBUCKET_OPEN.has(event)
        ? 'open'
        : null
    : null;
  if (!state) return null;
  const pr = (payload as { pullrequest?: unknown }).pullrequest as
    | {
        id?: unknown;
        title?: unknown;
        links?: { html?: { href?: unknown } };
        source?: {
          branch?: { name?: unknown };
          commit?: { hash?: unknown };
          repository?: { full_name?: unknown };
        };
        destination?: { branch?: { name?: unknown }; repository?: { full_name?: unknown } };
      }
    | undefined;
  if (!pr) return null;
  const repo = str(pr.destination?.repository?.full_name);
  const branch = str(pr.source?.branch?.name);
  const base = str(pr.destination?.branch?.name);
  const commit = str(pr.source?.commit?.hash);
  const number = typeof pr.id === 'number' ? pr.id : 0;
  if (!repo || !branch || !base || !commit || number < 1) return null;
  const url = str(pr.links?.html?.href);
  return {
    repo,
    number,
    branch,
    base,
    commit,
    title: str(pr.title) ?? `Pull request #${String(number)}`,
    ...(url ? { url } : {}),
    fromFork: str(pr.source?.repository?.full_name) !== repo,
    state,
  };
}

/** Whether the header naming the event says this was a push. */
export function isPushEvent(provider: GitProvider, event: string | undefined): boolean {
  if (!event) return false;
  return provider === 'gitlab' ? event === 'Push Hook' : event === 'repo:push';
}

/** One branch moved: what it is now, and what it touched. */
export interface PushEvent {
  repo: string;
  branch: string;
  commit: string;
  /** The files this push changed — null when the provider did not say. */
  changed: string[] | null;
}

const DELETED = /^0+$/;

/**
 * The pushes in one webhook body, as the two providers each describe them.
 *
 * Anything that is not a branch moving to a commit — a tag, a deletion, a
 * shape neither of them documents — is simply not a push here, because
 * the only honest thing to do with it is nothing.
 */
export function readPush(provider: GitProvider, payload: unknown): PushEvent[] {
  if (typeof payload !== 'object' || payload === null) return [];
  return provider === 'gitlab' ? gitlabPush(payload) : bitbucketPush(payload);
}

function gitlabPush(payload: object): PushEvent[] {
  const body = payload as {
    ref?: unknown;
    after?: unknown;
    total_commits_count?: unknown;
    project?: { path_with_namespace?: unknown };
    commits?: unknown;
  };
  const ref = str(body.ref);
  const commit = str(body.after);
  const repo = str(body.project?.path_with_namespace);
  if (!ref?.startsWith('refs/heads/') || !commit || !repo || DELETED.test(commit)) return [];
  const commits = Array.isArray(body.commits) ? body.commits : [];
  const total = typeof body.total_commits_count === 'number' ? body.total_commits_count : 0;
  // GitLab lists at most twenty commits; past that the file list is a
  // sample, and a sample must not be allowed to filter anything out.
  const changed =
    commits.length >= total
      ? commits.flatMap((c) => {
          const one = c as { added?: unknown; modified?: unknown; removed?: unknown };
          return [...strings(one.added), ...strings(one.modified), ...strings(one.removed)];
        })
      : null;
  return [{ repo, branch: ref.slice('refs/heads/'.length), commit, changed }];
}

function bitbucketPush(payload: object): PushEvent[] {
  const body = payload as { repository?: { full_name?: unknown }; push?: { changes?: unknown } };
  const repo = str(body.repository?.full_name);
  if (!repo || !Array.isArray(body.push?.changes)) return [];
  const out: PushEvent[] = [];
  for (const change of body.push.changes) {
    const next = (
      change as { new?: { type?: unknown; name?: unknown; target?: { hash?: unknown } } }
    ).new;
    if (str(next?.type) !== 'branch') continue;
    const branch = str(next?.name);
    const commit = str(next?.target?.hash);
    // Bitbucket sends no file list with a push, so a monorepo path filter
    // has nothing to read and everything matching the branch deploys.
    if (branch && commit) out.push({ repo, branch, commit, changed: null });
  }
  return out;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
