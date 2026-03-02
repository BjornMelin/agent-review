import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import parityFixture from './fixtures/codex-parity-prompts.json' with {
  type: 'json',
};
import {
  REVIEW_PROMPT_PACK_ID,
  reviewPrompt,
  userFacingHint,
} from './index.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  return stdout.trim();
}

describe('codex parity prompt fixtures', () => {
  it('matches prompt pack id', () => {
    expect(REVIEW_PROMPT_PACK_ID).toBe(parityFixture.promptPackId);
  });

  it('matches uncommitted prompt fixture', async () => {
    const prompt = await reviewPrompt(
      { type: 'uncommittedChanges' },
      process.cwd()
    );
    expect(prompt).toBe(parityFixture.uncommittedPrompt);
  });

  it('matches commit prompts fixtures', async () => {
    const withTitle = await reviewPrompt(
      { type: 'commit', sha: 'abc123', title: 'Fix parser' },
      process.cwd()
    );
    expect(withTitle).toBe(
      parityFixture.commitPromptWithTitleTemplate
        .replaceAll('{sha}', 'abc123')
        .replaceAll('{title}', 'Fix parser')
    );

    const withoutTitle = await reviewPrompt(
      { type: 'commit', sha: 'abc123' },
      process.cwd()
    );
    expect(withoutTitle).toBe(
      parityFixture.commitPromptTemplate.replaceAll('{sha}', 'abc123')
    );
  });

  it('uses backup base-branch template outside a git repo', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-prompts-non-repo-'));
    try {
      const prompt = await reviewPrompt(
        { type: 'baseBranch', branch: 'main' },
        cwd
      );
      expect(prompt).toBe(
        parityFixture.baseBranchPromptBackupTemplate.replaceAll(
          '{branch}',
          'main'
        )
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses merge-base template in a git repo', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-prompts-repo-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
      await writeFile(join(cwd, 'base.txt'), 'base\n', 'utf8');
      await runGit(cwd, ['add', 'base.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);

      await runGit(cwd, ['checkout', '-b', 'feature']);
      await writeFile(join(cwd, 'feature.txt'), 'feature\n', 'utf8');
      await runGit(cwd, ['add', 'feature.txt']);
      await runGit(cwd, ['commit', '-m', 'feature']);

      const mergeBase = await runGit(cwd, ['merge-base', 'HEAD', 'main']);
      const prompt = await reviewPrompt(
        { type: 'baseBranch', branch: 'main' },
        cwd
      );
      const expected = parityFixture.baseBranchPromptTemplate
        .replaceAll('{baseBranch}', 'main')
        .replaceAll('{mergeBaseSha}', mergeBase);
      expect(prompt).toBe(expected);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('retains codex-style user-facing hints', () => {
    expect(userFacingHint({ type: 'uncommittedChanges' })).toBe(
      'current changes'
    );
    expect(userFacingHint({ type: 'baseBranch', branch: 'main' })).toBe(
      "changes against 'main'"
    );
    expect(
      userFacingHint({
        type: 'commit',
        sha: '1234567890abcdef',
        title: 'Fix parser',
      })
    ).toBe('commit 1234567: Fix parser');
    expect(
      userFacingHint({ type: 'custom', instructions: '  custom review  ' })
    ).toBe('custom review');
  });
});
