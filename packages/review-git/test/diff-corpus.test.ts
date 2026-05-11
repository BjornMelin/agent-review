import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/diff-parser.js';
import { collectDiffForTarget, type DiffContext } from '../src/index.js';
import {
  ensureRustDiffBinary,
  parseWithRustDiffCandidate,
} from '../test-support/rust-diff-candidate.js';

const execFileAsync = promisify(execFile);

type ExpectedChunk = {
  file: string;
  absoluteFilePath: string;
  changedLines: number[];
  metadata: DiffMetadata;
};

type DiffMetadata = {
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'submodule';
  isBinary: boolean;
  isRename: boolean;
  isDelete: boolean;
  isNewFile: boolean;
  isSubmodule: boolean;
  hasNoNewlineMarker: boolean;
  usesQuotedPath: boolean;
  hasCarriageReturns: boolean;
};

type CorpusFixture = {
  name: keyof typeof builders;
  filters?: {
    includePaths?: string[];
    excludePaths?: string[];
  };
  expected: {
    gitContext: { mode: 'uncommitted' };
    filteredFiles?: string[];
    chunks: ExpectedChunk[];
  };
};

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'review-git-corpus-'));
  await runGit(cwd, ['init', '--initial-branch=main']);
  await runGit(cwd, ['config', 'user.name', 'Tester']);
  await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
  await runGit(cwd, ['config', 'core.autocrlf', 'input']);
  await runGit(cwd, ['config', 'core.quotePath', 'true']);
  return cwd;
}

