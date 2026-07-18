import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  type DiffChunk,
  type DiffIndexOutput,
  DiffIndexOutputSchema,
  type ReviewRequest,
} from '@review-agent/review-types';

export type { DiffChunk } from '@review-agent/review-types';

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(packageRoot, '../..');
const binaryName =
  process.platform === 'win32' ? 'review-git-diff.exe' : 'review-git-diff';
const packagedBinary = join(packageRoot, 'dist', 'bin', binaryName);
const targetDir = process.env.CARGO_TARGET_DIR
  ? resolve(repoRoot, process.env.CARGO_TARGET_DIR)
  : join(repoRoot, 'target');
const configuredBinary = process.env.REVIEW_AGENT_DIFF_INDEX_BIN;
const buildTimeoutMs = parsePositiveIntegerEnv(
  'REVIEW_AGENT_DIFF_INDEX_BUILD_TIMEOUT_MS',
  120_000
);
const runTimeoutMs = parsePositiveIntegerEnv(
  'REVIEW_AGENT_DIFF_INDEX_TIMEOUT_MS',
  30_000
);
const maxStdoutBytes = parsePositiveIntegerEnv(
  'REVIEW_AGENT_DIFF_INDEX_MAX_STDOUT_BYTES',
  64 * 1024 * 1024
);
const maxStderrBytes = parsePositiveIntegerEnv(
  'REVIEW_AGENT_DIFF_INDEX_MAX_STDERR_BYTES',
  1024 * 1024
);

let buildPromise: Promise<string> | undefined;

/**
 * Diff filter options sourced from the canonical review request contract.
 */
export type DiffIndexOptions = Pick<
  ReviewRequest,
  'excludePaths' | 'includePaths' | 'maxDiffBytes' | 'maxFiles'
>;

export type DiffIndexResult = {
  patch: string;
  chunks: DiffChunk[];
  changedLineIndex: Map<string, Set<number>>;
};

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function decodeChangedLineIndex(
  entries: DiffIndexOutput['changedLineIndex']
): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  for (const entry of entries) {
    index.set(resolve(entry.absoluteFilePath), new Set(entry.changedLines));
  }
  return index;
}

function encodeDiffIndexRequest(request: ReviewRequest, patch: string): string {
  return JSON.stringify({
    request: { ...request, cwd: resolve(request.cwd) },
    patch,
  });
}

async function canExecute(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function buildRustDiffIndexBinary(): Promise<string> {
  await execFileAsync(
    'cargo',
    ['build', '--quiet', '--locked', '-p', 'review-git-diff'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: buildTimeoutMs,
    }
  );
  return join(targetDir, 'debug', binaryName);
}

async function resolveRustDiffIndexBinary(): Promise<string> {
  const candidates = [
    ...(configuredBinary ? [resolve(configuredBinary)] : []),
    packagedBinary,
    join(targetDir, 'debug', binaryName),
    join(targetDir, 'release', binaryName),
  ];
  for (const candidate of candidates) {
    if (await canExecute(candidate)) {
      return candidate;
    }
  }

  if (process.env.REVIEW_AGENT_DIFF_INDEX_ALLOW_BUILD === '1') {
    const builtBinary = await buildRustDiffIndexBinary();
    if (await canExecute(builtBinary)) {
      return builtBinary;
    }
  }

  throw new Error(
    'Rust diff-index helper binary was not found. Run `pnpm --filter @review-agent/review-git build:rust`, set REVIEW_AGENT_DIFF_INDEX_BIN, or set REVIEW_AGENT_DIFF_INDEX_ALLOW_BUILD=1 for a development-only build fallback.'
  );
}

/**
 * Builds the Rust diff-index helper once for the current Node process.
 *
 * @returns Absolute path to the helper binary.
 */
export async function ensureRustDiffIndexBinary(): Promise<string> {
  buildPromise ??= resolveRustDiffIndexBinary().catch((error: unknown) => {
    buildPromise = undefined;
    throw error;
  });
  return buildPromise;
}

async function runWithStdin(
  command: string,
  args: string[],
  input: string
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimitError: Error | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, runTimeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (outputLimitError) {
        return;
      }
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes + chunkBytes > maxStdoutBytes) {
        outputLimitError = new Error(
          `${command} ${args.join(' ')} exceeded stdout limit ${maxStdoutBytes} bytes`
        );
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk;
      stdoutBytes += chunkBytes;
    });
    child.stderr.on('data', (chunk) => {
      if (outputLimitError) {
        return;
      }
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (stderrBytes + chunkBytes > maxStderrBytes) {
        outputLimitError = new Error(
          `${command} ${args.join(' ')} exceeded stderr limit ${maxStderrBytes} bytes`
        );
        child.kill('SIGKILL');
        return;
      }
      stderr += chunk;
      stderrBytes += chunkBytes;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `${command} ${args.join(' ')} timed out after ${runTimeoutMs}ms`
          )
        );
        return;
      }
      if (outputLimitError) {
        reject(outputLimitError);
        return;
      }
      if (code === 0) {
        resolveOutput(stdout);
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed with ${signal ?? code}: ${stderr.trim()}`
        )
      );
    });
    child.stdin.end(input);
  });
}

/**
 * Parses, filters, and indexes unified diff text with the Rust helper.
 *
 * @param request Canonical review request that supplies cwd and filters.
 * @param patch Unified diff text to parse.
 * @returns Filtered diff context pieces.
 */
export async function indexDiffForReviewRequest(
  request: ReviewRequest,
  patch: string
): Promise<DiffIndexResult> {
  const binary = await ensureRustDiffIndexBinary();
  const stdout = await runWithStdin(
    binary,
    ['index'],
    encodeDiffIndexRequest(request, patch)
  );
  const output = DiffIndexOutputSchema.parse(JSON.parse(stdout));
  return {
    patch: output.patch,
    chunks: output.chunks,
    changedLineIndex: decodeChangedLineIndex(output.changedLineIndex),
  };
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
