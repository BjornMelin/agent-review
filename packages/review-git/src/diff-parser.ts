import { resolve } from 'node:path';

/**
 * Represents a parsed chunk of a git diff for a specific file.
 */
export type DiffChunk = {
  /** Repository-relative path for the changed file. */
  file: string;
  /** Absolute path for the changed file. */
  absoluteFilePath: string;
  /** Per-file unified diff patch text. */
  patch: string;
  /** Sorted one-based changed line numbers in the target file. */
  changedLines: number[];
};

function decodeGitQuotedPath(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    const char = codePoint === undefined ? '' : String.fromCodePoint(codePoint);
    index += char.length || 1;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }

    const escapedCodePoint = value.codePointAt(index);
    const escapedValue =
      escapedCodePoint === undefined
        ? ''
        : String.fromCodePoint(escapedCodePoint);
    index += escapedValue.length || 1;
    if (/^[0-7]$/.test(escapedValue)) {
      let octal = escapedValue;
      while (octal.length < 3 && /^[0-7]$/.test(value[index] ?? '')) {
        octal += value[index];
        index += 1;
      }
      const byte = Number.parseInt(octal, 8);
      if (byte > 0xff) {
        bytes.push(...Buffer.from(`\\${octal}`, 'utf8'));
        continue;
      }
      bytes.push(byte);
      continue;
    }

    switch (escapedValue) {
      case '\\':
        bytes.push(0x5c);
        break;
      case '"':
        bytes.push(0x22);
        break;
      case 'a':
        bytes.push(0x07);
        break;
      case 'b':
        bytes.push(0x08);
        break;
      case 'f':
        bytes.push(0x0c);
        break;
      case 'n':
        bytes.push(0x0a);
        break;
      case 'r':
        bytes.push(0x0d);
        break;
      case 't':
        bytes.push(0x09);
        break;
      case 'v':
        bytes.push(0x0b);
        break;
      default:
        bytes.push(...Buffer.from(escapedValue, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseQuotedGitPath(
  input: string,
  start = 0
): { value: string; end: number } | null {
  if (input[start] !== '"') {
    return null;
  }

  let escaped = false;
  for (let index = start + 1; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      return {
        value: decodeGitQuotedPath(input.slice(start + 1, index)),
        end: index + 1,
      };
    }
  }

  return null;
}

function parseHeaderPath(input: string): string {
  const trimmed = input.trim();
  const quoted = parseQuotedGitPath(trimmed);
  if (quoted) {
    return quoted.value;
  }

  return (trimmed.split('\t')[0] ?? trimmed).trimEnd();
}

function stripDiffSidePrefix(path: string): string {
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

function parseUnquotedDiffHeaderPaths(
  input: string
): { source: string; target: string } | null {
  if (!input.startsWith('a/')) {
    return null;
  }

  const candidates: Array<{ source: string; target: string }> = [];
  let targetStart = input.indexOf(' b/');
  while (targetStart >= 0) {
    candidates.push({
      source: input.slice(2, targetStart),
      target: input.slice(targetStart + 3),
    });
    targetStart = input.indexOf(' b/', targetStart + 1);
  }

  return (
    candidates.find((candidate) => candidate.source === candidate.target) ??
    candidates.at(-1) ??
    null
  );
}

function extractPathFromDiffHeader(line: string): string | null {
  const prefix = 'diff --git ';
  if (!line.startsWith(prefix)) {
    return null;
  }

  const rest = line.slice(prefix.length);
  if (rest.startsWith('"')) {
    const source = parseQuotedGitPath(rest);
    if (!source) {
      return null;
    }
    const target = parseHeaderPath(rest.slice(source.end));
    return stripDiffSidePrefix(target);
  }

  return parseUnquotedDiffHeaderPaths(rest)?.target ?? null;
}

function extractPathFromFileHeader(line: string, prefix: '--- ' | '+++ ') {
  if (!line.startsWith(prefix)) {
    return null;
  }
  const candidate = parseHeaderPath(line.slice(prefix.length));
  if (candidate === '/dev/null') {
    return null;
  }
  return stripDiffSidePrefix(candidate);
}

function extractPathFromRenameHeader(line: string): string | null {
  if (!line.startsWith('rename to ') && !line.startsWith('copy to ')) {
    return null;
  }
  return parseHeaderPath(line.slice(line.indexOf(' to ') + 4));
}

/**
 * Parses unified diff text into per-file chunks with changed line tracking.
 *
 * @param cwd Working directory used to resolve absolute file paths.
 * @param patch Unified diff text to parse.
 * @returns Parsed diff chunks, one per file in the diff.
 */
export function parseUnifiedDiff(cwd: string, patch: string): DiffChunk[] {
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
      patch: currentPatch.join('\n'),
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
    const minusHeaderPath = extractPathFromFileHeader(line, '--- ');
    if (minusHeaderPath) {
      currentFile = minusHeaderPath;
    }
    const plusHeaderPath = extractPathFromFileHeader(line, '+++ ');
    if (plusHeaderPath) {
      currentFile = plusHeaderPath;
    }
    const renameHeaderPath = extractPathFromRenameHeader(line);
    if (renameHeaderPath) {
      currentFile = renameHeaderPath;
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

    if (line === '') {
      continue;
    }

    inHunk = false;
  }

  flush();
  return chunks;
}

/**
 * Builds an index from absolute file paths to changed line numbers.
 *
 * @param chunks Diff chunks whose changed lines should be indexed.
 * @returns Map from resolved absolute file path to changed line numbers.
 */
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

/**
 * Normalizes a file path to an absolute path relative to the working directory.
 *
 * @param cwd Working directory used for relative path resolution.
 * @param filePath Absolute or relative file path to normalize.
 * @returns Resolved absolute file path.
 */
export function normalizeFilePath(cwd: string, filePath: string): string {
  return resolve(cwd, filePath);
}