async function writeText(cwd: string, path: string, content: string) {
  const file = join(cwd, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function commitAll(cwd: string, message = 'baseline') {
  await runGit(cwd, ['add', '.']);
  await runGit(cwd, ['commit', '-m', message]);
}

function largeFileContent(suffix: string): string {
  return Array.from(
    { length: 120 },
    (_value, index) => `export const value${index + 1} = "${suffix}";`
  ).join('\n');
}

const builders = {
  'staged-change': async (cwd: string) => {
    await writeText(cwd, 'src/staged.ts', 'export const staged = 1;\n');
    await commitAll(cwd);
    await writeText(cwd, 'src/staged.ts', 'export const staged = 2;\n');
    await runGit(cwd, ['add', 'src/staged.ts']);
  },
  'unstaged-change': async (cwd: string) => {
    await writeText(cwd, 'src/unstaged.ts', 'export const unstaged = 1;\n');
    await commitAll(cwd);
    await writeText(cwd, 'src/unstaged.ts', 'export const unstaged = 2;\n');
  },
  'untracked-file': async (cwd: string) => {
    await writeText(cwd, 'README.md', '# baseline\n');
    await commitAll(cwd);
    await writeText(cwd, 'src/untracked.ts', 'export const untracked = 1;\n');
  },
  'untracked-quoted-path': async (cwd: string) => {
    await writeText(cwd, 'README.md', '# baseline\n');
    await commitAll(cwd);
    await writeText(cwd, 'quoted\tnew.ts', 'export const untracked = 1;\n');
  },
  'untracked-non-ascii-path': async (cwd: string) => {
    await writeText(cwd, 'README.md', '# baseline\n');
    await commitAll(cwd);
    await writeText(cwd, 'café-new.ts', 'export const untracked = 1;\n');
  },
  'untracked-symlink-injection': async (cwd: string) => {
    await writeText(cwd, 'README.md', '# baseline\n');
    await commitAll(cwd);
    await symlink(
      'safe\ndiff --git a/../../outside b/../../outside\n@@ -0,0 +1 @@\n+bad',
      join(cwd, 'linked-secret')
    );
  },
  'binary-file': async (cwd: string) => {
    await writeText(cwd, 'README.md', '# baseline\n');
    await commitAll(cwd);
    await mkdir(join(cwd, 'assets'), { recursive: true });
    await writeFile(join(cwd, 'assets/blob.bin'), Buffer.from([0, 1, 2, 3]));
  },
  'binary-space-b-path': async (cwd: string) => {
    await mkdir(join(cwd, 'secret b'), { recursive: true });
    await writeFile(join(cwd, 'secret b/leak.bin'), Buffer.from([0, 1, 2]));
    await commitAll(cwd);
    await writeFile(join(cwd, 'secret b/leak.bin'), Buffer.from([0, 2, 3]));
  },
  'untracked-binary-space-b-path': async (cwd: string) => {
    await writeText(cwd, 'README.md', '# baseline\n');
    await commitAll(cwd);
    await mkdir(join(cwd, 'secret b'), { recursive: true });
    await writeFile(join(cwd, 'secret b/new.bin'), Buffer.from([0, 1, 2]));
  },
  'rename-file': async (cwd: string) => {
    await writeText(cwd, 'src/original.ts', 'export const renamed = 1;\n');
    await commitAll(cwd);
    await runGit(cwd, ['mv', 'src/original.ts', 'src/renamed.ts']);
  },
  'rename-space-b-path': async (cwd: string) => {
    await writeText(cwd, 'secret b/leak.ts', 'export const renamed = 1;\n');
    await commitAll(cwd);
    await runGit(cwd, ['mv', 'secret b/leak.ts', 'secret b/renamed.ts']);
  },
  'deleted-file': async (cwd: string) => {
    await writeText(cwd, 'src/deleted.ts', 'export const deleted = 1;\n');
    await commitAll(cwd);
    await runGit(cwd, ['rm', 'src/deleted.ts']);
  },
  'deleted-space-b-path': async (cwd: string) => {
    await writeText(cwd, 'secret b/leak.ts', 'export const deleted = 1;\n');
    await commitAll(cwd);
    await runGit(cwd, ['rm', 'secret b/leak.ts']);
  },
  'no-newline': async (cwd: string) => {
    await writeText(cwd, 'src/no-newline.ts', 'export const value = 1;\n');
    await commitAll(cwd);
    await writeFile(join(cwd, 'src/no-newline.ts'), 'export const value = 2;');
  },
  'large-file': async (cwd: string) => {
    await writeText(cwd, 'src/large.ts', `${largeFileContent('old')}\n`);
    await commitAll(cwd);
    await writeText(cwd, 'src/large.ts', `${largeFileContent('new')}\n`);
  },
  'quoted-path': async (cwd: string) => {
    const path = 'quoted\tpath.ts';
    await writeText(cwd, path, 'export const quoted = 1;\n');
    await commitAll(cwd);
    await writeText(cwd, path, 'export const quoted = 2;\n');
  },
  'non-ascii-path': async (cwd: string) => {
    await writeText(cwd, 'café.ts', 'export const value = 1;\n');
    await commitAll(cwd);
    await writeText(cwd, 'café.ts', 'export const value = 2;\n');
  },
  'crlf-file': async (cwd: string) => {
    await writeText(cwd, 'src/crlf.txt', 'old\r\n');
    await commitAll(cwd);
    await writeText(cwd, 'src/crlf.txt', 'new\r\n');
  },
  'submodule-change': async (cwd: string) => {
    const child = await initRepo();
    try {
      await writeText(child, 'lib.txt', 'child v1\n');
      await commitAll(child);
      await runGit(cwd, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        child,
        'vendor/sub',
      ]);
      await commitAll(cwd, 'add submodule');
      const submodule = join(cwd, 'vendor/sub');
      await runGit(submodule, ['config', 'user.name', 'Tester']);
      await runGit(submodule, ['config', 'user.email', 'tester@example.com']);
      await writeText(submodule, 'lib.txt', 'child v2\n');
      await commitAll(submodule, 'child v2');
    } finally {
      await rm(child, { recursive: true, force: true });
    }
  },
  'path-filter': async (cwd: string) => {
    await writeText(cwd, 'src/app.ts', 'export const app = 1;\n');
    await writeText(
      cwd,
      'src/generated/client.ts',
      'export const generated = 1;\n'
    );
    await writeText(cwd, 'test/app.test.ts', 'export const test = 1;\n');
    await commitAll(cwd);
    await writeText(cwd, 'src/app.ts', 'export const app = 2;\n');
    await writeText(
      cwd,
      'src/generated/client.ts',
      'export const generated = 2;\n'
    );
    await writeText(cwd, 'test/app.test.ts', 'export const test = 2;\n');
  },
} satisfies Record<string, (cwd: string) => Promise<void>>;

function deriveMetadata(patch: string): DiffMetadata {
  const isBinary =
    patch.includes('\nBinary files ') || patch.includes('\nGIT binary patch\n');
  const isRename = patch.includes('\nrename from ');
  const isDelete = patch.includes('\ndeleted file mode ');
  const isNewFile = patch.includes('\nnew file mode ');
  const isSubmodule = patch.includes('Subproject commit ');
  return {
    status: isSubmodule
      ? 'submodule'
      : isRename
        ? 'renamed'
        : isDelete
          ? 'deleted'
          : isNewFile
            ? 'added'
            : 'modified',
    isBinary,
    isRename,
    isDelete,
    isNewFile,
    isSubmodule,
    hasNoNewlineMarker: patch.includes('\\ No newline at end of file'),
    usesQuotedPath: patch.startsWith('diff --git "'),
    hasCarriageReturns: patch.includes('\r'),
  };
}

function normalizeAbsolutePath(cwd: string, absoluteFilePath: string): string {
  const normalizedRelativePath = relative(cwd, absoluteFilePath)
    .split(sep)
    .join('/');
  return `<repo>/${normalizedRelativePath}`;
}

function normalizeDiffContext(cwd: string, diff: DiffContext) {
  return {
    gitContext: diff.gitContext,
    chunks: diff.chunks.map((chunk) => ({
      file: chunk.file,
      absoluteFilePath: normalizeAbsolutePath(cwd, chunk.absoluteFilePath),
      changedLines: chunk.changedLines,
      metadata: deriveMetadata(chunk.patch),
    })),
  };
}

function normalizeRustChunks(
  cwd: string,
  chunks: Array<{
    file: string;
    absoluteFilePath: string;
    changedLines: number[];
    patch: string;
  }>
): ExpectedChunk[] {
  return chunks.map((chunk) => ({
    file: chunk.file,
    absoluteFilePath: normalizeAbsolutePath(cwd, chunk.absoluteFilePath),
    changedLines: chunk.changedLines,
    metadata: deriveMetadata(chunk.patch),
  }));
}

function matchesFixturePattern(file: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    return file.startsWith(pattern.slice(0, -2));
  }
  return file === pattern;
}

