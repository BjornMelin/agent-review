import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { request as octokitRequest } from '@octokit/request';
import type { ReviewRunResult } from '@review-agent/review-core';
import {
  renderSarifJson,
  sortFindingsDeterministically,
} from '@review-agent/review-reporters';
import {
  type ReviewFinding,
  type ReviewPublicationRecord,
  type ReviewPublishResponse,
  type ReviewRepositoryAuthorization,
  redactErrorMessage,
  redactSensitiveText,
} from '@review-agent/review-types';
import type {
  GitHubInstallationToken,
  GitHubInstallationTokenRequest,
} from './auth.js';
import type {
  ReviewPublicationStoreAdapter,
  ReviewRecord,
} from './storage/index.js';

type GitHubApiResponse<TData> = {
  data: TData;
  status?: number;
};

export type GitHubRequestClient = <TData>(
  route: string,
  options?: Record<string, unknown>
) => Promise<GitHubApiResponse<TData>>;

export type GitHubRequestFactory = (token: string) => GitHubRequestClient;

export type GitHubInstallationTokenProvider = (
  input: GitHubInstallationTokenRequest
) => Promise<GitHubInstallationToken>;

export type ReviewPublicationService = {
  publish(record: ReviewRecord): Promise<ReviewPublishResponse>;
};

export class GitHubPublicationError extends Error {
  constructor(
    readonly status: 400 | 409 | 502,
    message: string
  ) {
    super(message);
    this.name = 'GitHubPublicationError';
  }
}

type GitHubPublicationServiceOptions = {
  installationTokenProvider: GitHubInstallationTokenProvider;
  publicationStore: ReviewPublicationStoreAdapter;
  requestFactory?: GitHubRequestFactory;
  baseUrl?: string;
  apiVersion?: string;
  nowMs?: () => number;
  mutationDelayMs?: number;
};

type PublicationContext = {
  record: ReviewRecord & {
    authorization: NonNullable<ReviewRecord['authorization']>;
  };
  result: ReviewRunResult;
  repository: ReviewRepositoryAuthorization;
  request: GitHubRequestClient;
  existing: Map<string, ReviewPublicationRecord>;
  target: GitHubPublishTarget;
  store: ReviewPublicationStoreAdapter;
  nowMs: () => number;
  mutationDelayMs: number;
};

type GitHubPublishTarget = {
  owner: string;
  repo: string;
  repositoryId: number;
  installationId: number;
  commitSha: string;
  ref?: string;
  pullRequestNumber?: number;
  pullRequestHeadSha?: string;
};

type GitHubPullResponse = {
  number: number;
  head: { sha: string };
  base: { repo: { id: number; full_name: string } };
};

type GitHubCheckRunResponse = {
  id: number;
  html_url?: string;
  url?: string;
};

type GitHubSarifUploadResponse = {
  id: string;
  url?: string;
};

type GitHubSarifStatusResponse = {
  processing_status?: string;
  analyses_url?: string;
  errors?: string[];
};

type GitHubReviewComment = {
  id: number;
  html_url?: string;
  body?: string;
  user?: { login?: string; type?: string };
};

type PlannedComment = {
  targetKey: string;
  targetHash: string;
  marker: string;
  body: string;
  finding: ReviewFinding;
  path: string;
  line: number;
};

const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const DEFAULT_GITHUB_API_VERSION = '2026-03-10';
const PUBLICATION_PERMISSIONS = {
  checks: 'write',
  pull_requests: 'write',
  security_events: 'write',
} as const;
const PUBLISH_MARKDOWN_LIMIT = 6_000;

