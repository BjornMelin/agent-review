import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { ReviewRunResult } from '@review-agent/review-core';
import type {
  ReviewRepositoryAuthorization,
  ReviewRequest,
  ReviewResult,
  ReviewRunAuthorization,
} from '@review-agent/review-types';
import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubPublicationService,
  type GitHubRequestClient,
} from './github-publication.js';
import {
  createInMemoryReviewPublicationStore,
  type ReviewRecord,
} from './storage/index.js';

const request: ReviewRequest = {
  cwd: '/repo',
  target: { type: 'baseBranch', branch: 'main' },
  provider: 'codexDelegate',
  executionMode: 'localTrusted',
  outputFormats: ['json', 'markdown', 'sarif'],
};

const repository: ReviewRepositoryAuthorization = {
  provider: 'github',
  repositoryId: 42,
  installationId: 7,
  owner: 'octo-org',
  name: 'agent-review',
  fullName: 'octo-org/agent-review',
  visibility: 'private',
  permissions: {
    metadata: 'read',
    contents: 'read',
    pullRequests: 'write',
  },
  pullRequestNumber: 25,
};

const authorization: ReviewRunAuthorization = {
  principal: {
    type: 'serviceToken',
    tokenId: 'token-1',
    tokenPrefix: 'rat_token-1',
    name: 'CI',
  },
  repository,
  scopes: ['review:start', 'review:read', 'review:publish'],
  actor: 'service-token:token-1',
  requestHash: 'sha256:request',
  authorizedAt: 1_000,
};

const result: ReviewResult = {
  findings: [
    {
      title: '[P1] Unsafe publish',
      body: 'Do not mention @octocat or &#64;org/team, render <!-- raw --> <script>alert(1)</script> or &#x3C;img&#x3E;, or leak OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456.',
      priority: 1,
      confidenceScore: 0.92,
      codeLocation: {
        absoluteFilePath: '/repo/src/app.ts',
        lineRange: { start: 10, end: 10 },
      },
      fingerprint: 'finding-fingerprint',
    },
  ],
  overallCorrectness: 'patch is incorrect',
  overallExplanation: 'One issue found.',
  overallConfidenceScore: 0.9,
  metadata: {
    provider: 'codexDelegate',
    modelResolved: 'test-model',
    executionMode: 'localTrusted',
    promptPack: 'test-pack',
    gitContext: {
      mode: 'baseBranch',
      baseRef: 'main',
      commitSha: 'abcdef1',
    },
  },
};

function createRunResult(): ReviewRunResult {
  return {
    reviewId: 'review-1',
    request,
    result,
    artifacts: {
      json: JSON.stringify(result),
      markdown: '# Review',
      sarif: '{}',
    },
    diff: {
      patch: 'diff --git a/src/app.ts b/src/app.ts',
      chunks: [
        {
          file: 'src/app.ts',
          absoluteFilePath: '/repo/src/app.ts',
          patch: '@@ -10 +10 @@',
          changedLines: [10],
        },
      ],
      changedLineIndex: new Map([['/repo/src/app.ts', new Set([10])]]),
      gitContext: {
        mode: 'baseBranch',
        baseRef: 'main',
        commitSha: 'abcdef1',
      },
    },
    prompt: 'prompt',
    rubric: 'rubric',
  };
}

function createRecord(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    reviewId: 'review-1',
    status: 'completed',
    request,
    authorization,
    result: createRunResult(),
    createdAt: 1_000,
    updatedAt: 1_000,
    events: [],
    ...overrides,
  };
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