function applyFixtureFilters(
  files: string[],
  filters: CorpusFixture['filters'] | undefined
): string[] {
  if (!filters) {
    return files;
  }
  return files.filter((file) => {
    const included =
      !filters.includePaths ||
      filters.includePaths.some((pattern) =>
        matchesFixturePattern(file, pattern)
      );
    const excluded =
      filters.excludePaths?.some((pattern) =>
        matchesFixturePattern(file, pattern)
      ) ?? false;
    return included && !excluded;
  });
}

async function readCorpus(): Promise<CorpusFixture[]> {
  const content = await readFile(
    new URL('./fixtures/diff-corpus/expected.json', import.meta.url),
    'utf8'
  );
  return JSON.parse(content) as CorpusFixture[];
}

const corpus = await readCorpus();

describe('diff corpus conformance', () => {
  beforeAll(async () => {
    if (process.env.REVIEW_AGENT_RUST_DIFF_BENCH === '1') {
      await ensureRustDiffBinary();
    }
  }, 60000);

  it('decodes raw non-BMP characters in quoted paths', async () => {
    const cwd = '/repo';
    const smile = String.fromCodePoint(0x1f600);
    const file = `emoji-${smile}.ts`;
    const patch = [
      `diff --git "a/${file}" "b/${file}"`,
      'index 7898192..6178079 100644',
      `--- "a/${file}"`,
      `+++ "b/${file}"`,
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
    ].join('\n');

    const chunks = parseUnifiedDiff(cwd, patch);
    expect(chunks.map((chunk) => chunk.file)).toEqual([file]);
    expect(chunks.map((chunk) => chunk.absoluteFilePath)).toEqual([
      `${cwd}/${file}`,
    ]);

    if (process.env.REVIEW_AGENT_RUST_DIFF_BENCH === '1') {
      const rustChunks = await parseWithRustDiffCandidate(cwd, patch);
      expect(rustChunks.map((chunk) => chunk.file)).toEqual([file]);
      expect(rustChunks.map((chunk) => chunk.absoluteFilePath)).toEqual([
        `${cwd}/${file}`,
      ]);
    }
  });

  it('preserves invalid quoted octal escapes without truncating path bytes', async () => {
    const cwd = '/repo';
    const file = 'invalid-\\777.ts';
    const patch = [
      'diff --git "a/invalid-\\777.ts" "b/invalid-\\777.ts"',
      'index 7898192..6178079 100644',
      '--- "a/invalid-\\777.ts"',
      '+++ "b/invalid-\\777.ts"',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
    ].join('\n');

    const chunks = parseUnifiedDiff(cwd, patch);
    expect(chunks.map((chunk) => chunk.file)).toEqual([file]);
    expect(chunks.map((chunk) => chunk.absoluteFilePath)).toEqual([
      `${cwd}/${file}`,
    ]);

    if (process.env.REVIEW_AGENT_RUST_DIFF_BENCH === '1') {
      const rustChunks = await parseWithRustDiffCandidate(cwd, patch);
      expect(rustChunks.map((chunk) => chunk.file)).toEqual([file]);
      expect(rustChunks.map((chunk) => chunk.absoluteFilePath)).toEqual([
        `${cwd}/${file}`,
      ]);
    }
  });

  for (const fixture of corpus) {
    it(`matches ${fixture.name}`, async () => {
      const cwd = await initRepo();
      try {
        await builders[fixture.name](cwd);
        const diff = await collectDiffForTarget(cwd, {
          type: 'uncommittedChanges',
        });
        const actual = normalizeDiffContext(cwd, diff);

        expect(actual).toEqual({
          gitContext: fixture.expected.gitContext,
          chunks: fixture.expected.chunks,
        });
        expect(
          applyFixtureFilters(
            actual.chunks.map((chunk) => chunk.file),
            fixture.filters
          )
        ).toEqual(
          fixture.expected.filteredFiles ?? actual.chunks.map((c) => c.file)
        );

        if (process.env.REVIEW_AGENT_RUST_DIFF_BENCH === '1') {
          const rustChunks = await parseWithRustDiffCandidate(cwd, diff.patch);
          expect(normalizeRustChunks(cwd, rustChunks)).toEqual(
            fixture.expected.chunks
          );
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
});
