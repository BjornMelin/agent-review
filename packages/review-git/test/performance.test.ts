import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  collectDiffForTarget,
  ensureRustDiffIndexBinary,
  indexDiffForReviewRequest,
} from '../src/index.js';
import {
  buildChangedLineIndex,
  parseUnifiedDiff as parseUnifiedDiffBaseline,
} from '../test-support/ts-diff-baseline.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, encoding: 'utf8' });
}

function makeSyntheticPatch(fileCount: number): string {
  return Array.from({ length: fileCount }, (_value, index) => {
    const file = `src/file-${index}.ts`;
    return [
      `diff --git a/${file} b/${file}`,
      'index 7898192..6178079 100644',
      `--- a/${file}`,
      `+++ b/${file}`,
      '@@ -1 +1 @@',
      `-export const value${index} = "old";`,
      `+export const value${index} = "new";`,
    ].join('\n');
  }).join('\n');
}

describe('large diff performance suite', () => {
  it('collects and parses large uncommitted diffs within budget', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-performance-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);

      const fileCount = 140;
      for (let index = 0; index < fileCount; index += 1) {
        const file = join(cwd, `file-${index}.ts`);
        await writeFile(file, `export const v${index} = 1;\n`, 'utf8');
      }
      await runGit(cwd, ['add', '.']);
      await runGit(cwd, ['commit', '-m', 'baseline']);

      for (let index = 0; index < fileCount; index += 1) {
        const file = join(cwd, `file-${index}.ts`);
        await writeFile(file, `export const v${index} = 2;\n`, 'utf8');
      }

      const startedAt = Date.now();
      const diff = await collectDiffForTarget(cwd, {
        type: 'uncommittedChanges',
      });
      const durationMs = Date.now() - startedAt;

      expect(diff.chunks.length).toBe(fileCount);
      expect(diff.changedLineIndex.size).toBe(fileCount);
      if (process.env.REVIEW_AGENT_STRICT_PERF === '1') {
        expect(durationMs).toBeLessThan(15000);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30000);

  it('benchmarks the production Rust parser/index path against the TS baseline', async () => {
    const cwd = join(tmpdir(), 'review-git-benchmark-root');
    const patch = makeSyntheticPatch(240);

    const tsStartedAt = Date.now();
    const tsChunks = parseUnifiedDiffBaseline(cwd, patch);
    const tsIndex = buildChangedLineIndex(tsChunks);
    const tsDurationMs = Date.now() - tsStartedAt;

    expect(tsChunks.length).toBe(240);
    expect(tsIndex.size).toBe(240);
    if (process.env.REVIEW_AGENT_STRICT_PERF === '1') {
      expect(tsDurationMs).toBeLessThan(1500);
    }

    await ensureRustDiffIndexBinary();
    const rustStartedAt = Date.now();
    const rust = await indexDiffForReviewRequest(
      {
        cwd,
        target: { type: 'uncommittedChanges' },
        provider: 'codexDelegate',
        executionMode: 'localTrusted',
        outputFormats: ['json'],
      },
      patch
    );
    const rustDurationMs = Date.now() - rustStartedAt;

    expect(
      rust.chunks.map((chunk) => ({
        file: chunk.file,
        absoluteFilePath: chunk.absoluteFilePath,
        changedLines: chunk.changedLines,
        patch: chunk.patch,
      }))
    ).toEqual(
      tsChunks.map((chunk) => ({
        file: chunk.file,
        absoluteFilePath: chunk.absoluteFilePath,
        changedLines: chunk.changedLines,
        patch: chunk.patch,
      }))
    );
    expect(rust.changedLineIndex.size).toBe(tsIndex.size);
    if (process.env.REVIEW_AGENT_STRICT_PERF === '1') {
      expect(rustDurationMs).toBeLessThan(Math.max(1000, tsDurationMs * 20));
    }
  }, 60000);
});
