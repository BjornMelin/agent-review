import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_CONTENT_TYPES,
  assertReviewRequestWithinSecurityLimits,
  buildJsonSchemaSet,
  CommandRunInputSchema,
  CommandRunOutputSchema,
  DEFAULT_REVIEW_SECURITY_LIMITS,
  isTerminalReviewRunStatus,
  OutputFormatSchema,
  ProviderPolicyTelemetrySchema,
  parseRawModelOutput,
  ReviewArtifactMetadataSchema,
  ReviewEventCursorSchema,
  ReviewFindingTriageListResponseSchema,
  ReviewFindingTriageUpdateRequestSchema,
  ReviewPublicationRecordSchema,
  ReviewPublishPreviewResponseSchema,
  ReviewPublishResponseSchema,
  ReviewRepositorySelectionSchema,
  ReviewRequestSchema,
  ReviewResultSchema,
  ReviewRunAuthorizationSchema,
  ReviewRunStatusSchema,
  ReviewStartRequestSchema,
  ReviewStatusResponseSchema,
  redactReviewResult,
  redactSensitiveText,
  resolveReviewSecurityLimits,
  SandboxAuditSchema,
  withReviewRequestSecurityDefaults,
} from './index.js';

const request = {
  cwd: '/tmp/repo',
  target: { type: 'uncommittedChanges' },
  provider: 'codexDelegate',
  outputFormats: ['json'],
} as const;

