import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewProviderCommandRunError } from '@review-agent/review-types';
import { describe, expect, it } from 'vitest';
import { CodexDelegateProvider } from './index.js';

const REVIEW_OUTPUT = {
  findings: [],
  overall_correctness: 'patch is correct',
  overall_explanation: 'ok',
  overall_confidence_score: 0.95,
};

async function makeMockCodexBinary(
  dir: string
): Promise<{ bin: string; argsLogPath: string }> {
  const bin = join(dir, 'codex-mock.sh');
  const argsLogPath = join(dir, 'args.log');
  const script = `#!/usr/bin/env bash
set -euo pipefail
args_log="${argsLogPath}"
printf "%s\\n" "$@" > "$args_log"
last_message=""
for ((i=1;i<=$#;i++)); do
  value="\${!i}"
  if [[ "$value" == "--output-last-message" ]]; then
    j=$((i+1))
    last_message="\${!j}"
  fi
done
cat > "$last_message" <<'JSON'
${JSON.stringify(REVIEW_OUTPUT)}
JSON
`;
  await writeFile(bin, script, 'utf8');
  await chmod(bin, 0o755);
  return { bin, argsLogPath };
}

async function makeFailingCodexBinary(dir: string): Promise<string> {
  const bin = join(dir, 'codex-fail.sh');
  const script = `#!/usr/bin/env bash
set -euo pipefail
echo "codex rejected input" >&2
exit 2
`;
  await writeFile(bin, script, 'utf8');
  await chmod(bin, 0o755);
  return bin;
}

describe('codex provider contract', () => {
  it('maps targets to codex review args and parses last message json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-provider-codex-'));
    try {
      const { bin, argsLogPath } = await makeMockCodexBinary(dir);
      const provider = new CodexDelegateProvider({ codexBin: bin });

      const run = await provider.run({
        request: {
          cwd: process.cwd(),
          target: { type: 'commit', sha: 'abc123', title: 'Fix parser' },
          provider: 'codexDelegate',
          executionMode: 'localTrusted',
          outputFormats: ['json'],
          model: 'gpt-5',
        },
        resolvedPrompt: 'prompt',
        rubric: 'rubric',
        normalizedDiffChunks: [],
      });

      expect(run.raw).toEqual(REVIEW_OUTPUT);
      expect(run.text).toContain('patch is correct');
      expect(run.commandRun?.status).toBe('completed');
      expect(run.commandRun?.commandId).toBe('codex-review');
      expect(run.commandRun?.files[0]?.key).toBe('lastMessage');
      expect(
        run.commandRun?.events.some((event) => event.type === 'tempDirCleaned')
      ).toBe(true);

      const args = (await readFile(argsLogPath, 'utf8'))
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(args).toContain('--model');
      expect(args).toContain('gpt-5');
      expect(args).toContain('review');
      expect(args).toContain('--commit');
      expect(args).toContain('abc123');
      expect(args).toContain('--title');
      expect(args).toContain('Fix parser');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('raises provider errors with runner stderr when codex exits nonzero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-provider-codex-'));
    try {
      const bin = await makeFailingCodexBinary(dir);
      const provider = new CodexDelegateProvider({ codexBin: bin });

      const run = provider.run({
        request: {
          cwd: process.cwd(),
          target: { type: 'uncommittedChanges' },
          provider: 'codexDelegate',
          executionMode: 'localTrusted',
          outputFormats: ['json'],
        },
        resolvedPrompt: 'prompt',
        rubric: 'rubric',
        normalizedDiffChunks: [],
      });

      await expect(run).rejects.toThrow(
        /codex delegate failed: codex rejected input/
      );
      await expect(run).rejects.toMatchObject({
        commandRun: {
          commandId: 'codex-review',
          status: 'completed',
          exitCode: 2,
        },
      });
      await expect(run).rejects.toBeInstanceOf(ReviewProviderCommandRunError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('raises provider errors with runner status when codex output is capped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-provider-codex-'));
    try {
      const bin = join(dir, 'codex-noisy.sh');
      const script = `#!/usr/bin/env bash
dd if=/dev/zero bs=1048576 count=17 2>/dev/null | tr '\\0' x
`;
      await writeFile(bin, script, 'utf8');
      await chmod(bin, 0o755);
      const provider = new CodexDelegateProvider({ codexBin: bin });

      const run = provider.run({
        request: {
          cwd: process.cwd(),
          target: { type: 'uncommittedChanges' },
          provider: 'codexDelegate',
          executionMode: 'localTrusted',
          outputFormats: ['json'],
        },
        resolvedPrompt: 'prompt',
        rubric: 'rubric',
        normalizedDiffChunks: [],
      });

      await expect(run).rejects.toMatchObject({
        commandRun: {
          commandId: 'codex-review',
          status: 'outputLimitExceeded',
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns deterministic doctor diagnostics for missing binary', async () => {
    const provider = new CodexDelegateProvider({
      codexBin: '/definitely/missing/codex',
    });
    const diagnostics = await provider.doctor();

    expect(
      diagnostics.some((item) => item.code === 'binary_missing' && !item.ok)
    ).toBe(true);
  });

  it('flags unsupported reasoning effort in validateRequest', () => {
    const provider = new CodexDelegateProvider({ codexBin: 'codex' });
    const diagnostics = provider.validateRequest({
      request: {
        cwd: process.cwd(),
        target: { type: 'uncommittedChanges' },
        provider: 'codexDelegate',
        executionMode: 'localTrusted',
        outputFormats: ['json'],
        reasoningEffort: 'high',
      },
      capabilities: provider.capabilities(),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('unsupported_reasoning_effort');
    expect(diagnostics[0]?.ok).toBe(false);
  });
});
