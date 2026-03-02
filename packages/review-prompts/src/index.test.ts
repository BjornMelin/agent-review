import { describe, expect, it } from 'vitest';
import { reviewPrompt, userFacingHint } from './index.js';

describe('review prompts', () => {
  it('builds uncommitted prompt', async () => {
    const prompt = await reviewPrompt(
      { type: 'uncommittedChanges' },
      process.cwd()
    );
    expect(prompt).toContain('staged, unstaged, and untracked');
  });

  it('builds commit hint with title', () => {
    const hint = userFacingHint({
      type: 'commit',
      sha: '1234567890abcdef',
      title: 'Fix parser',
    });
    expect(hint).toBe('commit 1234567: Fix parser');
  });

  it('rejects empty custom prompt', async () => {
    await expect(
      reviewPrompt({ type: 'custom', instructions: '   ' }, process.cwd())
    ).rejects.toThrow('Review prompt cannot be empty');
  });
});
