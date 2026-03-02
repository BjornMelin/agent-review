import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ReviewTarget } from '@review-agent/review-types';

const execFileAsync = promisify(execFile);

export type GitContext = {
  mode: 'uncommitted' | 'baseBranch' | 'commit' | 'custom';
  baseRef?: string;
  mergeBaseSha?: string;
  commitSha?: string;
};

export type DiffChunk = {
  file: string;
  absoluteFilePath: string;
  patch: string;
  changedLines: number[];
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

async function runGit(
  cwd: string,
  args: string[],
  options: GitExecOptions = {}
): Promise<string> {
  const allowExitCodes = new Set(options.allowExitCodes ?? [0]);
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
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
    throw new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`);
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

async function buildUntrackedFilePatch(
  cwd: string,
  relativePath: string
): Promise<string> {
  const absolutePath = resolve(cwd, relativePath);
  const bytes = await readFile(absolutePath);
  if (isBinaryBuffer(bytes)) {
    return [
      `diff --git a/${relativePath} b/${relativePath}`,
      'new file mode 100644',
      `Binary files /dev/null and b/${relativePath} differ`,
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
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${hunkLineCount} @@`,
    body,
    '',
  ].join('\n');
}

async function buildUncommittedPatch(cwd: string): Promise<string> {
  const [staged, unstaged, untrackedListRaw] = await Promise.all([
    runGit(cwd, ['diff', '--no-color', '--binary', '--staged']),
    runGit(cwd, ['diff', '--no-color', '--binary']),
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

function extractPathFromDiffHeader(line: string): string | null {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (!match) {
    return null;
  }
  return match[2] ?? match[1] ?? null;
}

function extractPathFromPlusHeader(line: string): string | null {
  if (!line.startsWith('+++ ')) {
    return null;
  }
  const candidate = line.slice(4).trim();
  if (candidate === '/dev/null') {
    return null;
  }
  return candidate.startsWith('b/') ? candidate.slice(2) : candidate;
}

function parseUnifiedDiff(cwd: string, patch: string): DiffChunk[] {
  if (!patch.trim()) {
    return [];
  }

  const chunks: DiffChunk[] = [];
  const lines = patch.split('\n');

  let currentFile = '';
  let currentPatch: string[] = [];
  let changedLines = new Set<number>();
  let newLineCursor = 0;
  let inHunk = false;

  const flush = () => {
    if (!currentFile || currentPatch.length === 0) {
      return;
    }
    chunks.push({
      file: currentFile,
      absoluteFilePath: resolve(cwd, currentFile),
      patch: currentPatch.join('\n').trimEnd(),
      changedLines: [...changedLines].sort((a, b) => a - b),
    });
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentPatch = [line];
      changedLines = new Set<number>();
      inHunk = false;
      newLineCursor = 0;
      currentFile = extractPathFromDiffHeader(line) ?? '';
      continue;
    }

    if (currentPatch.length === 0) {
      continue;
    }

    currentPatch.push(line);
    const plusHeaderPath = extractPathFromPlusHeader(line);
    if (plusHeaderPath) {
      currentFile = plusHeaderPath;
    }

    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch) {
      newLineCursor = Number.parseInt(hunkMatch[1] ?? '0', 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      changedLines.add(newLineCursor);
      newLineCursor += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      continue;
    }

    if (line.startsWith(' ')) {
      newLineCursor += 1;
      continue;
    }

    if (line.startsWith('\\ No newline at end of file')) {
      continue;
    }

    inHunk = false;
  }

  flush();
  return chunks;
}

export function buildChangedLineIndex(
  chunks: DiffChunk[]
): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  for (const chunk of chunks) {
    const key = resolve(chunk.absoluteFilePath);
    const set = index.get(key) ?? new Set<number>();
    for (const line of chunk.changedLines) {
      set.add(line);
    }
    index.set(key, set);
  }
  return index;
}

export function normalizeFilePath(cwd: string, filePath: string): string {
  return resolve(cwd, isAbsolute(filePath) ? filePath : resolve(cwd, filePath));
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
          '--no-color',
          '--binary',
          mergeBaseSha,
        ]);
      } else {
        patch = await runGit(cwd, [
          'diff',
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
