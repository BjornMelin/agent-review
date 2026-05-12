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

/**
 * Executes an authenticated GitHub REST request.
 *
 * @param route - Octokit route template for the GitHub endpoint.
 * @param options - Route parameters and request body fields.
 * @returns GitHub response data and optional HTTP status metadata.
 */
export type GitHubRequestClient = <TData>(
  route: string,
  options?: Record<string, unknown>
) => Promise<GitHubApiResponse<TData>>;

/**
 * Creates a GitHub request client for one installation token.
 *
 * @param token - GitHub installation access token used for authorization.
 * @returns Request client bound to the provided token.
 */
export type GitHubRequestFactory = (token: string) => GitHubRequestClient;

/**
 * Mints repository-scoped GitHub App installation tokens for publication.
 *
 * @param input - Installation, repository, and permission constraints.
 * @returns Narrowed GitHub App installation token.
 */
export type GitHubInstallationTokenProvider = (
  input: GitHubInstallationTokenRequest
) => Promise<GitHubInstallationToken>;

/**
 * Publishes a completed review record to external publication targets.
 */
export type ReviewPublicationService = {
  /**
   * Publishes one completed review record.
   *
   * @param record - Completed review record with repository authorization.
   * @returns Aggregate publication response and per-channel publication records.
   */
  publish(record: ReviewRecord): Promise<ReviewPublishResponse>;
};

/**
 * Signals a safe HTTP status and message for rejected GitHub publication work.
 */
export class GitHubPublicationError extends Error {
  /** HTTP status that the service route may expose for this safe error. */
  readonly status: 400 | 409 | 502;

  /**
   * Creates a safe publication error.
   *
   * @param status - HTTP status to return for the publication failure.
   * @param message - Safe error message to expose to API clients.
   */
  constructor(status: 400 | 409 | 502, message: string) {
    super(message);
    this.status = status;
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

type OwnedPullRequestComment = {
  comment: GitHubReviewComment;
  marker: NonNullable<ReturnType<typeof parseMarker>>;
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

function createKeyedAsyncLock(): <T>(
  key: string,
  task: () => Promise<T>
) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return async (key, task) => {
    const previous = tails.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      releaseCurrent = resolveCurrent;
    });
    const next = previous.catch(() => undefined).then(() => current);
    tails.set(key, next);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      releaseCurrent();
      if (tails.get(key) === next) {
        tails.delete(key);
      }
    }
  };
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

function escapeGitHubMarkdownHtml(input: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
  };
  return input.replace(/[&<>]/g, (character) => entities[character] ?? '');
}

