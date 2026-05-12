import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitHubUserTokenAuthorizer, reviewRequestHash } from './auth.js';

function requestHeader(
  init: RequestInit | undefined,
  name: string
): string | null {
  return new Headers(init?.headers).get(name);
}

describe('createGitHubUserTokenAuthorizer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shares one timeout signal across GitHub authorization API requests', async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        signals.push(init?.signal as AbortSignal);
        const url = String(input);
        if (url.endsWith('/user')) {
          return Response.json({ id: 101, login: 'octocat' });
        }
        if (url.endsWith('/user/installations?per_page=100&page=1')) {
          return Response.json({
            installations: [{ id: 7, suspended_at: null }],
          });
        }
        if (
          url.endsWith('/user/installations/7/repositories?per_page=100&page=1')
        ) {
          return Response.json({
            repositories: [
              {
                id: 42,
                name: 'agent-review',
                full_name: 'octo-org/agent-review',
                private: true,
                visibility: 'private',
                owner: { login: 'octo-org' },
                permissions: { pull: true, push: true },
              },
            ],
          });
        }
        return Response.json({ message: `unexpected ${url}` }, { status: 404 });
      }
    );
    vi.stubGlobal('fetch', fetch);
    const authorizer = createGitHubUserTokenAuthorizer({
      requestTimeoutMs: 1_000,
    });

    await expect(
      authorizer.authorizeUserToken(
        'github-user-token',
        { provider: 'github', owner: 'octo-org', name: 'agent-review' },
        'review:read'
      )
    ).resolves.toMatchObject({
      principal: { githubUserId: 101, login: 'octocat' },
      repository: { repositoryId: 42, fullName: 'octo-org/agent-review' },
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new Set(signals).size).toBe(1);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });

  it('uses GitHub API version defaults only for public API requests', async () => {
    const observedApiVersions: Array<string | null> = [];
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        observedApiVersions.push(requestHeader(init, 'x-github-api-version'));
        return Response.json({ id: 101, login: 'octocat' });
      }
    );
    vi.stubGlobal('fetch', fetch);

    await createGitHubUserTokenAuthorizer({
      requestTimeoutMs: 1_000,
    }).authenticateUserToken('github-user-token');
    await createGitHubUserTokenAuthorizer({
      baseUrl: 'https://github.example.test/api/v3',
      requestTimeoutMs: 1_000,
    }).authenticateUserToken('github-user-token');
    await createGitHubUserTokenAuthorizer({
      apiVersion: '2022-11-28',
      baseUrl: 'https://github.example.test/api/v3',
      requestTimeoutMs: 1_000,
    }).authenticateUserToken('github-user-token');

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(observedApiVersions).toEqual(['2026-03-10', null, '2022-11-28']);
  });

  it('authorizes renamed GitHub repositories by stable repository id', async () => {
    const fetch = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/user')) {
          return Response.json({ id: 101, login: 'octocat' });
        }
        if (url.endsWith('/user/installations?per_page=100&page=1')) {
          return Response.json({
            installations: [{ id: 7, suspended_at: null }],
          });
        }
        if (
          url.endsWith('/user/installations/7/repositories?per_page=100&page=1')
        ) {
          return Response.json({
            repositories: [
              {
                id: 42,
                name: 'renamed-review',
                full_name: 'new-org/renamed-review',
                private: true,
                visibility: 'private',
                owner: { login: 'new-org' },
                permissions: { pull: true, push: true },
              },
            ],
          });
        }
        return Response.json({ message: `unexpected ${url}` }, { status: 404 });
      }
    );
    vi.stubGlobal('fetch', fetch);
    const authorizer = createGitHubUserTokenAuthorizer({
      requestTimeoutMs: 1_000,
    });

    await expect(
      authorizer.authorizeUserToken(
        'github-user-token',
        {
          provider: 'github',
          owner: 'old-org',
          name: 'old-review',
          repositoryId: 42,
        },
        'review:read'
      )
    ).resolves.toMatchObject({
      repository: {
        repositoryId: 42,
        owner: 'new-org',
        name: 'renamed-review',
        fullName: 'new-org/renamed-review',
      },
    });
  });

  it('rejects non-positive GitHub request timeout budgets', () => {
    expect(() =>
      createGitHubUserTokenAuthorizer({ requestTimeoutMs: 0 })
    ).toThrow(/requestTimeoutMs/);
  });

  it('hashes semantically identical request objects with stable key order', () => {
    const first = {
      target: { instructions: 'review this fixture', type: 'custom' },
      cwd: '/repo/octo-org/agent-review',
      outputFormats: ['json'],
      provider: 'codexDelegate',
    };
    const second = {
      provider: 'codexDelegate',
      outputFormats: ['json'],
      cwd: '/repo/octo-org/agent-review',
      target: { type: 'custom', instructions: 'review this fixture' },
    };

    expect(reviewRequestHash(first)).toBe(reviewRequestHash(second));
    expect(reviewRequestHash({ refs: ['main', 'feature'] })).not.toBe(
      reviewRequestHash({ refs: ['feature', 'main'] })
    );
  });
});
