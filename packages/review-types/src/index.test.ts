import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_CONTENT_TYPES,
  buildJsonSchemaSet,
  isTerminalReviewRunStatus,
  OutputFormatSchema,
  parseRawModelOutput,
  ReviewArtifactMetadataSchema,
  ReviewEventCursorSchema,
  ReviewRequestSchema,
  ReviewResultSchema,
  ReviewRunStatusSchema,
  ReviewStartRequestSchema,
  ReviewStatusResponseSchema,
  SandboxAuditSchema,
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
    expect(ReviewEventCursorSchema.parse({ reviewId: 'review-1' })).toEqual({
      reviewId: 'review-1',
      limit: 100,
    });
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
