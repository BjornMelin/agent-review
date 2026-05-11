import { execFile } from 'node:child_process';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ReviewTarget } from '@review-agent/review-types';
import {
  buildChangedLineIndex,
  type DiffChunk,
  parseUnifiedDiff,
} from './diff-parser.js';

export {
  buildChangedLineIndex,
  type DiffChunk,
  normalizeFilePath,
} from './diff-parser.js';

const execFileAsync = promisify(execFile);

export type GitContext = {
  mode: 'uncommitted' | 'baseBranch' | 'commit' | 'custom';
  baseRef?: string;
  mergeBaseSha?: string;
  commitSha?: string;
};

export type DiffContext = {
  patch: string;
  chunks: DiffChunk[];
  changedLineIndex: Map<string, Set<number>>;
  gitContext: GitContext;
};

type GitExecOptions = {
  allowExitCodes?: number[];
};

const SAFE_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_EXTERNAL_DIFF: '',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
} as const;

const SAFE_DIFF_ARGS = ['--no-ext-diff', '--no-textconv'] as const;

async function runGit(
  cwd: string,
  args: string[],
  options: GitExecOptions = {}
): Promise<string> {
  const allowExitCodes = new Set(options.allowExitCodes ?? [0]);
  try {
    const { stdout } = await execFileAsync('git', ['--no-pager', ...args], {
      cwd,
      env: {
        ...process.env,
        ...SAFE_GIT_ENV,
      },
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout.trimEnd();
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const statusCode = typeof err.code === 'number' ? err.code : undefined;
    if (statusCode !== undefined && allowExitCodes.has(statusCode)) {
      return String(err.stdout ?? '').trimEnd();
    }
    const stderr = String(err.stderr ?? '').trim();
    throw new Error(
      `git --no-pager ${args.join(' ')} failed: ${stderr || err.message}`
    );
  }
}

export async function resolveHead(cwd: string): Promise<string | null> {
  const out = await runGit(cwd, ['rev-parse', '--verify', 'HEAD'], {
    allowExitCodes: [0, 128],
  });
  return out.length > 0 ? out : null;
}

export async function resolveBranchRef(
  cwd: string,
  branch: string
): Promise<string | null> {
  const out = await runGit(cwd, ['rev-parse', '--verify', branch], {
    allowExitCodes: [0, 128],
  });
  return out.length > 0 ? out : null;
}

export async function resolveUpstreamIfRemoteAhead(
  cwd: string,
  branch: string
): Promise<string | null> {
  const upstream = await runGit(
    cwd,
    [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      `${branch}@{upstream}`,
    ],
    { allowExitCodes: [0, 128] }
  );
  if (!upstream) {
    return null;
  }

  const counts = await runGit(
    cwd,
    ['rev-list', '--left-right', '--count', `${branch}...${upstream}`],
    {
      allowExitCodes: [0, 128],
    }
  );

  if (!counts) {
    return null;
  }

  const parts = counts.split(/\s+/);
  const right = Number.parseInt(parts[1] ?? '0', 10);
  if (Number.isNaN(right) || right <= 0) {
    return null;
  }
  return upstream;
}

export async function mergeBaseWithHead(
  cwd: string,
  branch: string
): Promise<string | null> {
  const head = await resolveHead(cwd);
  if (!head) {
    return null;
  }

  const localBranchRef = await resolveBranchRef(cwd, branch);
  if (!localBranchRef) {
    return null;
  }

  const preferredRef =
    (await resolveUpstreamIfRemoteAhead(cwd, branch)) ?? branch;
  const preferredBranchRef =
    (await resolveBranchRef(cwd, preferredRef)) ?? localBranchRef;

  const mergeBase = await runGit(
    cwd,
    ['merge-base', head, preferredBranchRef],
    {
      allowExitCodes: [0, 1, 128],
    }
  );
  return mergeBase || null;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function encodeGitQuotedPath(path: string): string {
  let encoded = '';
  for (const char of path) {
    switch (char) {
      case '\\':
        encoded += '\\\\';
        break;
      case '"':
        encoded += '\\"';
        break;
      case '\n':
        encoded += '\\n';
        break;
      case '\r':
        encoded += '\\r';
        break;
      case '\t':
        encoded += '\\t';
        break;
      case '\b':
        encoded += '\\b';
        break;
      case '\f':
        encoded += '\\f';
        break;
      case '\v':
        encoded += '\\v';
        break;
      default: {
        const codePoint = char.codePointAt(0) ?? 0;
        if (codePoint > 0x7f) {
          encoded += [...Buffer.from(char, 'utf8')]
            .map((byte) => `\\${byte.toString(8).padStart(3, '0')}`)
            .join('');
          break;
        }
        encoded +=
          codePoint < 0x20 || codePoint === 0x7f
            ? `\\${codePoint.toString(8).padStart(3, '0')}`
            : char;
        break;
      }
    }
  }
  return `"${encoded}"`;
}

function needsGitDiffPathQuoting(path: string): boolean {
  for (const char of path) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (
      char === '\\' ||
      char === '"' ||
      char === ' ' ||
      codePoint < 0x20 ||
      codePoint === 0x7f ||
      codePoint >= 0x80
    ) {
      return true;
    }
  }
  return false;
}

function formatGitDiffPath(side: 'a' | 'b', relativePath: string): string {
  const path = `${side}/${relativePath}`;
  return needsGitDiffPathQuoting(path) ? encodeGitQuotedPath(path) : path;
}

function encodeSyntheticPatchLineContent(value: string): string {
  return [...value]
    .map((char) => {
      switch (char) {
        case '\\':
          return '\\\\';
        case '\n':
          return '\\n';
        case '\r':
          return '\\r';
        case '\t':
          return '\\t';
        case '\b':
          return '\\b';
        case '\f':
          return '\\f';
        case '\v':
          return '\\v';
        default:
          return char;
      }
    })
    .join('');
}

function assertPathContained(
  root: string,
  candidate: string,
  label: string
): void {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`${label} escapes repository root`);
  }
}

