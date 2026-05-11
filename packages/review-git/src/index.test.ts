import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  collectDiffForTarget,
  ensureRustDiffIndexBinary,
  mergeBaseWithHead,
  resolveBranchRef,
} from './index.js';

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const rustDiffBinaryName =
  process.platform === 'win32' ? 'review-git-diff.exe' : 'review-git-diff';

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  return stdout.trim();
}

describe('mergeBaseWithHead', () => {
  it('returns merge base with local branch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);

      await writeFile(join(cwd, 'base.txt'), 'base\n');
      await runGit(cwd, ['add', 'base.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);

      await runGit(cwd, ['checkout', '-b', 'feature']);
      await writeFile(join(cwd, 'feature.txt'), 'feature\n');
      await runGit(cwd, ['add', 'feature.txt']);
      await runGit(cwd, ['commit', '-m', 'feature']);

      await runGit(cwd, ['checkout', 'main']);
      await writeFile(join(cwd, 'main.txt'), 'main\n');
      await runGit(cwd, ['add', 'main.txt']);
      await runGit(cwd, ['commit', '-m', 'main']);
      await runGit(cwd, ['checkout', 'feature']);

      const expected = await runGit(cwd, ['merge-base', 'HEAD', 'main']);
      const actual = await mergeBaseWithHead(cwd, 'main');
      expect(actual).toBe(expected);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('collectDiffForTarget', () => {
  it('resolves the packaged Rust helper from the dist artifact', async () => {
    await expect(ensureRustDiffIndexBinary()).resolves.toBe(
      join(packageRoot, 'dist', 'bin', rustDiffBinaryName)
    );
  });

  it('disables external diff helpers for host-side diff collection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);

      await writeFile(join(cwd, 'file.txt'), 'base\n');
      await runGit(cwd, ['add', 'file.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);
      await writeFile(join(cwd, 'file.txt'), 'changed\n');

      const marker = join(cwd, 'external-diff-ran');
      const helper = join(cwd, 'external-diff.sh');
      await writeFile(
        helper,
        `#!/bin/sh\necho helper-ran > ${JSON.stringify(marker)}\nexit 1\n`
      );
      await chmod(helper, 0o755);
      await runGit(cwd, ['config', 'diff.external', helper]);

      const diff = await collectDiffForTarget(cwd, {
        type: 'uncommittedChanges',
      });

      expect(diff.patch).toContain('+changed');
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves untracked symlinks without reading target file contents', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    const outside = await mkdtemp(join(tmpdir(), 'review-git-secret-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
      await writeFile(join(cwd, 'tracked.txt'), 'base\n');
      await runGit(cwd, ['add', 'tracked.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);

      const secretPath = join(outside, 'secret.txt');
      await writeFile(secretPath, 'DO_NOT_LEAK_THIS_CONTENT\n');
      await symlink(secretPath, join(cwd, 'linked-secret'));

      const diff = await collectDiffForTarget(cwd, {
        type: 'uncommittedChanges',
      });

      expect(diff.patch).toContain('new file mode 120000');
      expect(diff.patch).toContain('+');
      expect(diff.patch).not.toContain('DO_NOT_LEAK_THIS_CONTENT');
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('normalizes absolute paths when cwd is relative', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
      await writeFile(join(cwd, 'file.txt'), 'base\n');
      await runGit(cwd, ['add', 'file.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);
      await writeFile(join(cwd, 'file.txt'), 'changed\n');

      const diff = await collectDiffForTarget(relative(process.cwd(), cwd), {
        type: 'uncommittedChanges',
      });

      expect(diff.chunks[0]?.absoluteFilePath).toBe(join(cwd, 'file.txt'));
      expect([...diff.changedLineIndex.keys()]).toEqual([
        join(cwd, 'file.txt'),
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects branch refs that could be parsed as git options', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
      await writeFile(join(cwd, 'file.txt'), 'base\n');
      await runGit(cwd, ['add', 'file.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);

      const outputPath = join(cwd, 'option-output.patch');
      await expect(
        collectDiffForTarget(cwd, {
          type: 'baseBranch',
          branch: `--output=${outputPath}`,
        })
      ).rejects.toThrow('target.branch must not start with "-"');
      await expect(
        collectDiffForTarget(cwd, {
          type: 'baseBranch',
          branch: 'main..HEAD',
        })
      ).rejects.toThrow('target.branch must be a simple Git ref name');
      await expect(
        collectDiffForTarget(cwd, {
          type: 'baseBranch',
          branch: 'main:path',
        })
      ).rejects.toThrow('target.branch must be a simple Git ref name');
      await expect(
        collectDiffForTarget(cwd, {
          type: 'baseBranch',
          branch: 'feature/.tmp',
        })
      ).rejects.toThrow('target.branch must be a simple Git ref name');
      await expect(
        collectDiffForTarget(cwd, {
          type: 'baseBranch',
          branch: 'feature/topic.lock',
        })
      ).rejects.toThrow('target.branch must be a simple Git ref name');
      await expect(
        resolveBranchRef(cwd, 'release.lockstep')
      ).resolves.toBeNull();
      await expect(access(outputPath)).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects commit targets that could be parsed as git options', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
      await writeFile(join(cwd, 'file.txt'), 'base\n');
      await runGit(cwd, ['add', 'file.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);

      const outputPath = join(cwd, 'option-output.patch');
      await expect(
        collectDiffForTarget(cwd, {
          type: 'commit',
          sha: `--output=${outputPath}`,
        })
      ).rejects.toThrow('target.sha must not start with "-"');
      await expect(access(outputPath)).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('collects diffs for safe branch refs with option termination', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
      await writeFile(join(cwd, 'base.txt'), 'base\n');
      await runGit(cwd, ['add', 'base.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);
      await runGit(cwd, ['checkout', '-b', 'feature']);
      await writeFile(join(cwd, 'feature.txt'), 'feature\n');
      await runGit(cwd, ['add', 'feature.txt']);
      await runGit(cwd, ['commit', '-m', 'feature']);

      const diff = await collectDiffForTarget(cwd, {
        type: 'baseBranch',
        branch: 'main',
      });

      expect(diff.gitContext.mode).toBe('baseBranch');
      expect(diff.patch).toContain('+++ b/feature.txt');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('collects diffs for safe commit object ids with option termination', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
      await writeFile(join(cwd, 'file.txt'), 'base\n');
      await runGit(cwd, ['add', 'file.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);
      await writeFile(join(cwd, 'file.txt'), 'changed\n');
      await runGit(cwd, ['add', 'file.txt']);
      await runGit(cwd, ['commit', '-m', 'change']);
      const sha = await runGit(cwd, ['rev-parse', 'HEAD']);

      const diff = await collectDiffForTarget(cwd, {
        type: 'commit',
        sha,
      });

      expect(diff.gitContext.mode).toBe('commit');
      expect(diff.patch).toContain('+changed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects blob object ids for commit targets', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
      await writeFile(join(cwd, 'file.txt'), 'base\n');
      await runGit(cwd, ['add', 'file.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);
      const blobSha = await runGit(cwd, ['hash-object', '-w', 'file.txt']);

      await expect(
        collectDiffForTarget(cwd, {
          type: 'commit',
          sha: blobSha,
        })
      ).rejects.toThrow('git command failed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('enforces untracked file count and byte budgets before reading files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
      await writeFile(join(cwd, 'tracked.txt'), 'base\n');
      await runGit(cwd, ['add', 'tracked.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);

      await writeFile(join(cwd, 'one.txt'), 'one\n');
      await writeFile(join(cwd, 'two.txt'), 'two\n');
      await expect(
        collectDiffForTarget(
          cwd,
          { type: 'uncommittedChanges' },
          { maxFiles: 1 }
        )
      ).rejects.toThrow('untracked file count exceeds maxFiles');

      await rm(join(cwd, 'two.txt'), { force: true });
      await writeFile(join(cwd, 'one.txt'), 'x'.repeat(64));
      await expect(
        collectDiffForTarget(
          cwd,
          { type: 'uncommittedChanges' },
          { maxDiffBytes: 8 }
        )
      ).rejects.toThrow('untracked file exceeds maxDiffBytes');

      await rm(join(cwd, 'one.txt'), { force: true });
      await writeFile(join(cwd, 'one.txt'), 'one\n');
      await writeFile(join(cwd, 'two.txt'), 'two\n');
      await expect(
        collectDiffForTarget(
          cwd,
          { type: 'uncommittedChanges' },
          { maxDiffBytes: 160 }
        )
      ).rejects.toThrow(/maxDiffBytes/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('applies path filters before enforcing untracked file count budgets', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
      await writeFile(join(cwd, 'tracked.txt'), 'base\n');
      await runGit(cwd, ['add', 'tracked.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);

      await mkdir(join(cwd, 'src'));
      await mkdir(join(cwd, 'tmp'));
      await writeFile(join(cwd, 'src', 'one.txt'), 'one\n');
      await writeFile(join(cwd, 'tmp', 'ignored.txt'), 'ignored\n');

      const diff = await collectDiffForTarget(
        cwd,
        { type: 'uncommittedChanges' },
        { includePaths: ['src/**'], maxFiles: 1 }
      );

      expect(diff.patch).toContain('+++ b/src/one.txt');
      expect(diff.patch).not.toContain('tmp/ignored.txt');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('escapes untracked symlink targets before writing synthetic patch bodies', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
      await writeFile(join(cwd, 'tracked.txt'), 'base\n');
      await runGit(cwd, ['add', 'tracked.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);

      await symlink(
        'safe\ndiff --git a/../../outside b/../../outside\n@@ -0,0 +1 @@\n+bad',
        join(cwd, 'linked-secret')
      );

      const diff = await collectDiffForTarget(cwd, {
        type: 'uncommittedChanges',
      });

      expect(diff.chunks).toHaveLength(1);
      expect(diff.chunks[0]?.file).toBe('linked-secret');
      expect(diff.chunks[0]?.absoluteFilePath).toBe(join(cwd, 'linked-secret'));
      expect(diff.patch).toContain(
        '+safe\\ndiff --git a/../../outside b/../../outside'
      );
      expect(diff.patch).not.toContain(
        '\ndiff --git a/../../outside b/../../outside'
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('collects untracked files when cwd is a symlink to the repo root', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    const linkParent = await mkdtemp(join(tmpdir(), 'review-git-link-'));
    const linkedCwd = join(linkParent, 'repo-link');
    try {
      await runGit(repo, ['init', '--initial-branch=main']);
      await runGit(repo, ['config', 'user.name', 'Tester']);
      await runGit(repo, ['config', 'user.email', 'tester@example.com']);
      await writeFile(join(repo, 'tracked.txt'), 'base\n');
      await runGit(repo, ['add', 'tracked.txt']);
      await runGit(repo, ['commit', '-m', 'base']);
      await writeFile(join(repo, 'untracked.txt'), 'visible\n');
      await symlink(repo, linkedCwd);

      const diff = await collectDiffForTarget(linkedCwd, {
        type: 'uncommittedChanges',
      });

      expect(diff.patch).toContain('+++ b/untracked.txt');
      expect(diff.patch).toContain('+visible');
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(linkParent, { recursive: true, force: true });
    }
  });
});
