import { execFile } from 'node:child_process';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_REVIEW_SECURITY_LIMITS,
  type ReviewRequest,
  type ReviewTarget,
  redactErrorMessage,
  withReviewRequestSecurityDefaults,
} from '@review-agent/review-types';
import { minimatch } from 'minimatch';
import {
  type DiffChunk,
  type DiffIndexOptions,
  indexDiffForReviewRequest,
} from './rust-diff-index.js';

export {
  type DiffChunk,
  type DiffIndexOptions,
  ensureRustDiffIndexBinary,
  indexDiffForReviewRequest,
  normalizeFilePath,
} from './rust-diff-index.js';

const execFileAsync = promisify(execFile);

/**
 * Git metadata describing how a diff was collected.
 */
export type GitContext = {
  mode: 'uncommitted' | 'baseBranch' | 'commit' | 'custom';
  baseRef?: string;
  mergeBaseSha?: string;
  commitSha?: string;
};

/**
 * Collected patch text, indexed diff chunks, changed lines, and git metadata.
 */
export type DiffContext = {
  patch: string;
  chunks: DiffChunk[];
  changedLineIndex: Map<string, Set<number>>;
  gitContext: GitContext;
};

type GitExecOptions = {
  allowExitCodes?: number[];
  maxBufferBytes?: number;
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
const MAX_UNTRACKED_PATH_BYTES = 4096;
const MIN_UNTRACKED_LIST_BUFFER_BYTES = 8 * 1024;
const MAX_UNTRACKED_LIST_BUFFER_BYTES = 16 * 1024 * 1024;

function assertSafeGitRevisionArgument(value: string, label: string): void {
  if (value.startsWith('-')) {
    throw new Error(`${label} must not start with "-"`);
  }
  if (value.includes('\0')) {
    throw new Error(`${label} must not contain NUL bytes`);
  }
  const segments = value.split('/');
  if (
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('..') ||
    value.includes('@{') ||
    value === '@' ||
    value.endsWith('.') ||
    segments.some(
      (segment) => segment.startsWith('.') || segment.endsWith('.lock')
    ) ||
    value.includes('//') ||
    /[\s~^:?*[\\]/.test(value)
  ) {
    throw new Error(`${label} must be a simple Git ref name`);
  }
}

function assertSafeGitObjectId(value: string, label: string): void {
  assertSafeGitRevisionArgument(value, label);
  if (!/^[0-9a-fA-F]{7,64}$/.test(value)) {
    throw new Error(`${label} must be a Git object id`);
  }
}

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
      maxBuffer: options.maxBufferBytes ?? 16 * 1024 * 1024,
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
      `git command failed: ${redactErrorMessage(stderr || err.message)}`
    );
  }
}

/**
 * Resolves HEAD for a repository when it exists.
 *
 * @param cwd - Repository working directory.
 * @returns HEAD object ID, or null when the repository has no HEAD.
 */
export async function resolveHead(cwd: string): Promise<string | null> {
  const out = await runGit(cwd, ['rev-parse', '--verify', 'HEAD'], {
    allowExitCodes: [0, 128],
  });
  return out.length > 0 ? out : null;
}

/**
 * Resolves a safe branch or ref name to an object ID.
 *
 * @param cwd - Repository working directory.
 * @param branch - Safe branch or ref name to resolve.
 * @returns Object ID for the ref, or null when it cannot be resolved.
 */
export async function resolveBranchRef(
  cwd: string,
  branch: string
): Promise<string | null> {
  assertSafeGitRevisionArgument(branch, 'branch');
  const out = await runGit(
    cwd,
    ['rev-parse', '--verify', '--end-of-options', branch],
    {
      allowExitCodes: [0, 128],
    }
  );
  return out.length > 0 ? out : null;
}

/**
 * Resolves the upstream ref when it is ahead of the local branch.
 *
 * @param cwd - Repository working directory.
 * @param branch - Safe local branch name.
 * @returns Upstream ref name when it is ahead, otherwise null.
 */