describe('createGitHubPublicationService', () => {
  it('publishes check, SARIF, and pull request comments idempotently', async () => {
    const publicationStore = createInMemoryReviewPublicationStore();
    const calls: Array<{ route: string; options?: Record<string, unknown> }> =
      [];
    const commentBodies: string[] = [];
    const requestClient = vi.fn(async (route, options) => {
      calls.push({ route, options });
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return {
          data: {
            number: 25,
            head: { sha: 'abcdef1' },
            base: { repo: { id: 42, full_name: 'octo-org/agent-review' } },
          },
        };
      }
      if (route === 'POST /repos/{owner}/{repo}/check-runs') {
        return { data: { id: 100, html_url: 'https://github.com/checks/100' } };
      }
      if (route === 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}') {
        return { data: { id: 100, html_url: 'https://github.com/checks/100' } };
      }
      if (route === 'POST /repos/{owner}/{repo}/code-scanning/sarifs') {
        return {
          data: { id: 'sarif-1', url: 'https://api.github.com/sarif-1' },
        };
      }
      if (
        route === 'GET /repos/{owner}/{repo}/code-scanning/sarifs/{sarif_id}'
      ) {
        return { data: { processing_status: 'complete' } };
      }
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments') {
        return {
          data:
            commentBodies.length === 0
              ? []
              : [
                  {
                    id: 500,
                    body: commentBodies.at(-1),
                    html_url: 'https://github.com/comments/500',
                  },
                ],
        };
      }
      if (route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments') {
        commentBodies.push(String(options?.body ?? ''));
        return {
          data: { id: 500, html_url: 'https://github.com/comments/500' },
        };
      }
      if (route === 'PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}') {
        commentBodies.push(String(options?.body ?? ''));
        return {
          data: { id: 500, html_url: 'https://github.com/comments/500' },
        };
      }
      throw new Error(`unexpected route ${route}`);
    }) as unknown as GitHubRequestClient;
    const installationTokenProvider = vi.fn(async () => ({
      token: 'install-token',
      expiresAt: 2_000,
      permissions: {},
    }));
    const service = createGitHubPublicationService({
      installationTokenProvider,
      publicationStore,
      requestFactory: () => requestClient,
      nowMs: () => 1_500,
    });

    const first = await service.publish(createRecord());
    const second = await service.publish(createRecord());

    expect(first.status).toBe('published');
    expect(second.status).toBe('published');
    expect(installationTokenProvider).toHaveBeenCalledWith({
      installationId: 7,
      repositoryIds: [42],
      permissions: {
        checks: 'write',
        pull_requests: 'write',
        security_events: 'write',
      },
    });
    expect(
      calls.filter(
        (call) =>
          call.route ===
          'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments'
      )
    ).toHaveLength(1);
    expect(
      calls.filter(
        (call) =>
          call.route ===
          'PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}'
      )
    ).toHaveLength(1);
    expect(
      calls.some(
        (call) =>
          call.route === 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}'
      )
    ).toBe(true);
    expect(commentBodies.at(-1)).toContain(
      '<!-- agent-review:review=review-1;'
    );
    expect(commentBodies.at(-1)).not.toContain('@octocat');
    expect(commentBodies.at(-1)).not.toContain('&#64;org/team');
    expect(commentBodies.at(-1)).not.toContain('&#x3C;img');
    expect(commentBodies.at(-1)).not.toContain('<script>');
    expect(commentBodies.at(-1)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    const sarifCall = calls.find(
      (call) => call.route === 'POST /repos/{owner}/{repo}/code-scanning/sarifs'
    );
    const sarif = JSON.parse(
      gunzipSync(
        Buffer.from(String(sarifCall?.options?.sarif ?? ''), 'base64')
      ).toString('utf8')
    ) as {
      runs: Array<{
        results: Array<{
          locations: Array<{
            physicalLocation: { artifactLocation: { uri: string } };
          }>;
        }>;
      }>;
    };
    expect(
      sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation
        .uri
    ).toBe('src/app.ts');
    expect(JSON.stringify(sarif)).not.toContain('/repo/');
    await expect(publicationStore.list('review-1')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'checkRun', status: 'published' }),
        expect.objectContaining({ channel: 'sarif', status: 'published' }),
        expect.objectContaining({
          channel: 'pullRequestComment',
          status: 'published',
        }),
      ])
    );
  });

  it('ignores forged publication markers that are not owned by stored state', async () => {
    const publicationStore = createInMemoryReviewPublicationStore();
    const calls: Array<{ route: string; options?: Record<string, unknown> }> =
      [];
    const targetKey = 'pr-comment:25:abcdef1:src/app.ts:10:finding-fingerprint';
    const forgedMarker = `<!-- agent-review:review=review-1;target=${sha256(targetKey).slice(0, 16)};fingerprint=finding-fingerprint -->`;
    const requestClient = vi.fn(async (route, options) => {
      calls.push({ route, options });
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return {
          data: {
            number: 25,
            head: { sha: 'abcdef1' },
            base: { repo: { id: 42, full_name: 'octo-org/agent-review' } },
          },
        };
      }
      if (route === 'POST /repos/{owner}/{repo}/check-runs') {
        return { data: { id: 100, html_url: 'https://github.com/checks/100' } };
      }
      if (route === 'POST /repos/{owner}/{repo}/code-scanning/sarifs') {
        return {
          data: { id: 'sarif-1', url: 'https://api.github.com/sarif-1' },
        };
      }
      if (
        route === 'GET /repos/{owner}/{repo}/code-scanning/sarifs/{sarif_id}'
      ) {
        return { data: { processing_status: 'complete' } };
      }
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments') {
        return {
          data: [
            {
              id: 777,
              body: `${forgedMarker}\nthird-party comment`,
              html_url: 'https://github.com/comments/777',
              user: { login: 'octocat', type: 'User' },
            },
          ],
        };
      }
      if (route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments') {
        return {
          data: { id: 500, html_url: 'https://github.com/comments/500' },
        };
      }
      throw new Error(`unexpected route ${route}`);
    }) as unknown as GitHubRequestClient;
    const service = createGitHubPublicationService({
      installationTokenProvider: vi.fn(async () => ({
        token: 'install-token',
        expiresAt: 2_000,
        permissions: {},
      })),
      publicationStore,
      requestFactory: () => requestClient,
      nowMs: () => 1_500,
    });

    const response = await service.publish(createRecord());

    expect(response.status).toBe('published');
    expect(
      calls.filter(
        (call) =>
          call.route ===
          'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments'
      )
    ).toHaveLength(1);
    expect(
      calls.some(
        (call) =>
          call.route ===
          'PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}'
      )
    ).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.route ===
          'DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}'
      )
    ).toBe(false);
  });

  it('rejects stale pull request heads before GitHub write side effects', async () => {
    const publicationStore = createInMemoryReviewPublicationStore();
    const calls: Array<{ route: string; options?: Record<string, unknown> }> =
      [];
    const requestClient = vi.fn(async (route, options) => {
      calls.push({ route, options });
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return {
          data: {
            number: 25,
            head: { sha: 'fedcba9' },
            base: { repo: { id: 42, full_name: 'octo-org/agent-review' } },
          },
        };
      }
      throw new Error(`unexpected route ${route}`);
    }) as unknown as GitHubRequestClient;
    const service = createGitHubPublicationService({
      installationTokenProvider: vi.fn(async () => ({
        token: 'install-token',
        expiresAt: 2_000,
        permissions: {},
      })),
      publicationStore,
      requestFactory: () => requestClient,
      nowMs: () => 1_500,
    });

    await expect(service.publish(createRecord())).rejects.toThrow(
      'review commit is stale for the current pull request head'
    );
    expect(calls.some((call) => call.route.includes('check-runs'))).toBe(false);
    expect(
      calls.some((call) => call.route.includes('code-scanning/sarifs'))
    ).toBe(false);
    expect(calls.some((call) => call.route.includes('/comments'))).toBe(false);
    await expect(publicationStore.list('review-1')).resolves.toEqual([]);
  });
});
