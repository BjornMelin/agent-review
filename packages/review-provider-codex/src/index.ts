import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  ProviderDiagnostic,
  ReviewProvider,
  ReviewProviderCapabilities,
  ReviewProviderRunInput,
  ReviewProviderRunOutput,
  ReviewProviderValidationInput,
  ReviewTarget,
} from '@review-agent/review-types';

const execFileAsync = promisify(execFile);

const CODEX_DOCTOR_TIMEOUT_MS = 10_000;
const CODEX_REVIEW_TIMEOUT_MS = 5 * 60_000;

function targetToArgs(target: ReviewTarget): string[] {
  switch (target.type) {
    case 'uncommittedChanges':
      return ['--uncommitted'];
    case 'baseBranch':
      return ['--base', target.branch];
    case 'commit': {
      const args = ['--commit', target.sha];
      if (target.title) {
        args.push('--title', target.title);
      }
      return args;
    }
    case 'custom':
      return [target.instructions];
    default:
      throw new Error(`unsupported review target: ${JSON.stringify(target)}`);
  }
}

export type CodexProviderOptions = {
  codexBin?: string;
};

export class CodexDelegateProvider implements ReviewProvider {
  id = 'codexDelegate' as const;
  private readonly codexBin: string;

  constructor(options: CodexProviderOptions = {}) {
    this.codexBin = options.codexBin ?? process.env.CODEX_BIN ?? 'codex';
  }

  capabilities(): ReviewProviderCapabilities {
    return {
      jsonSchemaOutput: false,
      reasoningControl: false,
      streaming: false,
    };
  }

  validateRequest(input: ReviewProviderValidationInput): ProviderDiagnostic[] {
    const diagnostics: ProviderDiagnostic[] = [];
    if (input.request.reasoningEffort) {
      diagnostics.push({
        code: 'unsupported_reasoning_effort',
        ok: false,
        severity: 'error',
        detail:
          'codexDelegate does not accept reasoning-effort controls for /review delegation',
        remediation: 'Omit --reasoning-effort when using --provider codex.',
      });
    }
    return diagnostics;
  }

  async doctor(): Promise<ProviderDiagnostic[]> {
    const diagnostics: ProviderDiagnostic[] = [];
    try {
      await execFileAsync(this.codexBin, ['--version'], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: CODEX_DOCTOR_TIMEOUT_MS,
      });
      diagnostics.push({
        code: 'provider_unavailable',
        ok: true,
        severity: 'info',
        detail: `codex binary is available at "${this.codexBin}"`,
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        diagnostics.push({
          code: 'binary_missing',
          ok: false,
          severity: 'error',
          detail: `codex binary "${this.codexBin}" was not found`,
          remediation:
            'Install Codex CLI or set CODEX_BIN to a valid executable path.',
        });
        return diagnostics;
      }
      diagnostics.push({
        code: 'provider_unavailable',
        ok: false,
        severity: 'error',
        detail: `codex binary check failed: ${err.message}`,
        remediation:
          'Verify codex CLI installation and executable permissions.',
      });
      return diagnostics;
    }

    const hasEnvToken = Boolean(
      process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY
    );
    const authPath = resolve(homedir() ?? process.cwd(), '.codex', 'auth.json');
    const hasAuthFile = await access(authPath)
      .then(() => true)
      .catch(() => false);
    if (hasEnvToken || hasAuthFile) {
      diagnostics.push({
        code: 'auth_available',
        ok: true,
        severity: 'info',
        detail: 'codex auth signal detected (env token or ~/.codex/auth.json)',
      });
    } else {
      diagnostics.push({
        code: 'auth_missing',
        ok: false,
        severity: 'error',
        detail: 'no Codex auth signal detected in env or ~/.codex/auth.json',
        remediation:
          'Run `codex` and sign in, or set CODEX_API_KEY/OPENAI_API_KEY.',
      });
    }

    return diagnostics;
  }

  async run(input: ReviewProviderRunInput): Promise<ReviewProviderRunOutput> {
    const tempDir = await mkdtemp(join(tmpdir(), 'review-agent-codex-'));
    const lastMessagePath = join(tempDir, 'last-message.txt');

    const args = [
      '--output-last-message',
      lastMessagePath,
      'review',
      ...targetToArgs(input.request.target),
    ];
    if (input.request.model) {
      args.unshift('--model', input.request.model);
    }

    try {
      const { stdout, stderr } = await execFileAsync(this.codexBin, args, {
        cwd: input.request.cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: CODEX_REVIEW_TIMEOUT_MS,
      });

      const outputText = (
        await readFile(lastMessagePath, 'utf8').catch(() => '')
      ).trim();
      const text = outputText || stdout.trim() || stderr.trim();

      let raw: unknown = null;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null;
      }

      return {
        raw,
        text,
        resolvedModel: input.request.model ?? 'codexDelegate:default',
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stderr?: string | Buffer;
        stdout?: string | Buffer;
      };
      const stderr = String(err.stderr ?? '').trim();
      const stdout = String(err.stdout ?? '').trim();
      const detail = stderr || stdout || err.message;
      throw new Error(`codex delegate failed: ${detail}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export function createCodexDelegateProvider(
  options: CodexProviderOptions = {}
): ReviewProvider {
  return new CodexDelegateProvider(options);
}
