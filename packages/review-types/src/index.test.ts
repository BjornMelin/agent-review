import { describe, expect, it } from 'vitest';
import { buildJsonSchemaSet, ReviewRequestSchema } from './index.js';

describe('review-types schemas', () => {
  it('rejects unknown keys at boundaries', () => {
    expect(() =>
      ReviewRequestSchema.parse({
        cwd: '/tmp',
        target: { type: 'uncommittedChanges' },
        provider: 'codexDelegate',
        outputFormats: ['json'],
        unknown: true,
      })
    ).toThrow();
  });

  it('emits json schemas', () => {
    const schemas = buildJsonSchemaSet();
    expect(schemas.reviewRequest).toBeTruthy();
    expect(schemas.reviewResult).toBeTruthy();
  });
});
