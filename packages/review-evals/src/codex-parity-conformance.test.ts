import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runReview } from '@review-agent/review-core';
import type {
  LifecycleEvent,
  ReviewProvider,
} from '@review-agent/review-types';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function makeRepo(): Promise<{
  cwd: string;
  cleanup: () => Promise<void>;
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'review-evals-parity-'));
  await runGit(cwd, ['init', '--initial-branch=main']);
  await runGit(cwd, ['config', 'user.name', 'Tester']);
  await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
  await writeFile(join(cwd, 'file.ts'), 'export const value = 1;\n', 'utf8');
  await runGit(cwd, ['add', 'file.ts']);
  await runGit(cwd, ['commit', '-m', 'base']);
  await writeFile(join(cwd, 'file.ts'), 'export const value = 2;\n', 'utf8');

  return {
    cwd,
    cleanup: async () => {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

function structuredProvider(cwd: string): ReviewProvider {
  return {
    id: 'codexDelegate',
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

function plainTextProvider(): ReviewProvider {
  return {
    id: 'codexDelegate',
    capabilities: () => ({
      jsonSchemaOutput: false,
      reasoningControl: false,
      streaming: false,
    }),
    run: async () => ({ raw: null, text: 'just plain text response' }),
  };
}

describe('codex parity conformance', () => {
  it('emits entered->exited lifecycle ordering and artifacts', async () => {
    const repo = await makeRepo();
    try {
      const provider = structuredProvider(repo.cwd);
      const providers = {
        codexDelegate: provider,
        openaiCompatible: provider,
      };
      const events: LifecycleEvent[] = [];

      const run = await runReview(
        {
          cwd: repo.cwd,
          target: {
            type: 'custom',
            instructions: '  Please review this patch  ',
          },
          provider: 'codexDelegate',
          outputFormats: ['json', 'markdown', 'sarif'],
        },
        {
          providers,
          onEvent: (event) => events.push(event),
        }
      );

      const enteredIndex = events.findIndex(
        (event) => event.type === 'enteredReviewMode'
      );
      const exitedIndex = events.findIndex(
        (event) => event.type === 'exitedReviewMode'
      );
      expect(enteredIndex).toBeGreaterThanOrEqual(0);
      expect(exitedIndex).toBeGreaterThan(enteredIndex);

      expect(run.artifacts.json).toBeTruthy();
      expect(run.artifacts.markdown).toContain('# Review Report');
      expect(run.artifacts.sarif).toContain('"runs"');
    } finally {
      await repo.cleanup();
    }
  });

  it('matches codex plain-text fallback behavior', async () => {
    const repo = await makeRepo();
    try {
      const provider = plainTextProvider();
      const providers = {
        codexDelegate: provider,
        openaiCompatible: provider,
      };

      const run = await runReview(
        {
          cwd: repo.cwd,
          target: { type: 'uncommittedChanges' },
          provider: 'codexDelegate',
          outputFormats: ['json'],
        },
        { providers }
      );

      expect(run.result.findings).toHaveLength(0);
      expect(run.result.overallCorrectness).toBe('unknown');
      expect(run.result.overallExplanation).toBe('just plain text response');
      expect(run.result.overallConfidenceScore).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });
});