function createDefaultRequestFactory(options: {
  baseUrl?: string;
  apiVersion?: string;
}): GitHubRequestFactory {
  const baseUrl = options.baseUrl ?? DEFAULT_GITHUB_API_BASE_URL;
  const request = octokitRequest.defaults({
    baseUrl,
    headers: {
      accept: 'application/vnd.github+json',
      ...((options.apiVersion ?? DEFAULT_GITHUB_API_VERSION)
        ? {
            'x-github-api-version':
              options.apiVersion ?? DEFAULT_GITHUB_API_VERSION,
          }
        : {}),
    },
  });
  return (token) =>
    request.defaults({
      headers: { authorization: `Bearer ${token}` },
    }) as GitHubRequestClient;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function publicationIdFor(
  reviewId: string,
  channel: ReviewPublicationRecord['channel'],
  targetKey: string
): string {
  return `${reviewId}:${channel}:${sha256(targetKey).slice(0, 16)}`;
}

function storeKey(
  channel: ReviewPublicationRecord['channel'],
  targetKey: string
): string {
  return `${channel}:${targetKey}`;
}

function buildExistingMap(
  records: ReviewPublicationRecord[]
): Map<string, ReviewPublicationRecord> {
  return new Map(
    records.map((record) => [
      storeKey(record.channel, record.targetKey),
      record,
    ])
  );
}

function safeMarkdown(input: string): string {
  const redacted = redactSensitiveText(input).text;
  return redacted
    .replaceAll('@', '@ ')
    .replaceAll('<!--', '&lt;!--')
    .replaceAll('-->', '--&gt;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .slice(0, PUBLISH_MARKDOWN_LIMIT);
}

function priorityLabel(finding: ReviewFinding): string {
  return `P${finding.priority ?? 3}`;
}

function summaryFor(result: ReviewRunResult): string {
  const findings = result.result.findings.length;
  const highest = sortFindingsDeterministically(result.result.findings)[0];
  const highestPriority = highest ? priorityLabel(highest) : 'P3';
  const headline =
    findings === 0
      ? 'No actionable findings.'
      : `${findings} finding${findings === 1 ? '' : 's'}; highest priority ${highestPriority}.`;
  return `${headline}\n\nOverall correctness: ${result.result.overallCorrectness}\n\n${safeMarkdown(
    result.result.overallExplanation || 'No summary returned.'
  )}`;
}

function checkConclusionFor(result: ReviewRunResult): string {
  if (result.result.overallCorrectness === 'patch is incorrect') {
    return 'failure';
  }
  if (result.result.overallCorrectness === 'unknown') {
    return 'neutral';
  }
  return result.result.findings.some((finding) => (finding.priority ?? 3) <= 1)
    ? 'failure'
    : 'success';
}

function recordFor(
  context: PublicationContext,
  input: Omit<
    ReviewPublicationRecord,
    'publicationId' | 'reviewId' | 'createdAt' | 'updatedAt'
  >
): ReviewPublicationRecord {
  const previous = context.existing.get(
    storeKey(input.channel, input.targetKey)
  );
  const now = context.nowMs();
  return {
    publicationId:
      previous?.publicationId ??
      publicationIdFor(context.record.reviewId, input.channel, input.targetKey),
    reviewId: context.record.reviewId,
    ...input,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

async function persistRecord(
  context: PublicationContext,
  input: Omit<
    ReviewPublicationRecord,
    'publicationId' | 'reviewId' | 'createdAt' | 'updatedAt'
  >
): Promise<ReviewPublicationRecord> {
  const record = recordFor(context, input);
  await context.store.upsert(record);
  context.existing.set(storeKey(record.channel, record.targetKey), record);
  return record;
}

function getErrorStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

function githubErrorMessage(error: unknown): string {
  return redactErrorMessage(error, 'GitHub publication failed');
}

function fullGitHubRef(ref: string | undefined): string | undefined {
  if (!ref) {
    return undefined;
  }
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
}

function repoKey(repository: ReviewRepositoryAuthorization): {
  owner: string;
  repo: string;
} {
  return { owner: repository.owner, repo: repository.name };
}

async function resolvePublishTarget(
  record: ReviewRecord & {
    authorization: NonNullable<ReviewRecord['authorization']>;
  },
  result: ReviewRunResult,
  request: GitHubRequestClient
): Promise<GitHubPublishTarget> {
  const repository = record.authorization.repository;
  const base = {
    ...repoKey(repository),
    repositoryId: repository.repositoryId,
    installationId: repository.installationId,
  };
  if (repository.pullRequestNumber) {
    const reviewedCommitSha =
      repository.commitSha ?? result.diff.gitContext.commitSha ?? undefined;
    if (!reviewedCommitSha) {
      throw new GitHubPublicationError(
        409,
        'review has no commit SHA target to publish'
      );
    }
    const pull = await request<GitHubPullResponse>(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      {
        ...repoKey(repository),
        pull_number: repository.pullRequestNumber,
      }
    );
    if (pull.data.base.repo.id !== repository.repositoryId) {
      throw new GitHubPublicationError(
        409,
        'pull request no longer belongs to the authorized repository'
      );
    }
    if (reviewedCommitSha.toLowerCase() !== pull.data.head.sha.toLowerCase()) {
      throw new GitHubPublicationError(
        409,
        'review commit is stale for the current pull request head'
      );
    }
    return {
      ...base,
      commitSha: pull.data.head.sha,
      ref: `refs/pull/${repository.pullRequestNumber}/head`,
      pullRequestNumber: repository.pullRequestNumber,
      pullRequestHeadSha: pull.data.head.sha,
    };
  }

  const commitSha =
    repository.commitSha ?? result.diff.gitContext.commitSha ?? undefined;
  if (!commitSha) {
    throw new GitHubPublicationError(
      409,
      'review has no commit SHA target to publish'
    );
  }
  const ref = fullGitHubRef(repository.ref);
  return {
    ...base,
    commitSha,
    ...(ref ? { ref } : {}),
  };
}

async function publishCheckRun(
  context: PublicationContext
): Promise<ReviewPublicationRecord> {
  const targetKey = `check-run:${context.target.commitSha}`;
  const previous = context.existing.get(storeKey('checkRun', targetKey));
  const body = {
    ...repoKey(context.repository),
    name: 'review-agent',
    head_sha: context.target.commitSha,
    status: 'completed',
    conclusion: checkConclusionFor(context.result),
    external_id: `${context.record.reviewId}:${context.record.authorization.requestHash}`,
    completed_at: new Date(context.nowMs()).toISOString(),
    output: {
      title: 'Review Agent',
      summary: summaryFor(context.result),
    },
  };
  try {
    const response = previous?.externalId
      ? await context.request<GitHubCheckRunResponse>(
          'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}',
          {
            ...body,
            check_run_id: Number(previous.externalId),
          }
        )
      : await context.request<GitHubCheckRunResponse>(
          'POST /repos/{owner}/{repo}/check-runs',
          body
        );
    return await persistRecord(context, {
      channel: 'checkRun',
      targetKey,
      status: 'published',
      externalId: String(response.data.id),
      externalUrl: response.data.html_url ?? response.data.url,
      message: previous?.externalId ? 'updated check run' : 'created check run',
      metadata: {
        commitSha: context.target.commitSha,
        conclusion: body.conclusion,
      },
    });
  } catch (error) {
    return persistRecord(context, {
      channel: 'checkRun',
      targetKey,
      status: 'failed',
      error: githubErrorMessage(error),
      metadata: { httpStatus: getErrorStatus(error) },
    });
  }
}

function chunkForFinding(
  result: ReviewRunResult,
  finding: ReviewFinding
): ReviewRunResult['diff']['chunks'][number] | undefined {
  const absoluteFilePath = resolve(
    result.request.cwd,
    finding.codeLocation.absoluteFilePath
  );
  return result.diff.chunks.find(
    (chunk) =>
      resolve(result.request.cwd, chunk.absoluteFilePath) ===
        absoluteFilePath ||
      resolve(result.request.cwd, chunk.file) === absoluteFilePath
  );
}

function repoPathForFinding(
  result: ReviewRunResult,
  finding: ReviewFinding
): string | undefined {
  return chunkForFinding(result, finding)?.file;
}

function safeRepoPathForFinding(
  result: ReviewRunResult,
  finding: ReviewFinding
): string {
  const chunkPath = repoPathForFinding(result, finding);
  if (chunkPath && !isAbsolute(chunkPath) && !chunkPath.startsWith('..')) {
    return chunkPath;
  }
  const absoluteFilePath = resolve(
    result.request.cwd,
    finding.codeLocation.absoluteFilePath
  );
  const relativePath = relative(
    result.request.cwd,
    absoluteFilePath
  ).replaceAll('\\', '/');
  if (
    relativePath &&
    !relativePath.startsWith('..') &&
    !isAbsolute(relativePath)
  ) {
    return relativePath;
  }
  return `unknown/${sha256(finding.fingerprint).slice(0, 16)}`;
}

async function publishSarif(
  context: PublicationContext
): Promise<ReviewPublicationRecord> {
  if (!context.target.ref) {
    return persistRecord(context, {
      channel: 'sarif',
      targetKey: `sarif:${context.target.commitSha}:missing-ref`,
      status: 'unsupported',
      message: 'SARIF upload requires a branch, tag, or pull request ref',
    });
  }

  const targetKey = `sarif:${context.target.commitSha}:${context.target.ref}`;
  const sarifJson = renderSarifJson(context.result.result, {
    automationId: `agent-review/${context.record.reviewId}`,
    pathForFinding: (finding) =>
      safeRepoPathForFinding(context.result, finding),
  });
  const encodedSarif = gzipSync(Buffer.from(sarifJson)).toString('base64');
  try {
    const uploaded = await context.request<GitHubSarifUploadResponse>(
      'POST /repos/{owner}/{repo}/code-scanning/sarifs',
      {
        ...repoKey(context.repository),
        commit_sha: context.target.commitSha,
        ref: context.target.ref,
        sarif: encodedSarif,
        tool_name: 'review-agent',
        validate: true,
      }
    );
    let status: GitHubSarifStatusResponse | undefined;
    try {
      status = (
        await context.request<GitHubSarifStatusResponse>(
          'GET /repos/{owner}/{repo}/code-scanning/sarifs/{sarif_id}',
          {
            ...repoKey(context.repository),
            sarif_id: uploaded.data.id,
          }
        )
      ).data;
    } catch {
      status = undefined;
    }
    return await persistRecord(context, {
      channel: 'sarif',
      targetKey,
      status: 'published',
      externalId: uploaded.data.id,
      externalUrl: uploaded.data.url,
      message: status?.processing_status ?? 'SARIF upload accepted',
      metadata: {
        commitSha: context.target.commitSha,
        ref: context.target.ref,
        ...(status?.analyses_url ? { analysesUrl: status.analyses_url } : {}),
        ...(status?.errors ? { errors: status.errors } : {}),
      },
    });
  } catch (error) {
    const httpStatus = getErrorStatus(error);
    return persistRecord(context, {
      channel: 'sarif',
      targetKey,
      status:
        httpStatus === 403 || httpStatus === 404 ? 'unsupported' : 'failed',
      error: githubErrorMessage(error),
      metadata: { httpStatus },
    });
  }
}

function commentLineForFinding(
  result: ReviewRunResult,
  finding: ReviewFinding
): { path: string; line: number } | undefined {
  const chunk = chunkForFinding(result, finding);
  if (!chunk) {
    return undefined;
  }
  for (
    let line = finding.codeLocation.lineRange.start;
    line <= finding.codeLocation.lineRange.end;
    line += 1
  ) {
    if (chunk.changedLines.includes(line)) {
      return { path: chunk.file, line };
    }
  }
  return undefined;
}

function markerFor(
  reviewId: string,
  targetKey: string,
  fingerprint: string
): string {
  return `<!-- agent-review:review=${reviewId};target=${sha256(targetKey).slice(
    0,
    16
  )};fingerprint=${fingerprint} -->`;
}

function parseMarker(
  body: string | undefined
): { reviewId: string; targetHash: string; fingerprint: string } | undefined {
  const match = body?.match(
    /<!--\s*agent-review:review=([^;]+);target=([^;]+);fingerprint=([^ ]+)\s*-->/
  );
  if (!match) {
    return undefined;
  }
  return {
    reviewId: match[1] ?? '',
    targetHash: match[2] ?? '',
    fingerprint: match[3] ?? '',
  };
}

function commentBody(finding: ReviewFinding, marker: string): string {
  return [
    marker,
    `### [${priorityLabel(finding)}] ${safeMarkdown(finding.title.replace(/^\[p\d\]\s*/i, ''))}`,
    '',
    safeMarkdown(finding.body),
    '',
    `Confidence: ${finding.confidenceScore.toFixed(2)}`,
  ].join('\n');
}

function planComments(context: PublicationContext): {
  comments: PlannedComment[];
  skipped: ReviewPublicationRecord[];
} {
  const comments: PlannedComment[] = [];
  const skipped: ReviewPublicationRecord[] = [];
  for (const finding of sortFindingsDeterministically(
    context.result.result.findings
  )) {
    const location = commentLineForFinding(context.result, finding);
    if (!location) {
      skipped.push(
        recordFor(context, {
          channel: 'pullRequestComment',
          targetKey: `pr-comment:skipped:${finding.fingerprint}`,
          status: 'skipped',
          marker: markerFor(
            context.record.reviewId,
            `pr-comment:skipped:${finding.fingerprint}`,
            finding.fingerprint
          ),
          message: 'finding is not anchored to a changed pull request line',
        })
      );
      continue;
    }
    const targetKey = `pr-comment:${context.target.pullRequestNumber}:${context.target.commitSha}:${location.path}:${location.line}:${finding.fingerprint}`;
    const marker = markerFor(
      context.record.reviewId,
      targetKey,
      finding.fingerprint
    );
    comments.push({
      targetKey,
      targetHash: sha256(targetKey).slice(0, 16),
      marker,
      body: commentBody(finding, marker),
      finding,
      path: location.path,
      line: location.line,
    });
  }
  return { comments, skipped };
}

async function waitBetweenMutations(
  context: PublicationContext
): Promise<void> {
  if (context.mutationDelayMs <= 0) {
    return;
  }
  await new Promise((resolveDelay) =>
    setTimeout(resolveDelay, context.mutationDelayMs)
  );
}

async function listPullRequestComments(
  context: PublicationContext
): Promise<GitHubReviewComment[]> {
  if (!context.target.pullRequestNumber) {
    return [];
  }
  const comments: GitHubReviewComment[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await context.request<GitHubReviewComment[]>(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments',
      {
        ...repoKey(context.repository),
        pull_number: context.target.pullRequestNumber,
        per_page: 100,
        page,
      }
    );
    comments.push(...response.data);
    if (response.data.length < 100) {
      break;
    }
  }
  return comments;
}

async function publishPullRequestComments(
  context: PublicationContext
): Promise<ReviewPublicationRecord[]> {
  if (!context.target.pullRequestNumber) {
    return [
      await persistRecord(context, {
        channel: 'pullRequestComment',
        targetKey: `pr-comments:missing-pr:${context.target.commitSha}`,
        status: 'skipped',
        message: 'review target is not a pull request',
      }),
    ];
  }
  if (context.result.result.findings.length === 0) {
    return [
      await persistRecord(context, {
        channel: 'pullRequestComment',
        targetKey: `pr-comments:no-findings:${context.target.commitSha}`,
        status: 'skipped',
        message: 'review has no findings to comment',
      }),
    ];
  }

  const planned = planComments(context);
  for (const skipped of planned.skipped) {
    await context.store.upsert(skipped);
  }
  const existingComments = await listPullRequestComments(context);
  const existingByTargetHash = new Map<
    string,
    {
      comment: GitHubReviewComment;
      marker: NonNullable<ReturnType<typeof parseMarker>>;
    }
  >();
  for (const comment of existingComments) {
    const marker = parseMarker(comment.body);
    if (marker?.reviewId === context.record.reviewId) {
      existingByTargetHash.set(marker.targetHash, { comment, marker });
    }
  }

  const published: ReviewPublicationRecord[] = [...planned.skipped];
  const plannedTargetHashes = new Set(
    planned.comments.map((item) => item.targetHash)
  );
  for (const item of planned.comments) {
    const existing = existingByTargetHash.get(item.targetHash);
    try {
      await waitBetweenMutations(context);
      const response = existing
        ? await context.request<GitHubReviewComment>(
            'PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}',
            {
              ...repoKey(context.repository),
              comment_id: existing.comment.id,
              body: item.body,
            }
          )
        : await context.request<GitHubReviewComment>(
            'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments',
            {
              ...repoKey(context.repository),
              pull_number: context.target.pullRequestNumber,
              body: item.body,
              commit_id: context.target.commitSha,
              path: item.path,
              line: item.line,
              side: 'RIGHT',
            }
          );
      published.push(
        await persistRecord(context, {
          channel: 'pullRequestComment',
          targetKey: item.targetKey,
          status: 'published',
          externalId: String(response.data.id),
          externalUrl: response.data.html_url,
          marker: item.marker,
          message: existing
            ? 'updated pull request comment'
            : 'created pull request comment',
          metadata: {
            path: item.path,
            line: item.line,
            fingerprint: item.finding.fingerprint,
          },
        })
      );
    } catch (error) {
      published.push(
        await persistRecord(context, {
          channel: 'pullRequestComment',
          targetKey: item.targetKey,
          status: 'failed',
          marker: item.marker,
          error: githubErrorMessage(error),
          metadata: {
            path: item.path,
            line: item.line,
            httpStatus: getErrorStatus(error),
          },
        })
      );
    }
  }

  for (const [targetHash, existing] of existingByTargetHash.entries()) {
    if (plannedTargetHashes.has(targetHash)) {
      continue;
    }
    try {
      await waitBetweenMutations(context);
      await context.request(
        'DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}',
        {
          ...repoKey(context.repository),
          comment_id: existing.comment.id,
        }
      );
      published.push(
        await persistRecord(context, {
          channel: 'pullRequestComment',
          targetKey: `pr-comment:dismissed:${targetHash}`,
          status: 'skipped',
          externalId: String(existing.comment.id),
          externalUrl: existing.comment.html_url,
          marker: existing.comment.body?.split('\n')[0],
          message: 'deleted obsolete review-agent comment',
        })
      );
    } catch (error) {
      published.push(
        await persistRecord(context, {
          channel: 'pullRequestComment',
          targetKey: `pr-comment:dismiss-failed:${targetHash}`,
          status: 'failed',
          externalId: String(existing.comment.id),
          externalUrl: existing.comment.html_url,
          error: githubErrorMessage(error),
          metadata: { httpStatus: getErrorStatus(error) },
        })
      );
    }
  }

  return published;
}

function responseStatusFor(
  publications: ReviewPublicationRecord[]
): ReviewPublishResponse['status'] {
  if (publications.length === 0) {
    return 'skipped';
  }
  const failed = publications.filter((item) => item.status === 'failed').length;
  const published = publications.filter(
    (item) => item.status === 'published'
  ).length;
  if (failed === publications.length) {
    return 'failed';
  }
  if (failed > 0 || published < publications.length) {
    return published > 0 ? 'partial' : 'skipped';
  }
  return 'published';
}

export function createGitHubPublicationService(
  options: GitHubPublicationServiceOptions
): ReviewPublicationService {
  const requestFactory =
    options.requestFactory ??
    createDefaultRequestFactory({
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.apiVersion ? { apiVersion: options.apiVersion } : {}),
    });
  const nowMs = options.nowMs ?? Date.now;
  const mutationDelayMs = options.mutationDelayMs ?? 0;

  return {
    async publish(record) {
      if (!record.authorization) {
        throw new GitHubPublicationError(
          409,
          'review has no repository authorization to publish'
        );
      }
      if (record.status !== 'completed' || !record.result) {
        throw new GitHubPublicationError(409, 'review is not ready to publish');
      }
      const repository = record.authorization.repository;
      const installationToken = await options.installationTokenProvider({
        installationId: repository.installationId,
        repositoryIds: [repository.repositoryId],
        permissions: PUBLICATION_PERMISSIONS,
      });
      const request = requestFactory(installationToken.token);
      const existing = buildExistingMap(
        await options.publicationStore.list(record.reviewId)
      );
      const context: PublicationContext = {
        record: record as PublicationContext['record'],
        result: record.result,
        repository,
        request,
        existing,
        target: await resolvePublishTarget(
          record as PublicationContext['record'],
          record.result,
          request
        ),
        store: options.publicationStore,
        nowMs,
        mutationDelayMs,
      };
      const publications = [
        await publishCheckRun(context),
        await publishSarif(context),
        ...(await publishPullRequestComments(context)),
      ];
      return {
        reviewId: record.reviewId,
        status: responseStatusFor(publications),
        publications,
      };
    },
  };
}
