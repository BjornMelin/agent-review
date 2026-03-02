import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runReview } from '@review-agent/review-core';
import type { ReviewProvider } from '@review-agent/review-types';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function makeRepo(): Promise<{
  cwd: string;
  cleanup: () => Promise<void>;
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'review-evals-regression-'));
  try {
    await runGit(cwd, ['init', '--initial-branch=main']);
    await runGit(cwd, ['config', 'user.name', 'Tester']);
    await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
    await writeFile(join(cwd, 'file.ts'), 'export const value = 1;\n', 'utf8');
    await runGit(cwd, ['add', 'file.ts']);
    await runGit(cwd, ['commit', '-m', 'base']);
    await writeFile(join(cwd, 'file.ts'), 'export const value = 2;\n', 'utf8');
  } catch (error) {
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
  return {
    cwd,
    cleanup: async () => {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

function makeProvider(
  id: 'codexDelegate' | 'openaiCompatible',
  cwd: string
): ReviewProvider {
  return {
    id,
    capabilities: () => ({
      jsonSchemaOutput: true,
      reasoningControl: false,
      streaming: false,
    }),
    run: async () => ({
      raw: {
        findings: [
          {
            title: '[P1] Missing test update',
            body: 'Behavior changed without tests.',
            confidence_score: 0.9,
            priority: 1,
            code_location: {
              absolute_file_path: join(cwd, 'file.ts'),
              line_range: { start: 1, end: 1 },
            },
          },
        ],
        overall_correctness: 'patch is incorrect',
        overall_explanation: 'Regression risk is high.',
        overall_confidence_score: 0.88,
      },
      text: '',
    }),
  };
}

describe('multi-provider regression', () => {
  it('normalizes equivalent provider outputs identically', async () => {
    const repo = await makeRepo();
    try {
      const codexProvider = makeProvider('codexDelegate', repo.cwd);
      const openaiProvider = makeProvider('openaiCompatible', repo.cwd);
      const providers = {
        codexDelegate: codexProvider,
        openaiCompatible: openaiProvider,
      };

      const codexRun = await runReview(
        {
          cwd: repo.cwd,
          target: { type: 'uncommittedChanges' },
          provider: 'codexDelegate',
          outputFormats: ['json'],
          model: 'gateway:fixed-model',
        },
        { providers }
      );

      const openaiRun = await runReview(
        {
          cwd: repo.cwd,
          target: { type: 'uncommittedChanges' },
          provider: 'openaiCompatible',
          outputFormats: ['json'],
          model: 'gateway:fixed-model',
        },
        { providers }
      );

      expect(openaiRun.result.findings).toEqual(codexRun.result.findings);
      expect(openaiRun.result.overallCorrectness).toBe(
        codexRun.result.overallCorrectness
      );
      expect(openaiRun.result.overallExplanation).toBe(
        codexRun.result.overallExplanation
      );
      expect(openaiRun.result.overallConfidenceScore).toBe(
        codexRun.result.overallConfidenceScore
      );
      expect(openaiRun.artifacts.json).toContain('gateway:fixed-model');
      expect(codexRun.artifacts.json).toContain('gateway:fixed-model');
    } finally {
      await repo.cleanup();
    }
  });
});