function safeMarkdown(input: string): string {
  const redacted = redactSensitiveText(input).text;
  return escapeGitHubMarkdownHtml(redacted.replaceAll('@', '@ ')).slice(
    0,
    PUBLISH_MARKDOWN_LIMIT
  );
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

function hasRecordedSarifProcessingFailure(
  record: ReviewPublicationRecord
): boolean {
  const metadata = record.metadata as
    | { errors?: unknown; processingStatus?: unknown }
    | undefined;
  return (
    metadata?.processingStatus === 'failed' ||
    (Array.isArray(metadata?.errors) && metadata.errors.length > 0)
  );
}

function hasRecordedSarifProcessingSuccess(
  record: ReviewPublicationRecord
): boolean {
  return (
    (record.metadata as { processingStatus?: unknown } | undefined)
      ?.processingStatus === 'complete'
  );
}

function hasSarifProcessingFailure(
  status: GitHubSarifStatusResponse | undefined
): boolean {
  return (
    status?.processing_status === 'failed' ||
    (Array.isArray(status?.errors) && status.errors.length > 0)
  );
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
  const previous = context.existing.get(storeKey('sarif', targetKey));
  if (
    previous?.status === 'published' &&
    previous.externalId &&
    hasRecordedSarifProcessingSuccess(previous) &&
    !hasRecordedSarifProcessingFailure(previous)
  ) {
    return persistRecord(context, {
      channel: 'sarif',
      targetKey,
      status: 'published',
      externalId: previous.externalId,
      externalUrl: previous.externalUrl,
      message: 'reused SARIF upload',
      metadata: previous.metadata,
    });
  }

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
    const processingFailed = hasSarifProcessingFailure(status);
    return await persistRecord(context, {
      channel: 'sarif',
      targetKey,
      status: processingFailed ? 'failed' : 'published',
      externalId: uploaded.data.id,
      externalUrl: uploaded.data.url,
      message: status?.processing_status ?? 'SARIF upload accepted',
      ...(processingFailed
        ? {
            error: status?.errors?.join('; ') ?? 'SARIF processing failed',
          }
        : {}),
      metadata: {
        commitSha: context.target.commitSha,
        ref: context.target.ref,
        ...(status?.processing_status
          ? { processingStatus: status.processing_status }
          : {}),
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
  for (let page = 1; ; page += 1) {
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

function hasStoredCommentOwnership(
  context: PublicationContext,
  comment: GitHubReviewComment,
  marker: NonNullable<ReturnType<typeof parseMarker>>
): boolean {
  const externalId = String(comment.id);
  const commentMarker = comment.body?.split('\n')[0];
  const matchingRecords = [...context.existing.values()].filter(
    (record) =>
      record.channel === 'pullRequestComment' &&
      record.reviewId === context.record.reviewId &&
      record.marker === commentMarker &&
      parseMarker(record.marker)?.targetHash === marker.targetHash &&
      marker.fingerprint ===
        (record.metadata as { fingerprint?: unknown } | undefined)?.fingerprint
  );
  if (matchingRecords.some((record) => record.externalId === externalId)) {
    return true;
  }
  return (
    comment.user?.type === 'Bot' &&
    matchingRecords.some((record) => Boolean(record.externalId))
  );
}

async function deleteOwnedPullRequestComment(
  context: PublicationContext,
  existing: OwnedPullRequestComment,
  targetHash: string,
  reason: 'duplicate' | 'obsolete'
): Promise<ReviewPublicationRecord> {
  const externalId = String(existing.comment.id);
  try {
    await waitBetweenMutations(context);
    await context.request(
      'DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}',
      {
        ...repoKey(context.repository),
        comment_id: existing.comment.id,
      }
    );
    return await persistRecord(context, {
      channel: 'pullRequestComment',
      targetKey: `pr-comment:${reason}:${targetHash}:${externalId}`,
      status: 'skipped',
      externalId,
      externalUrl: existing.comment.html_url,
      marker: existing.comment.body?.split('\n')[0],
      message:
        reason === 'duplicate'
          ? 'deleted duplicate review-agent comment'
          : 'deleted obsolete review-agent comment',
    });
  } catch (error) {
    return persistRecord(context, {
      channel: 'pullRequestComment',
      targetKey: `pr-comment:${reason}-delete-failed:${targetHash}:${externalId}`,
      status: 'failed',
      externalId,
      externalUrl: existing.comment.html_url,
      error: githubErrorMessage(error),
      metadata: { httpStatus: getErrorStatus(error) },
    });
  }
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
  const existingByTargetHash = new Map<string, OwnedPullRequestComment[]>();
  for (const comment of existingComments) {
    const marker = parseMarker(comment.body);
    if (
      marker?.reviewId === context.record.reviewId &&
      hasStoredCommentOwnership(context, comment, marker)
    ) {
      const existing = existingByTargetHash.get(marker.targetHash) ?? [];
      existing.push({ comment, marker });
      existingByTargetHash.set(marker.targetHash, existing);
    }
  }

  const published: ReviewPublicationRecord[] = [...planned.skipped];
  const plannedTargetHashes = new Set(
    planned.comments.map((item) => item.targetHash)
  );
  for (const item of planned.comments) {
    const existing = existingByTargetHash.get(item.targetHash) ?? [];
    const [canonical, ...duplicates] = existing;
    try {
      await waitBetweenMutations(context);
      const response = canonical
        ? await context.request<GitHubReviewComment>(
            'PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}',
            {
              ...repoKey(context.repository),
              comment_id: canonical.comment.id,
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
          message: canonical
            ? 'updated pull request comment'
            : 'created pull request comment',
          metadata: {
            path: item.path,
            line: item.line,
            fingerprint: item.finding.fingerprint,
          },
        })
      );
      for (const duplicate of duplicates) {
        published.push(
          await deleteOwnedPullRequestComment(
            context,
            duplicate,
            item.targetHash,
            'duplicate'
          )
        );
      }
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
    for (const comment of existing) {
      published.push(
        await deleteOwnedPullRequestComment(
          context,
          comment,
          targetHash,
          'obsolete'
        )
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

/**
 * Creates a GitHub publication service for completed review results.
 *
 * @param options - Publication dependencies, request overrides, clock, and mutation pacing.
 * @returns Service that publishes review outcomes to GitHub Checks, SARIF, and PR comments.
 * @throws GitHubPublicationError from `publish` when a review lacks repository authorization or is not complete.
 */
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
  const withPublicationLock = createKeyedAsyncLock();

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
      const authorizedRecord = record as PublicationContext['record'];
      const result = record.result;
      return withPublicationLock(record.reviewId, async () => {
        const repository = authorizedRecord.authorization.repository;
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
          record: authorizedRecord,
          result,
          repository,
          request,
          existing,
          target: await resolvePublishTarget(authorizedRecord, result, request),
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
      });
    },
  };
}
