import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const binaryName =
  process.platform === 'win32' ? 'review-git-diff.exe' : 'review-git-diff';

let buildPromise: Promise<string> | undefined;

/**
 * Parsed diff chunk returned by the Rust parser candidate.
 */
export type RustDiffChunk = {
  /** Repository-relative path for the changed file. */
  file: string;
  /** Absolute path for the changed file. */
  absoluteFilePath: string;
  /** Per-file unified diff patch text. */
  patch: string;
  /** Sorted one-based changed line numbers in the target file. */
  changedLines: number[];
};

/**
 * Builds the Rust diff parser candidate once for the current test process.
 *
 * @returns Promise for the absolute path to the built parser binary.
 */
export async function ensureRustDiffBinary(): Promise<string> {
  buildPromise ??= execFileAsync(
    'cargo',
    ['build', '--quiet', '--locked', '-p', 'review-git-diff'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    }
  )
    .then(() => join(repoRoot, 'target', 'debug', binaryName))
    .catch((error: unknown) => {
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
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

/**
 * Parses unified diff text with the Rust parser candidate.
 *
 * @param cwd Repository root used to resolve absolute file paths.
 * @param patch Unified diff text to parse.
 * @returns Parsed diff chunks from the Rust helper.
 */
export async function parseWithRustDiffCandidate(
  cwd: string,
  patch: string
): Promise<RustDiffChunk[]> {
  const binary = await ensureRustDiffBinary();
  const stdout = await runWithStdin(binary, ['parse', '--cwd', cwd], patch);
  return JSON.parse(stdout) as RustDiffChunk[];
}
