import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_CONTENT_TYPES,
  buildJsonSchemaSet,
  isTerminalReviewRunStatus,
  OutputFormatSchema,
  ReviewArtifactMetadataSchema,
  ReviewEventCursorSchema,
  ReviewRequestSchema,
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
