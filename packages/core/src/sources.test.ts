import { VDeployError } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import {
  apiBase,
  archiveUrl,
  authHeaders,
  canSelfHost,
  cannotRead,
  checkRepo,
  checkToken,
  DEFAULT_HOST,
  gitWebhookSecret,
  headUrl,
  isPullRequestEvent,
  isPushEvent,
  readHead,
  readPullRequest,
  readPush,
  type GitConnection,
} from './sources.js';

const gitlab: GitConnection = { provider: 'gitlab', host: 'https://gitlab.com' };
const own: GitConnection = { provider: 'gitlab', host: 'https://git.example.com' };
const bitbucket: GitConnection = { provider: 'bitbucket', host: 'https://bitbucket.org' };

describe('repository paths', () => {
  it('may nest, as GitLab subgroups do', () => {
    expect(checkRepo('acme/app')).toBe('acme/app');
    expect(checkRepo('acme/team/app')).toBe('acme/team/app');
  });

  it('reject anything that could change which URL is fetched', () => {
    for (const bad of [
      'acme',
      '/acme/app',
      'acme/app/',
      'https://evil.test/acme/app',
      'acme/../../etc/passwd',
      'acme/app?x=1',
      'acme/app#frag',
      'acme/app name',
      '..',
    ]) {
      expect(() => checkRepo(bad), bad).toThrow(VDeployError);
    }
  });
});

describe('where each provider answers', () => {
  it('keeps GitLab on the host you connected, and the others not', () => {
    expect(apiBase(gitlab)).toBe('https://gitlab.com/api/v4');
    expect(apiBase(own)).toBe('https://git.example.com/api/v4');
    // The reason this function exists: downloads and the API are two hosts.
    expect(apiBase(bitbucket)).toBe('https://api.bitbucket.org/2.0');
    expect(apiBase({ provider: 'github', host: DEFAULT_HOST.github })).toBe(
      'https://api.github.com',
    );
  });

  it('lets only GitLab be somewhere else', () => {
    expect(canSelfHost('gitlab')).toBe(true);
    expect(canSelfHost('bitbucket')).toBe(false);
    expect(canSelfHost('github')).toBe(false);
  });

  it('puts a whole GitLab project in one encoded segment', () => {
    expect(archiveUrl(own, 'acme/team/app', 'feature/one')).toBe(
      'https://git.example.com/api/v4/projects/acme%2Fteam%2Fapp/repository/archive.tar.gz?sha=feature%2Fone',
    );
    expect(headUrl(own, 'acme/team/app', 'feature/one')).toBe(
      'https://git.example.com/api/v4/projects/acme%2Fteam%2Fapp/repository/branches/feature%2Fone',
    );
  });

  it('downloads Bitbucket from its web host and asks its API host', () => {
    expect(archiveUrl(bitbucket, 'acme/app', 'abc123')).toBe(
      'https://bitbucket.org/acme/app/get/abc123.tar.gz',
    );
    expect(headUrl(bitbucket, 'acme/app', 'main')).toBe(
      'https://api.bitbucket.org/2.0/repositories/acme/app/refs/branches/main',
    );
  });

  it('treats a host with a trailing slash as the same host', () => {
    expect(
      archiveUrl({ provider: 'gitlab', host: 'https://git.example.com/' }, 'a/b', 'main'),
    ).toBe('https://git.example.com/api/v4/projects/a%2Fb/repository/archive.tar.gz?sha=main');
  });

  it('proves who is asking the way each provider wants', () => {
    expect(authHeaders({ ...gitlab, token: 't' })).toEqual({ 'private-token': 't' });
    expect(authHeaders({ ...bitbucket, token: 't' })).toEqual({ authorization: 'Bearer t' });
    expect(authHeaders(gitlab)).toEqual({});
  });

  it('finds the commit wherever that provider hid it', () => {
    expect(readHead('gitlab', { commit: { id: 'aaa' } })).toBe('aaa');
    expect(readHead('bitbucket', { target: { hash: 'bbb' } })).toBe('bbb');
    expect(readHead('github', { sha: 'ccc' })).toBe('ccc');
    expect(readHead('gitlab', { commit: {} })).toBeNull();
    expect(readHead('gitlab', 'not an object')).toBeNull();
    expect(readHead('gitlab', null)).toBeNull();
  });
});

describe('when a repository cannot be read', () => {
  it('says what to go and do, which differs with a token and without', () => {
    const without = cannotRead(gitlab, 'acme/app', 'main', 404);
    expect(without.code).toBe('not_found');
    expect(without.message).toMatch(/read-only access token/);
    const withToken = cannotRead({ ...gitlab, token: 'glpat-secret' }, 'acme/app', 'main', 403);
    expect(withToken.code).toBe('forbidden');
    expect(withToken.message).toMatch(/may have expired/);
    expect(cannotRead(gitlab, 'acme/app', 'main', 503).code).toBe('unavailable');
    // The token itself never appears in the sentence.
    expect(withToken.message).not.toContain('glpat-secret');
  });
});

