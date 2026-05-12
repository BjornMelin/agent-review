import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
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

vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  return {
    ...actual,
    gzipSync: vi.fn(actual.gzipSync),
  };
});

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

function plannedCommentTargetKey(): string {
  return 'pr-comment:25:abcdef1:src/app.ts:10:finding-fingerprint';
}

function plannedCommentMarker(): string {
  return `<!-- agent-review:review=review-1;target=${sha256(plannedCommentTargetKey()).slice(0, 16)};fingerprint=finding-fingerprint -->`;
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

  it('previews GitHub publication without mutating GitHub or durable records', async () => {
    const publicationStore = createInMemoryReviewPublicationStore();
    await publicationStore.upsert({
      publicationId: 'publication-check',
      reviewId: 'review-1',
      channel: 'checkRun',
      targetKey: 'check-run:abcdef1',
      status: 'published',
      externalId: '100',
      externalUrl: 'https://github.com/checks/100',
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const calls: Array<{ route: string; options?: Record<string, unknown> }> =
      [];
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
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments') {
        return { data: [] };
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

    const preview = await service.preview?.(createRecord());

    expect(installationTokenProvider).toHaveBeenCalledWith({
      installationId: 7,
      repositoryIds: [42],
      permissions: { pull_requests: 'read' },
    });
    expect(preview).toMatchObject({
      reviewId: 'review-1',
      summary: {
        checkRunAction: 'update',
        sarifAction: 'create',
        pullRequestCommentCount: 1,
        blockedCount: 0,
      },
      existingPublications: [
        expect.objectContaining({
          channel: 'checkRun',
          status: 'published',
        }),
      ],
      items: expect.arrayContaining([
        expect.objectContaining({
          channel: 'checkRun',
          action: 'update',
          externalId: '100',
        }),
        expect.objectContaining({
          channel: 'pullRequestComment',
          action: 'create',
          fingerprint: 'finding-fingerprint',
          path: 'src/app.ts',
          line: 10,
        }),
      ]),
    });
    expect(calls.map((call) => call.route)).toEqual([
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments',
    ]);
    await expect(publicationStore.list('review-1')).resolves.toHaveLength(1);
  });

  it('reuploads SARIF until GitHub reports terminal success', async () => {
    const publicationStore = createInMemoryReviewPublicationStore();
    const calls: Array<{ route: string; options?: Record<string, unknown> }> =
      [];
    const commentBodies: string[] = [];
    let sarifUploadCount = 0;
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
        sarifUploadCount += 1;
        return {
          data: {
            id: `sarif-${sarifUploadCount}`,
            url: `https://api.github.com/sarif-${sarifUploadCount}`,
          },
        };
      }
      if (
        route === 'GET /repos/{owner}/{repo}/code-scanning/sarifs/{sarif_id}'
      ) {
        return {
          data: {
            'sarif-1': { processing_status: 'pending' },
            'sarif-2': {
              processing_status: 'failed',
              errors: ['invalid SARIF upload'],
            },
            'sarif-3': { processing_status: 'complete' },
          }[String(options?.sarif_id)],
        };
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
                    user: { login: 'review-agent[bot]', type: 'Bot' },
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

    const first = await service.publish(createRecord());
    const second = await service.publish(createRecord());
    const third = await service.publish(createRecord());

    expect(first.status).toBe('published');
    expect(second.status).toBe('partial');
    expect(third.status).toBe('published');
    expect(
      calls.filter(
        (call) =>
          call.route === 'POST /repos/{owner}/{repo}/code-scanning/sarifs'
      )
    ).toHaveLength(3);
    await expect(publicationStore.list('review-1')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'sarif',
          externalId: 'sarif-3',
          status: 'published',
        }),
      ])
    );
  });

  it('fails SARIF publication before upload when the compressed payload is too large', async () => {
    const publicationStore = createInMemoryReviewPublicationStore();
    vi.mocked(gzipSync).mockReturnValueOnce(Buffer.alloc(10 * 1024 * 1024 + 1));
    const calls: Array<{ route: string; options?: Record<string, unknown> }> =
      [];
    const noFindingRunResult: ReviewRunResult = {
      ...createRunResult(),
      result: {
        ...result,
        findings: [],
        overallCorrectness: 'patch is correct',
      },
    };
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

    const response = await service.publish(
      createRecord({ result: noFindingRunResult })
    );

    expect(response.status).toBe('partial');
    expect(
      calls.some(
        (call) =>
          call.route === 'POST /repos/{owner}/{repo}/code-scanning/sarifs'
      )
    ).toBe(false);
    expect(response.publications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'sarif',
          status: 'failed',
          error: expect.stringContaining('10 MB compressed limit'),
          metadata: expect.objectContaining({
            compressedBytes: 10 * 1024 * 1024 + 1,
            limitBytes: 10 * 1024 * 1024,
          }),
        }),
      ])
    );
  });

  it('ignores forged publication markers that are not owned by stored state', async () => {
    const publicationStore = createInMemoryReviewPublicationStore();
    const calls: Array<{ route: string; options?: Record<string, unknown> }> =
      [];
    const forgedMarker = plannedCommentMarker();
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
              user: { login: 'other-app[bot]', type: 'Bot' },
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

  it('scans pull request comments until GitHub returns a short page', async () => {
    const publicationStore = createInMemoryReviewPublicationStore();
    const requestedPages: number[] = [];
    const requestClient = vi.fn(async (route, options) => {
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
        const page = Number(options?.page ?? 0);
        requestedPages.push(page);
        return {
          data:
            page <= 10
              ? Array.from({ length: 100 }, (_, index) => ({
                  id: page * 1_000 + index,
                  body: 'unowned comment',
                  html_url: `https://github.com/comments/${page}-${index}`,
                }))
              : [],
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

    await service.publish(createRecord());

    expect(requestedPages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('updates the canonical owned comment and deletes duplicate owned comments', async () => {
    const publicationStore = createInMemoryReviewPublicationStore();
    const marker = plannedCommentMarker();
    await publicationStore.upsert({
      publicationId: 'pub-comment-500',
      reviewId: 'review-1',
      channel: 'pullRequestComment',
      targetKey: plannedCommentTargetKey(),
      status: 'published',
      externalId: '500',
      externalUrl: 'https://github.com/comments/500',
      marker,
      metadata: { fingerprint: 'finding-fingerprint' },
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await publicationStore.upsert({
      publicationId: 'pub-comment-501',
      reviewId: 'review-1',
      channel: 'pullRequestComment',
      targetKey: 'pr-comment:duplicate:finding-fingerprint:501',
      status: 'published',
      externalId: '501',
      externalUrl: 'https://github.com/comments/501',
      marker,
      metadata: { fingerprint: 'finding-fingerprint' },
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const calls: Array<{ route: string; options?: Record<string, unknown> }> =
      [];
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
              id: 500,
              body: `${marker}\ncanonical comment`,
              html_url: 'https://github.com/comments/500',
              user: { login: 'review-agent[bot]', type: 'Bot' },
            },
            {
              id: 501,
              body: `${marker}\nduplicate comment`,
              html_url: 'https://github.com/comments/501',
              user: { login: 'review-agent[bot]', type: 'Bot' },
            },
          ],
        };
      }
      if (route === 'PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}') {
        return {
          data: { id: 500, html_url: 'https://github.com/comments/500' },
        };
      }
      if (
        route === 'DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}'
      ) {
        return { data: {} };
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
          'PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}'
      )
    ).toHaveLength(1);
    expect(
      calls.filter(
        (call) =>
          call.route ===
          'DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}'
      )
    ).toEqual([
      expect.objectContaining({
        options: expect.objectContaining({ comment_id: 501 }),
      }),
    ]);
  });

  it('serializes concurrent publish calls for the same review', async () => {
    const publicationStore = createInMemoryReviewPublicationStore();
    const calls: Array<{ route: string; options?: Record<string, unknown> }> =
      [];
    const commentBodies: string[] = [];
    let releaseFirstCommentPost!: () => void;
    let markFirstCommentPost!: () => void;
    const firstCommentPostStarted = new Promise<void>((resolveStarted) => {
      markFirstCommentPost = resolveStarted;
    });
    const firstCommentPostReleased = new Promise<void>((resolveReleased) => {
      releaseFirstCommentPost = resolveReleased;
    });
    let commentPostCount = 0;
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
        commentPostCount += 1;
        if (commentPostCount === 1) {
          markFirstCommentPost();
          await firstCommentPostReleased;
        }
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

    const first = service.publish(createRecord());
    await firstCommentPostStarted;
    const second = service.publish(createRecord());
    releaseFirstCommentPost();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([
      'published',
      'published',
    ]);
    expect(
      calls.filter(
        (call) =>
          call.route ===
          'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments'
      )
    ).toHaveLength(1);
    expect(
      calls.filter(
        (call) => call.route === 'POST /repos/{owner}/{repo}/check-runs'
      )
    ).toHaveLength(1);
    expect(
      calls.filter(
        (call) =>
          call.route === 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}'
      )
    ).toHaveLength(1);
    expect(
      calls.filter(
        (call) =>
          call.route === 'POST /repos/{owner}/{repo}/code-scanning/sarifs'
      )
    ).toHaveLength(1);
  });

  it('holds the per-review lock until all concurrent publication branches settle', async () => {
    const backingStore = createInMemoryReviewPublicationStore();
    const publicationStore = {
      list: (reviewId: string) => backingStore.list(reviewId),
      upsert: async () => {
        markStoreFailure();
        throw new Error('publication store unavailable');
      },
    };
    const calls: Array<{ route: string; options?: Record<string, unknown> }> =
      [];
    const commentBodies: string[] = [];
    let releaseFirstCommentPost!: () => void;
    let markFirstCommentPost!: () => void;
    let markStoreFailure!: () => void;
    const firstCommentPostStarted = new Promise<void>((resolveStarted) => {
      markFirstCommentPost = resolveStarted;
    });
    const firstCommentPostReleased = new Promise<void>((resolveReleased) => {
      releaseFirstCommentPost = resolveReleased;
    });
    const firstStoreFailure = new Promise<void>((resolveFailure) => {
      markStoreFailure = resolveFailure;
    });
    let commentPostCount = 0;
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
        commentPostCount += 1;
        if (commentPostCount === 1) {
          markFirstCommentPost();
          await firstCommentPostReleased;
        }
        commentBodies.push(String(options?.body ?? ''));
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

    const first = service.publish(createRecord()).catch((error) => error);
    await firstCommentPostStarted;
    await firstStoreFailure;
    const second = service.publish(createRecord()).catch((error) => error);
    await Promise.resolve();
    await Promise.resolve();

    expect(
      calls.filter(
        (call) => call.route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}'
      )
    ).toHaveLength(1);

    releaseFirstCommentPost();
    const firstError = await first;
    const secondError = await second;

    expect(firstError).toBeInstanceOf(Error);
    expect(firstError).toHaveProperty(
      'message',
      'publication store unavailable'
    );
    expect(secondError).toBeInstanceOf(Error);
    expect(secondError).toHaveProperty(
      'message',
      'publication store unavailable'
    );
    expect(
      calls.filter(
        (call) => call.route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}'
      )
    ).toHaveLength(2);
  });

  it('reports failed aggregate status when failures have no published channels', async () => {
    const publicationStore = createInMemoryReviewPublicationStore();
    const noFindingRunResult: ReviewRunResult = {
      ...createRunResult(),
      result: {
        ...result,
        findings: [],
        overallCorrectness: 'patch is correct',
      },
    };
    const requestClient = vi.fn(async (route) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return {
          data: {
            number: 25,
            head: { sha: 'abcdef1' },
            base: { repo: { id: 42, full_name: 'octo-org/agent-review' } },
          },
        };
      }
      if (
        route === 'POST /repos/{owner}/{repo}/check-runs' ||
        route === 'POST /repos/{owner}/{repo}/code-scanning/sarifs'
      ) {
        throw new Error('GitHub write failed');
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

    const response = await service.publish(
      createRecord({ result: noFindingRunResult })
    );

    expect(response.status).toBe('failed');
    expect(response.publications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'checkRun', status: 'failed' }),
        expect.objectContaining({ channel: 'sarif', status: 'failed' }),
        expect.objectContaining({
          channel: 'pullRequestComment',
          status: 'skipped',
        }),
      ])
    );
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