export async function resolveUpstreamIfRemoteAhead(
  cwd: string,
  branch: string
): Promise<string | null> {
  assertSafeGitRevisionArgument(branch, 'branch');
  const upstream = await runGit(
    cwd,
    [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '--end-of-options',
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

/**
 * Finds the merge base between HEAD and a safe branch ref.
 *
 * @param cwd - Repository working directory.
 * @param branch - Safe branch name to compare with HEAD.
 * @returns Merge-base object ID, or null when unavailable.
 */
export async function mergeBaseWithHead(
  cwd: string,
  branch: string
): Promise<string | null> {
  assertSafeGitRevisionArgument(branch, 'branch');
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
    ['merge-base', '--end-of-options', head, preferredBranchRef],
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
  relativePath: string,
  maxFileBytes: number | undefined
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
  if (maxFileBytes !== undefined && stats.size > maxFileBytes) {
    throw new Error('untracked file exceeds maxDiffBytes');
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

function assertPatchWithinBudget(
  patch: string,
  maxDiffBytes: number | undefined
): void {
  if (
    maxDiffBytes !== undefined &&
    Buffer.byteLength(patch, 'utf8') > maxDiffBytes
  ) {
    throw new Error('git diff exceeds maxDiffBytes');
  }
}

function joinedPatchByteLength(chunks: string[]): number {
  return chunks.reduce(
    (total, chunk, index) =>
      total + Buffer.byteLength(chunk, 'utf8') + (index === 0 ? 0 : 1),
    0
  );
}

function gitBufferOptions(options: DiffIndexOptions): GitExecOptions {
  return options.maxDiffBytes === undefined
    ? {}
    : { maxBufferBytes: options.maxDiffBytes };
}

function assertSafePathFilterArgument(value: string, label: string): void {
  const segments = value.split('/');
  if (
    value.startsWith('/') ||
    value.startsWith('~') ||
    value.startsWith('!') ||
    value.startsWith(':') ||
    value.includes('\\') ||
    value.includes('//') ||
    value.includes('\0') ||
    segments.includes('..') ||
    value === '.' ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error(`${label} must be a safe repository-relative path filter`);
  }
}

function gitPathspecArgs(options: DiffIndexOptions): string[] {
  const pathspecs: string[] = [];
  for (const [index, includePath] of (options.includePaths ?? []).entries()) {
    assertSafePathFilterArgument(includePath, `includePaths[${index}]`);
    pathspecs.push(`:(top,glob)${includePath}`);
  }
  for (const [index, excludePath] of (options.excludePaths ?? []).entries()) {
    assertSafePathFilterArgument(excludePath, `excludePaths[${index}]`);
    pathspecs.push(`:(top,exclude,glob)${excludePath}`);
  }
  return pathspecs.length > 0 ? ['--', ...pathspecs] : [];
}

function untrackedListBufferOptions(options: DiffIndexOptions): GitExecOptions {
  const maxFiles =
    options.maxFiles ?? DEFAULT_REVIEW_SECURITY_LIMITS.maxMaxFiles;
  return {
    maxBufferBytes: Math.min(
      MAX_UNTRACKED_LIST_BUFFER_BYTES,
      Math.max(
        MIN_UNTRACKED_LIST_BUFFER_BYTES,
        (maxFiles + 1) * (MAX_UNTRACKED_PATH_BYTES + 1)
      )
    ),
  };
}

function pathMatchesAnyFilter(
  relativePath: string,
  patterns: string[]
): boolean {
  return patterns.some((pattern) =>
    minimatch(relativePath, pattern, {
      dot: true,
      nonegate: true,
      nocomment: true,
      optimizationLevel: 0,
    })
  );
}

function untrackedPathMatchesFilters(
  relativePath: string,
  options: DiffIndexOptions
): boolean {
  if (
    options.includePaths?.length &&
    !pathMatchesAnyFilter(relativePath, options.includePaths)
  ) {
    return false;
  }
  if (
    options.excludePaths?.length &&
    pathMatchesAnyFilter(relativePath, options.excludePaths)
  ) {
    return false;
  }
  return true;
}

async function buildUncommittedPatch(
  cwd: string,
  options: DiffIndexOptions = {}
): Promise<string> {
  const gitOptions = gitBufferOptions(options);
  const pathspecArgs = gitPathspecArgs(options);
  let untrackedListRaw: string;
  try {
    untrackedListRaw = await runGit(
      cwd,
      ['ls-files', '--others', '--exclude-standard', '-z', ...pathspecArgs],
      untrackedListBufferOptions(options)
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('maxBuffer')) {
      throw new Error('untracked file list exceeds configured budget');
    }
    throw error;
  }
  const [staged, unstaged] = await Promise.all([
    runGit(
      cwd,
      [
        'diff',
        ...SAFE_DIFF_ARGS,
        '--no-color',
        '--binary',
        '--staged',
        ...pathspecArgs,
      ],
      gitOptions
    ),
    runGit(
      cwd,
      ['diff', ...SAFE_DIFF_ARGS, '--no-color', '--binary', ...pathspecArgs],
      gitOptions
    ),
  ]);

  const untrackedFiles = untrackedListRaw
    .split('\0')
    .filter((line) => line.length > 0)
    .filter((relativePath) =>
      untrackedPathMatchesFilters(relativePath, options)
    );
  if (
    options.maxFiles !== undefined &&
    untrackedFiles.length > options.maxFiles
  ) {
    throw new Error('untracked file count exceeds maxFiles');
  }
  const patchChunks = [staged, unstaged].filter(
    (chunk) => chunk.trim().length > 0
  );
  let patchBytes = joinedPatchByteLength(patchChunks);
  for (const relativePath of untrackedFiles) {
    const remainingBytes =
      options.maxDiffBytes === undefined
        ? undefined
        : options.maxDiffBytes - patchBytes - (patchChunks.length > 0 ? 1 : 0);
    if (remainingBytes !== undefined && remainingBytes <= 0) {
      throw new Error('git diff exceeds maxDiffBytes');
    }
    const untrackedPatch = await buildUntrackedFilePatch(
      cwd,
      relativePath,
      remainingBytes
    );
    if (untrackedPatch.trim().length === 0) {
      continue;
    }
    const separatorBytes = patchChunks.length > 0 ? 1 : 0;
    const nextPatchBytes =
      patchBytes + separatorBytes + Buffer.byteLength(untrackedPatch, 'utf8');
    if (
      options.maxDiffBytes !== undefined &&
      nextPatchBytes > options.maxDiffBytes
    ) {
      throw new Error('git diff exceeds maxDiffBytes');
    }
    patchChunks.push(untrackedPatch);
    patchBytes = nextPatchBytes;
  }

  const patch = patchChunks.join('\n');
  assertPatchWithinBudget(patch, options.maxDiffBytes);
  return patch;
}

/**
 * Collects and indexes the diff context for one review target.
 *
 * @param cwd - Repository working directory.
 * @param target - Review target to collect.
 * @param options - Optional path and budget constraints.
 * @returns Diff context with filtered patch, chunks, line index, and git metadata.
 */
export async function collectDiffForTarget(
  cwd: string,
  target: ReviewTarget,
  options: DiffIndexOptions = {}
): Promise<DiffContext> {
  let patch = '';
  let gitContext: GitContext;

  switch (target.type) {
    case 'uncommittedChanges': {
      patch = await buildUncommittedPatch(cwd, options);
      gitContext = { mode: 'uncommitted' };
      break;
    }
    case 'baseBranch': {
      assertSafeGitRevisionArgument(target.branch, 'target.branch');
      const mergeBaseSha = await mergeBaseWithHead(cwd, target.branch);
      if (mergeBaseSha) {
        patch = await runGit(
          cwd,
          [
            'diff',
            ...SAFE_DIFF_ARGS,
            '--no-color',
            '--binary',
            '--end-of-options',
            mergeBaseSha,
            ...gitPathspecArgs(options),
          ],
          gitBufferOptions(options)
        );
      } else {
        patch = await runGit(
          cwd,
          [
            'diff',
            ...SAFE_DIFF_ARGS,
            '--no-color',
            '--binary',
            '--end-of-options',
            target.branch,
            ...gitPathspecArgs(options),
          ],
          gitBufferOptions(options)
        );
      }
      assertPatchWithinBudget(patch, options.maxDiffBytes);
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
      assertSafeGitObjectId(target.sha, 'target.sha');
      const commitSha = await runGit(cwd, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${target.sha}^{commit}`,
      ]);
      patch = await runGit(
        cwd,
        [
          'show',
          ...SAFE_DIFF_ARGS,
          '--no-color',
          '--binary',
          '--format=',
          '--end-of-options',
          commitSha,
          ...gitPathspecArgs(options),
        ],
        gitBufferOptions(options)
      );
      assertPatchWithinBudget(patch, options.maxDiffBytes);
      gitContext = {
        mode: 'commit',
        commitSha,
      };
      break;
    }
    case 'custom': {
      patch = await buildUncommittedPatch(cwd, options);
      gitContext = { mode: 'custom' };
      break;
    }
  }

  const indexed = await indexDiffForReviewRequest(
    {
      cwd,
      target,
      provider: 'codexDelegate',
      executionMode: 'localTrusted',
      outputFormats: ['json'],
      ...options,
    },
    patch
  );
  return {
    patch: indexed.patch,
    chunks: indexed.chunks,
    changedLineIndex: indexed.changedLineIndex,
    gitContext,
  };
}

/**
 * Collects the diff context for a review request with security defaults applied.
 *
 * @param request - Review request with target and optional diff constraints.
 * @returns Diff context with filtered patch, chunks, line index, and git metadata.
 */
export async function collectDiffForReviewRequest(
  request: ReviewRequest
): Promise<DiffContext> {
  const boundedRequest = withReviewRequestSecurityDefaults(
    request,
    DEFAULT_REVIEW_SECURITY_LIMITS
  );
  const options: DiffIndexOptions = {};
  if (boundedRequest.excludePaths) {
    options.excludePaths = boundedRequest.excludePaths;
  }
  if (boundedRequest.includePaths) {
    options.includePaths = boundedRequest.includePaths;
  }
  if (boundedRequest.maxDiffBytes) {
    options.maxDiffBytes = boundedRequest.maxDiffBytes;
  }
  if (boundedRequest.maxFiles) {
    options.maxFiles = boundedRequest.maxFiles;
  }
  return collectDiffForTarget(
    boundedRequest.cwd,
    boundedRequest.target,
    options
  );
}