describe('webhook secrets', () => {
  it('belong to one connection and do not drift', () => {
    const key = Buffer.alloc(32, 7);
    const secret = gitWebhookSecret(key, 'gitc_one');
    expect(gitWebhookSecret(key, 'gitc_one')).toBe(secret);
    expect(gitWebhookSecret(key, 'gitc_two')).not.toBe(secret);
    expect(gitWebhookSecret(Buffer.alloc(32, 8), 'gitc_one')).not.toBe(secret);
    expect(secret).toHaveLength(64);
  });
});

describe('reading a push', () => {
  it('counts only the push header as a push', () => {
    expect(isPushEvent('gitlab', 'Push Hook')).toBe(true);
    expect(isPushEvent('gitlab', 'Tag Push Hook')).toBe(false);
    expect(isPushEvent('bitbucket', 'repo:push')).toBe(true);
    expect(isPushEvent('bitbucket', 'pullrequest:created')).toBe(false);
    expect(isPushEvent('gitlab', undefined)).toBe(false);
  });

  it('takes the branch, the commit and the files from GitLab', () => {
    expect(
      readPush('gitlab', {
        ref: 'refs/heads/main',
        after: 'abc1234',
        total_commits_count: 1,
        project: { path_with_namespace: 'acme/team/app' },
        commits: [{ added: ['a.txt'], modified: ['b.txt'], removed: [] }],
      }),
    ).toEqual([
      { repo: 'acme/team/app', branch: 'main', commit: 'abc1234', changed: ['a.txt', 'b.txt'] },
    ]);
  });

  it('lets a truncated commit list filter nothing out', () => {
    const [push] = readPush('gitlab', {
      ref: 'refs/heads/main',
      after: 'abc1234',
      total_commits_count: 40,
      project: { path_with_namespace: 'acme/app' },
      commits: [{ added: ['a.txt'] }],
    });
    expect(push?.changed).toBeNull();
  });

  it('is not fooled by a deleted branch, a tag, or a shape nobody documents', () => {
    const project = { path_with_namespace: 'acme/app' };
    expect(
      readPush('gitlab', { ref: 'refs/heads/gone', after: '0000000', project, commits: [] }),
    ).toEqual([]);
    expect(readPush('gitlab', { ref: 'refs/tags/v1', after: 'abc', project, commits: [] })).toEqual(
      [],
    );
    expect(readPush('gitlab', { ref: 'refs/heads/main', project })).toEqual([]);
    expect(readPush('gitlab', null)).toEqual([]);
    expect(readPush('gitlab', 'nope')).toEqual([]);
  });

  it('takes every branch Bitbucket moved, and no file list', () => {
    expect(
      readPush('bitbucket', {
        repository: { full_name: 'acme/app' },
        push: {
          changes: [
            { new: { type: 'branch', name: 'main', target: { hash: 'aaa' } } },
            { new: { type: 'tag', name: 'v1', target: { hash: 'bbb' } } },
            { new: null },
            { new: { type: 'branch', name: 'next', target: { hash: 'ccc' } } },
          ],
        },
      }),
    ).toEqual([
      { repo: 'acme/app', branch: 'main', commit: 'aaa', changed: null },
      { repo: 'acme/app', branch: 'next', commit: 'ccc', changed: null },
    ]);
  });
});

describe('checking a token before it is stored', () => {
  const answer = (status: number, asked: string[] = []) =>
    ((url: string, init: RequestInit) => {
      asked.push(url);
      expect((init.headers as Record<string, string>)['private-token']).toBe('glpat-x');
      return Promise.resolve(new Response('', { status }));
    }) as unknown as typeof fetch;

  it('asks the host you connected, not the public one', async () => {
    const asked: string[] = [];
    await checkToken({ ...own, token: 'glpat-x' }, answer(200, asked));
    expect(asked).toEqual(['https://git.example.com/api/v4/user']);
  });

  it('accepts a token too narrow to see the account endpoint', async () => {
    // That token is the one people should be pasting; refusing it would
    // push everybody towards a wider one.
    await expect(checkToken({ ...own, token: 'glpat-x' }, answer(403))).resolves.toBeUndefined();
  });

  const refusal = async (promise: Promise<void>): Promise<VDeployError> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof VDeployError) return error;
      throw error;
    }
    throw new Error('it was accepted');
  };

  it('calls only a flat refusal wrong', async () => {
    const refused = await refusal(checkToken({ ...own, token: 'glpat-x' }, answer(401)));
    expect(refused.code).toBe('invalid_input');
    expect(refused.message).toMatch(/git\.example\.com refused/);
    expect((await refusal(checkToken({ ...own, token: 'glpat-x' }, answer(502)))).code).toBe(
      'unavailable',
    );
  });

  it('blames the network when the host cannot be reached at all', async () => {
    const dead = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const unreachable = await refusal(checkToken({ ...own, token: 't' }, dead));
    expect(unreachable.code).toBe('unavailable');
    expect(unreachable.message).toMatch(/could not be reached/);
  });
});