function buildUntrackedSymlinkPatch(
  relativePath: string,
  linkTarget: string
): string {
  const oldPath = formatGitDiffPath('a', relativePath);
  const newPath = formatGitDiffPath('b', relativePath);
  return [
    `diff --git ${oldPath} ${newPath}`,
    'new file mode 120000',
    '--- /dev/null',
    `+++ ${newPath}`,
    '@@ -0,0 +1 @@',
    `+${encodeSyntheticPatchLineContent(linkTarget)}`,
    '\\ No newline at end of file',
    '',
  ].join('\n');
}

async function buildUntrackedFilePatch(
  cwd: string,
  relativePath: string
): Promise<string> {
  const root = await realpath(cwd);
  const absolutePath = resolve(root, relativePath);
  assertPathContained(root, absolutePath, 'untracked file path');
  const stats = await lstat(absolutePath);

  if (stats.isSymbolicLink()) {
    return buildUntrackedSymlinkPatch(
      relativePath,
      await readlink(absolutePath)
    );
  }

  if (!stats.isFile()) {
    return '';
  }

  const resolvedPath = await realpath(absolutePath);
  assertPathContained(root, resolvedPath, 'untracked file realpath');

  const oldPath = formatGitDiffPath('a', relativePath);
  const newPath = formatGitDiffPath('b', relativePath);
  const bytes = await readFile(absolutePath);
  if (isBinaryBuffer(bytes)) {
    return [
      `diff --git ${oldPath} ${newPath}`,
      'new file mode 100644',
      `Binary files /dev/null and ${newPath} differ`,
      '',
    ].join('\n');
  }

  const text = bytes.toString('utf8');
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  const body = lines.map((line) => `+${line}`).join('\n');
  const hunkLineCount = lines.length;
  return [
    `diff --git ${oldPath} ${newPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ ${newPath}`,
    `@@ -0,0 +1,${hunkLineCount} @@`,
    body,
    '',
  ].join('\n');
}

async function buildUncommittedPatch(cwd: string): Promise<string> {
  const [staged, unstaged, untrackedListRaw] = await Promise.all([
    runGit(cwd, [
      'diff',
      ...SAFE_DIFF_ARGS,
      '--no-color',
      '--binary',
      '--staged',
    ]),
    runGit(cwd, ['diff', ...SAFE_DIFF_ARGS, '--no-color', '--binary']),
    runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);

  const untrackedFiles = untrackedListRaw
    .split('\0')
    .filter((line) => line.length > 0);
  const untrackedPatches = await Promise.all(
    untrackedFiles.map((relativePath) =>
      buildUntrackedFilePatch(cwd, relativePath)
    )
  );

  return [staged, unstaged, ...untrackedPatches]
    .filter((chunk) => chunk.trim().length > 0)
    .join('\n');
}

export async function collectDiffForTarget(
  cwd: string,
  target: ReviewTarget
): Promise<DiffContext> {
  let patch = '';
  let gitContext: GitContext;

  switch (target.type) {
    case 'uncommittedChanges': {
      patch = await buildUncommittedPatch(cwd);
      gitContext = { mode: 'uncommitted' };
      break;
    }
    case 'baseBranch': {
      const mergeBaseSha = await mergeBaseWithHead(cwd, target.branch);
      if (mergeBaseSha) {
        patch = await runGit(cwd, [
          'diff',
          ...SAFE_DIFF_ARGS,
          '--no-color',
          '--binary',
          mergeBaseSha,
        ]);
      } else {
        patch = await runGit(cwd, [
          'diff',
          ...SAFE_DIFF_ARGS,
          '--no-color',
          '--binary',
          target.branch,
        ]);
      }
      const context: GitContext = {
        mode: 'baseBranch',
        baseRef: target.branch,
      };
      if (mergeBaseSha) {
        context.mergeBaseSha = mergeBaseSha;
      }
      gitContext = context;
      break;
    }
    case 'commit': {
      patch = await runGit(cwd, [
        'show',
        ...SAFE_DIFF_ARGS,
        '--no-color',
        '--binary',
        '--format=',
        target.sha,
      ]);
      gitContext = {
        mode: 'commit',
        commitSha: target.sha,
      };
      break;
    }
    case 'custom': {
      patch = await buildUncommittedPatch(cwd);
      gitContext = { mode: 'custom' };
      break;
    }
  }

  const chunks = parseUnifiedDiff(cwd, patch);
  return {
    patch,
    chunks,
    changedLineIndex: buildChangedLineIndex(chunks),
    gitContext,
  };
}