async function readGeneratedSchema(path: string): Promise<unknown> {
  const url = new URL(`../generated/json-schema/${path}`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8')) as unknown;
}

describe('review-types schemas', () => {
  it('rejects unknown keys at boundaries', () => {
    expect(() =>
      ReviewRequestSchema.parse({
        ...request,
        unknown: true,
      })
    ).toThrow();

    expect(() =>
      ReviewStartRequestSchema.parse({
        request,
        delivery: 'inline',
        unknown: true,
      })
    ).toThrow();
  });

  it('applies stable service dto defaults', () => {
    expect(ReviewStartRequestSchema.parse({ request }).delivery).toBe('inline');
    expect(
      ReviewStartRequestSchema.parse({
        request,
        repository: {
          owner: 'octo-org',
          name: 'agent.review',
        },
      }).repository
    ).toEqual({
      provider: 'github',
      owner: 'octo-org',
      name: 'agent.review',
    });
    expect(ReviewEventCursorSchema.parse({ reviewId: 'review-1' })).toEqual({
      reviewId: 'review-1',
      limit: 100,
    });
    expect(
      ReviewPublishResponseSchema.parse({
        reviewId: 'review-1',
        status: 'published',
        publications: [
          {
            publicationId: 'review-1:check-run',
            reviewId: 'review-1',
            channel: 'checkRun',
            targetKey: 'check-run:abc1234',
            status: 'published',
            externalId: '123',
            externalUrl: 'https://github.com/octo-org/repo/runs/123',
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
      }).publications[0]
    ).toMatchObject({
      channel: 'checkRun',
      status: 'published',
    });
  });

  it('enforces request hardening constraints at schema boundaries', () => {
    expect(
      ReviewRequestSchema.parse({
        ...request,
        target: { type: 'baseBranch', branch: 'origin/main' },
        includePaths: ['packages/**'],
        excludePaths: ['packages/generated/**'],
        maxFiles: DEFAULT_REVIEW_SECURITY_LIMITS.maxMaxFiles,
        maxDiffBytes: DEFAULT_REVIEW_SECURITY_LIMITS.maxMaxDiffBytes,
        outputFormats: ['json', 'markdown'],
      })
    ).toMatchObject({
      target: { branch: 'origin/main' },
      includePaths: ['packages/**'],
    });

    expect(
      ReviewRequestSchema.parse({
        ...request,
        target: { type: 'custom', instructions: 'line one\nline two\tok' },
      }).target
    ).toEqual({
      type: 'custom',
      instructions: 'line one\nline two\tok',
    });
    expect(
      ReviewRequestSchema.parse({
        ...request,
        target: { type: 'baseBranch', branch: 'release.lockstep' },
      }).target
    ).toEqual({
      type: 'baseBranch',
      branch: 'release.lockstep',
    });

    expect(() =>
      ReviewRequestSchema.parse({
        ...request,
        target: { type: 'baseBranch', branch: 'main..HEAD' },
      })
    ).toThrow(/git ref/);
    expect(() =>
      ReviewRequestSchema.parse({
        ...request,
        target: { type: 'baseBranch', branch: 'feature/.tmp' },
      })
    ).toThrow(/git ref/);
    expect(() =>
      ReviewRequestSchema.parse({
        ...request,
        target: { type: 'baseBranch', branch: 'feature/topic.lock' },
      })
    ).toThrow(/git ref/);
    expect(() =>
      ReviewRequestSchema.parse({
        ...request,
        target: { type: 'commit', sha: 'HEAD' },
      })
    ).toThrow(/Git object id/);
    expect(() =>
      ReviewRequestSchema.parse({
        ...request,
        includePaths: ['../secrets'],
      })
    ).toThrow(/path filter/);
    expect(() =>
      ReviewRequestSchema.parse({
        ...request,
        outputFormats: ['json', 'json'],
      })
    ).toThrow(/duplicates/);
    expect(() =>
      ReviewPublicationRecordSchema.parse({
        publicationId: 'publication-1',
        reviewId: 'review-1',
        channel: 'other',
        targetKey: 'target',
        status: 'published',
        createdAt: 1,
        updatedAt: 1,
      })
    ).toThrow();
    expect(() =>
      ReviewRequestSchema.parse({
        ...request,
        maxDiffBytes: DEFAULT_REVIEW_SECURITY_LIMITS.maxMaxDiffBytes + 1,
      })
    ).toThrow();
    expect(() =>
      ReviewRequestSchema.parse({
        ...request,
        target: { type: 'custom', instructions: 'line one\0line two' },
      })
    ).toThrow(/control characters/);
  });

  it('adds default diff caps and redacts secret-bearing review text', () => {
    expect(
      withReviewRequestSecurityDefaults(ReviewRequestSchema.parse(request))
    ).toMatchObject({
      maxFiles: DEFAULT_REVIEW_SECURITY_LIMITS.defaultMaxFiles,
      maxDiffBytes: DEFAULT_REVIEW_SECURITY_LIMITS.defaultMaxDiffBytes,
    });
    expect(
      withReviewRequestSecurityDefaults(
        ReviewRequestSchema.parse({
          ...request,
          maxFiles: 50,
          maxDiffBytes: 50,
        }),
        {
          ...DEFAULT_REVIEW_SECURITY_LIMITS,
          maxMaxFiles: 10,
          maxMaxDiffBytes: 8,
        }
      )
    ).toMatchObject({
      maxFiles: 10,
      maxDiffBytes: 8,
    });
    expect(
      resolveReviewSecurityLimits({
        defaultMaxFiles: 500,
        maxMaxFiles: 5,
        maxPromptBytes: -1,
      })
    ).toMatchObject({
      defaultMaxFiles: 5,
      maxMaxFiles: 5,
      maxPromptBytes: DEFAULT_REVIEW_SECURITY_LIMITS.maxPromptBytes,
    });
    expect(() =>
      withReviewRequestSecurityDefaults(
        ReviewRequestSchema.parse({
          ...request,
          model: 'long-model-name',
        }),
        { ...DEFAULT_REVIEW_SECURITY_LIMITS, maxModelBytes: 4 }
      )
    ).toThrow(/model exceeds/);
    expect(() =>
      assertReviewRequestWithinSecurityLimits(
        ReviewRequestSchema.parse({
          ...request,
          maxFiles: 50,
        }),
        { ...DEFAULT_REVIEW_SECURITY_LIMITS, maxMaxFiles: 10 }
      )
    ).toThrow(/maxFiles exceeds/);
    expect(() =>
      assertReviewRequestWithinSecurityLimits(
        ReviewRequestSchema.parse({
          ...request,
          maxDiffBytes: 50,
        }),
        { ...DEFAULT_REVIEW_SECURITY_LIMITS, maxMaxDiffBytes: 10 }
      )
    ).toThrow(/maxDiffBytes exceeds/);

    const secret =
      'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456 Bearer abc.def.ghi';
    const redacted = redactSensitiveText(secret);
    expect(redacted.text).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(redacted.text).toContain('[REDACTED_SECRET]');
    expect(redacted.redactions.apiKeyLike).toBeGreaterThan(0);
    expect(redacted.redactions.bearer).toBeGreaterThan(0);

    const metadata = redactSensitiveText(
      'author: reviewer\n"apiKey": "plain-secret-value"\nPASSWORD=plain-password'
    );
    expect(metadata.text).toContain('author: reviewer');
    expect(metadata.text).toContain('"apiKey": "[REDACTED_SECRET]"');
    expect(metadata.text).toContain('PASSWORD=[REDACTED_SECRET]');

    const result = ReviewResultSchema.parse({
      findings: [
        {
          title: 'Secret leak',
          body: `Do not expose ${secret}`,
          confidenceScore: 0.9,
          codeLocation: {
            absoluteFilePath: '/tmp/repo/src/index.ts',
            lineRange: { start: 1, end: 1 },
          },
          fingerprint: 'finding-1',
        },
      ],
      overallCorrectness: 'patch is incorrect',
      overallExplanation: `Summary ${secret}`,
      overallConfidenceScore: 0.9,
      metadata: {
        provider: 'codexDelegate',
        modelResolved: 'codex',
        executionMode: 'localTrusted',
        promptPack: 'default',
        gitContext: { mode: 'custom' },
      },
    });

    const sanitized = redactReviewResult(result).result;
    expect(JSON.stringify(sanitized)).not.toContain(
      'sk-abcdefghijklmnopqrstuvwxyz'
    );
    expect(sanitized.findings[0]?.body).toContain('[REDACTED_SECRET]');
    expect(
      redactSensitiveText(
        'REVIEW_SERVICE_TOKEN=rat_tokenid_abcdefghijklmnopqrstuvwxyz'
      ).text
    ).toContain('[REDACTED_SECRET]');
  });

  it('validates and redacts provider policy telemetry', () => {
    const providerTelemetry = ProviderPolicyTelemetrySchema.parse({
      policyVersion: 'provider-policy.v1',
      requestedModel: 'gateway:openai/gpt-5',
      resolvedModel: 'gateway:openai/gpt-5',
      route: 'gateway',
      finalProvider: 'openai',
      fallbackOrder: ['gateway:anthropic/claude-sonnet-4-5'],
      fallbackUsed: false,
      maxInputChars: 120_000,
      maxOutputTokens: 4096,
      timeoutMs: 120_000,
      maxAttempts: 2,
      retention: 'unknown',
      zdrRequired: false,
      disallowPromptTraining: true,
      failureClass: 'none',
      totalLatencyMs: 42,
      attempts: [
        {
          route: 'gateway',
          model: 'gateway:openai/gpt-5',
          provider: 'openai',
          status: 'success',
          latencyMs: 42,
          failureClass: 'none',
          generationId: 'gen_secret',
          usage: {
            status: 'reported',
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            costUsd: 0.001,
          },
        },
      ],
      usage: {
        status: 'reported',
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        costUsd: 0.001,
      },
    });
    const result = ReviewResultSchema.parse({
      findings: [],
      overallCorrectness: 'patch is correct',
      overallExplanation: 'ok',
      overallConfidenceScore: 1,
      metadata: {
        provider: 'openaiCompatible',
        modelResolved: 'gateway:openai/gpt-5',
        executionMode: 'localTrusted',
        promptPack: 'default',
        gitContext: { mode: 'custom' },
        providerTelemetry,
      },
    });

    expect(
      redactReviewResult(result).result.metadata.providerTelemetry
    ).toEqual(providerTelemetry);

    const redactionProbeTelemetry = ProviderPolicyTelemetrySchema.parse({
      ...providerTelemetry,
      attempts: [
        {
          ...providerTelemetry.attempts[0]!,
          errorCode: 'Bearer abc.def.ghi',
          generationId: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
        },
      ],
    });
    const redactionProbe = ReviewResultSchema.parse({
      ...result,
      metadata: {
        ...result.metadata,
        providerTelemetry: redactionProbeTelemetry,
      },
    });
    const redactedTelemetry =
      redactReviewResult(redactionProbe).result.metadata.providerTelemetry;

    expect(redactedTelemetry?.attempts[0]?.generationId).toBe(
      'OPENAI_API_KEY=[REDACTED_SECRET]'
    );
    expect(redactedTelemetry?.attempts[0]?.errorCode).toBe('Bearer [REDACTED]');
    expect(JSON.stringify(redactedTelemetry)).not.toContain(
      'sk-abcdefghijklmnopqrstuvwxyz123456'
    );
    expect(redactedTelemetry?.usage.costUsd).toBe(0.001);
  });

  it('validates hosted repository authorization metadata', () => {
    expect(
      ReviewRepositorySelectionSchema.parse({
        owner: 'octo-org',
        name: 'review-agent',
        installationId: 123,
        pullRequestNumber: 42,
      })
    ).toMatchObject({
      provider: 'github',
      owner: 'octo-org',
      name: 'review-agent',
    });

    expect(() =>
      ReviewRepositorySelectionSchema.parse({
        owner: '-bad',
        name: 'review-agent',
      })
    ).toThrow(/GitHub owner/);
    expect(() =>
      ReviewRepositorySelectionSchema.parse({
        owner: 'octo-org',
        name: 'review-agent.git',
      })
    ).toThrow(/\.git suffix/);
    expect(() =>
      ReviewRepositorySelectionSchema.parse({
        owner: 'octo-org',
        name: 'review-agent',
        pullRequestNumber: 42,
        ref: 'refs/heads/main',
      })
    ).toThrow(/at most one/);

    const authorization = ReviewRunAuthorizationSchema.parse({
      principal: {
        type: 'serviceToken',
        tokenId: 'token-1',
        tokenPrefix: 'rat_token-1',
        name: 'CI',
      },
      repository: {
        provider: 'github',
        repositoryId: 99,
        installationId: 123,
        owner: 'octo-org',
        name: 'review-agent',
        fullName: 'octo-org/review-agent',
        visibility: 'private',
        permissions: { metadata: 'read', contents: 'read' },
        commitSha: 'abcdef1',
      },
      scopes: ['review:start', 'review:read'],
      actor: 'service-token:token-1',
      requestHash: 'sha256:abc',
      authorizedAt: 1_000,
    });
    expect(authorization.repository.fullName).toBe('octo-org/review-agent');
    expect(() =>
      ReviewRunAuthorizationSchema.parse({
        ...authorization,
        scopes: ['review:read', 'review:read'],
      })
    ).toThrow(/duplicates/);
    expect(() =>
      ReviewRunAuthorizationSchema.parse({
        ...authorization,
        repository: {
          ...authorization.repository,
          ref: 'refs/heads/main',
        },
      })
    ).toThrow(/at most one/);
  });

  it('centralizes run status and artifact format policy', () => {
    expect(ReviewRunStatusSchema.options).toEqual([
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(isTerminalReviewRunStatus('completed')).toBe(true);
    expect(isTerminalReviewRunStatus('running')).toBe(false);
    expect(OutputFormatSchema.parse('markdown')).toBe('markdown');
    expect(ARTIFACT_CONTENT_TYPES.markdown).toBe(
      'text/markdown; charset=utf-8'
    );
  });

  it('validates service, artifact, and sandbox dto shapes', () => {
    expect(
      ReviewStatusResponseSchema.parse({
        reviewId: 'review-1',
        status: 'queued',
        createdAt: 1,
        updatedAt: 1,
      })
    ).toEqual({
      reviewId: 'review-1',
      status: 'queued',
      createdAt: 1,
      updatedAt: 1,
    });

    expect(
      ReviewArtifactMetadataSchema.parse({
        reviewId: 'review-1',
        format: 'json',
        contentType: ARTIFACT_CONTENT_TYPES.json,
        byteLength: 123,
        createdAt: 1,
      })
    ).toEqual({
      reviewId: 'review-1',
      format: 'json',
      contentType: ARTIFACT_CONTENT_TYPES.json,
      byteLength: 123,
      createdAt: 1,
    });

    expect(
      SandboxAuditSchema.parse({
        sandboxId: 'sandbox-1',
        policy: {
          networkProfile: 'deny_all',
          allowlistDomains: [],
          commandAllowlistSize: 1,
          envAllowlistSize: 1,
        },
        consumed: {
          commandCount: 1,
          wallTimeMs: 2,
          outputBytes: 3,
          artifactBytes: 4,
        },
        redactions: { apiKeyLike: 0, bearer: 0 },
        commands: [],
      })
    ).toMatchObject({
      sandboxId: 'sandbox-1',
      policy: { networkProfile: 'deny_all' },
    });

    expect(
      ReviewFindingTriageUpdateRequestSchema.parse({
        status: 'accepted',
        note: 'Reviewed by platform owner.',
      })
    ).toEqual({
      status: 'accepted',
      note: 'Reviewed by platform owner.',
    });
    expect(() => ReviewFindingTriageUpdateRequestSchema.parse({})).toThrow(
      /status or note is required/
    );
    expect(
      ReviewFindingTriageListResponseSchema.parse({
        reviewId: 'review-1',
        items: [
          {
            reviewId: 'review-1',
            fingerprint: 'finding-1',
            status: 'accepted',
            actor: 'service-token:token-1',
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        audit: [
          {
            auditId: 'audit-1',
            reviewId: 'review-1',
            fingerprint: 'finding-1',
            toStatus: 'accepted',
            createdAt: 2,
          },
        ],
      })
    ).toMatchObject({
      reviewId: 'review-1',
      items: [{ status: 'accepted' }],
      audit: [{ toStatus: 'accepted' }],
    });

    expect(
      ReviewPublishPreviewResponseSchema.parse({
        reviewId: 'review-1',
        target: {
          owner: 'octo-org',
          repo: 'agent-review',
          repositoryId: 42,
          installationId: 7,
          commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
        },
        items: [
          {
            channel: 'checkRun',
            targetKey: 'check-run:abcdef',
            action: 'create',
            message: 'would create check run',
          },
        ],
        existingPublications: [],
        summary: {
          checkRunAction: 'create',
          sarifAction: 'skip',
          pullRequestCommentCount: 0,
          blockedCount: 0,
        },
      })
    ).toMatchObject({
      summary: { checkRunAction: 'create' },
    });
  });

  it('validates command runner input and output contracts', () => {
    expect(
      CommandRunInputSchema.parse({
        commandId: 'codex-review',
        cmd: 'codex',
        args: ['review', '--uncommitted'],
        cwd: '/tmp/repo',
        timeoutMs: 1000,
        maxFileBytes: 1000,
        maxTotalFileBytes: 1000,
        readFiles: [],
      })
    ).toMatchObject({
      commandId: 'codex-review',
      cmd: 'codex',
    });

    expect(
      CommandRunOutputSchema.parse({
        commandId: 'codex-review',
        cmd: 'codex',
        args: ['review', '--uncommitted'],
        cwd: '/tmp/repo',
        status: 'completed',
        exitCode: 0,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        startedAtMs: 1,
        endedAtMs: 2,
        durationMs: 1,
        outputBytes: 0,
        redactions: { apiKeyLike: 0, bearer: 0 },
        events: [
          {
            type: 'started',
            commandId: 'codex-review',
            timestampMs: 1,
          },
        ],
        files: [
          {
            key: 'lastMessage',
            path: '/tmp/last-message.txt',
            content: '{}',
            byteLength: 2,
            truncated: false,
            redactions: { apiKeyLike: 0, bearer: 0 },
          },
        ],
      })
    ).toMatchObject({
      commandId: 'codex-review',
      status: 'completed',
    });
  });

  it('rejects inverted line ranges at normalized and raw model boundaries', () => {
    expect(() =>
      ReviewResultSchema.parse({
        findings: [
          {
            title: 'Bad location',
            body: 'The model produced an inverted location range.',
            confidenceScore: 0.9,
            codeLocation: {
              absoluteFilePath: '/tmp/repo/src/index.ts',
              lineRange: { start: 10, end: 2 },
            },
            fingerprint: 'finding-1',
          },
        ],
        overallCorrectness: 'patch is incorrect',
        overallExplanation: 'Invalid line range.',
        overallConfidenceScore: 0.9,
        metadata: {
          provider: 'codexDelegate',
          modelResolved: 'codex',
          executionMode: 'localTrusted',
          promptPack: 'default',
          gitContext: { mode: 'custom' },
        },
      })
    ).toThrow(/end must be >= start/);

    expect(() =>
      parseRawModelOutput({
        findings: [
          {
            title: 'Bad location',
            body: 'The model produced an inverted location range.',
            confidence_score: 0.9,
            code_location: {
              absolute_file_path: '/tmp/repo/src/index.ts',
              line_range: { start: 10, end: 2 },
            },
          },
        ],
        overall_correctness: 'patch is incorrect',
        overall_explanation: 'Invalid line range.',
        overall_confidence_score: 0.9,
      })
    ).toThrow(/end must be >= start/);
  });

  it('emits json schemas', () => {
    const schemas = buildJsonSchemaSet();
    expect(schemas.reviewRequest).toBeTruthy();
    expect(schemas.reviewResult).toBeTruthy();
    expect(schemas.reviewStartRequest).toBeTruthy();
    expect(schemas.reviewRunStoreRecord).toBeTruthy();
    expect(
      (
        schemas.reviewRepositorySelection as {
          properties: { name: { pattern: string } };
        }
      ).properties.name.pattern
    ).toContain('?!.*\\.git$');
    expect(
      (
        schemas.reviewRunAuthorization as {
          properties: { scopes: { uniqueItems?: boolean } };
        }
      ).properties.scopes.uniqueItems
    ).toBe(true);
    expect(
      (
        schemas.reviewRepositorySelection as {
          not: { anyOf: Array<{ required: string[] }> };
        }
      ).not.anyOf
    ).toEqual(
      expect.arrayContaining([
        { required: ['pullRequestNumber', 'ref'] },
        { required: ['pullRequestNumber', 'commitSha'] },
        { required: ['ref', 'commitSha'] },
      ])
    );
    expect(
      (
        schemas.reviewRunAuthorization as {
          properties: {
            repository: { not: { anyOf: Array<{ required: string[] }> } };
          };
        }
      ).properties.repository.not.anyOf
    ).toEqual(
      expect.arrayContaining([{ required: ['pullRequestNumber', 'ref'] }])
    );
  });

  it('keeps generated json schema artifacts in sync', async () => {
    const schemas = buildJsonSchemaSet();
    const manifest = (await readGeneratedSchema('manifest.json')) as {
      schemas: Array<{ name: keyof typeof schemas; file: string }>;
    };

    expect(manifest.schemas.map((entry) => entry.name).sort()).toEqual(
      Object.keys(schemas).sort()
    );

    for (const entry of manifest.schemas) {
      await expect(readGeneratedSchema(entry.file)).resolves.toEqual(
        schemas[entry.name]
      );
    }
  });
});