describe('reading a pull request', () => {
  it('counts only the headers that mean one', () => {
    expect(isPullRequestEvent('gitlab', 'Merge Request Hook')).toBe(true);
    expect(isPullRequestEvent('gitlab', 'Push Hook')).toBe(false);
    expect(isPullRequestEvent('bitbucket', 'pullrequest:created')).toBe(true);
    expect(isPullRequestEvent('bitbucket', 'repo:push')).toBe(false);
    expect(isPullRequestEvent('gitlab', undefined)).toBe(false);
  });

  const merge = (over: Record<string, unknown> = {}) => ({
    object_attributes: {
      iid: 7,
      title: 'Fix the thing',
      url: 'https://gitlab.com/acme/shop/-/merge_requests/7',
      action: 'open',
      source_branch: 'fix-the-thing',
      target_branch: 'main',
      last_commit: { id: 'abc1234' },
      source: { path_with_namespace: 'acme/shop' },
      target: { path_with_namespace: 'acme/shop' },
      ...over,
    },
  });

  it('takes what GitLab calls a merge request', () => {
    expect(readPullRequest('gitlab', 'Merge Request Hook', merge())).toEqual({
      repo: 'acme/shop',
      number: 7,
      branch: 'fix-the-thing',
      base: 'main',
      commit: 'abc1234',
      title: 'Fix the thing',
      url: 'https://gitlab.com/acme/shop/-/merge_requests/7',
      fromFork: false,
      state: 'open',
    });
  });

  it('knows a GitLab branch on another repository is a fork', () => {
    const forked = merge({ source: { path_with_namespace: 'someone/shop' } });
    expect(readPullRequest('gitlab', 'Merge Request Hook', forked)?.fromFork).toBe(true);
  });

  it('closes on both the ways GitLab ends one', () => {
    for (const action of ['close', 'merge']) {
      expect(readPullRequest('gitlab', 'Merge Request Hook', merge({ action }))?.state).toBe(
        'closed',
      );
    }
  });

  it('ignores a label changing, which did not happen to the code', () => {
    expect(
      readPullRequest('gitlab', 'Merge Request Hook', merge({ action: 'approved' })),
    ).toBeNull();
    expect(readPullRequest('gitlab', 'Merge Request Hook', { object_attributes: {} })).toBeNull();
    expect(readPullRequest('gitlab', 'Merge Request Hook', null)).toBeNull();
  });

  const bitbucket = (over: Record<string, unknown> = {}) => ({
    pullrequest: {
      id: 9,
      title: 'Fix the thing',
      links: { html: { href: 'https://bitbucket.org/acme/shop/pull-requests/9' } },
      source: {
        branch: { name: 'fix-the-thing' },
        commit: { hash: 'def5678' },
        repository: { full_name: 'acme/shop' },
      },
      destination: { branch: { name: 'main' }, repository: { full_name: 'acme/shop' } },
      ...over,
    },
  });

  it('takes Bitbucket, whose header is the only thing that says what happened', () => {
    expect(readPullRequest('bitbucket', 'pullrequest:created', bitbucket())).toEqual({
      repo: 'acme/shop',
      number: 9,
      branch: 'fix-the-thing',
      base: 'main',
      commit: 'def5678',
      title: 'Fix the thing',
      url: 'https://bitbucket.org/acme/shop/pull-requests/9',
      fromFork: false,
      state: 'open',
    });
    for (const event of ['pullrequest:fulfilled', 'pullrequest:rejected']) {
      expect(readPullRequest('bitbucket', event, bitbucket())?.state).toBe('closed');
    }
    expect(readPullRequest('bitbucket', 'pullrequest:comment_created', bitbucket())).toBeNull();
    expect(readPullRequest('bitbucket', undefined, bitbucket())).toBeNull();
  });

  it('knows a Bitbucket branch on another repository is a fork', () => {
    const forked = bitbucket({
      source: {
        branch: { name: 'fix' },
        commit: { hash: 'aaa' },
        repository: { full_name: 'someone/shop' },
      },
    });
    expect(readPullRequest('bitbucket', 'pullrequest:created', forked)?.fromFork).toBe(true);
  });
});
