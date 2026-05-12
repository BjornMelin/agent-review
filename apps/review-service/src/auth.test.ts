import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitHubUserTokenAuthorizer } from './auth.js';

describe('createGitHubUserTokenAuthorizer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a fresh timeout signal with each GitHub API request', async () => {
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
    expect(new Set(signals).size).toBe(3);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });

  it('rejects non-positive GitHub request timeout budgets', () => {
    expect(() =>
      createGitHubUserTokenAuthorizer({ requestTimeoutMs: 0 })
    ).toThrow(/requestTimeoutMs/);
  });
});
