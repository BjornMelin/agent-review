import { randomUUID } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import { type NetworkPolicy, Sandbox } from '@vercel/sandbox';
import { z } from 'zod';

export const NetworkProfileSchema = z.enum([
  'deny_all',
  'bootstrap_then_deny',
  'allowlist_only',
]);

export const SandboxBudgetSchema = z.strictObject({
  maxWallTimeMs: z.number().int().positive(),
  maxCommandTimeoutMs: z.number().int().positive(),
  maxCommandCount: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
  maxArtifactBytes: z.number().int().positive(),
});

const SANDBOX_ROOT = '/vercel/sandbox';
const DEFAULT_SANDBOX_RUNTIME = 'node24';

function sanitizeSandboxCwd(cwd: string): string {
  const resolved = resolve(SANDBOX_ROOT, cwd);
  if (
    resolved !== SANDBOX_ROOT &&
    !resolved.startsWith(`${SANDBOX_ROOT}${sep}`)
  ) {
    throw new Error(`command cwd escapes sandbox root: ${cwd}`);
  }
  return resolved;
}

export const SandboxCommandSchema = z.strictObject({
  cmd: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().transform(sanitizeSandboxCwd).default(SANDBOX_ROOT),
  timeoutMs: z.number().int().positive().optional(),
  env: z.record(z.string(), z.string()).optional(),
  phase: z.enum(['bootstrap', 'runtime']).default('runtime'),
});

export type NetworkProfile = z.infer<typeof NetworkProfileSchema>;
export type SandboxBudget = z.infer<typeof SandboxBudgetSchema>;
export type SandboxCommand = z.infer<typeof SandboxCommandSchema>;
export type SandboxCommandInput = z.input<typeof SandboxCommandSchema>;

export type SandboxPolicy = {
  commandAllowlist: Set<string>;
  networkProfile: NetworkProfile;
  allowlistDomains: string[];
  envAllowlist: Set<string>;
  budget: SandboxBudget;
};

export type SandboxExecutionInput = {
  files?: Array<{ path: string; content: Buffer }>;
  commands: SandboxCommandInput[];
  artifacts?: Array<{ path: string }>;
  policy: SandboxPolicy;
  runtime?: 'node22' | 'node24' | 'python3.13';
};

export type SandboxExecutionOutput = {
  sandboxId: string;
  outputs: Array<{
    commandId: string;
    command: SandboxCommand;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  artifacts: Array<{
    path: string;
    content: string;
    byteLength: number;
  }>;
  audit: {
    policy: {
      networkProfile: NetworkProfile;
      allowlistDomains: string[];
      commandAllowlistSize: number;
      envAllowlistSize: number;
    };
    consumed: {
      commandCount: number;
      wallTimeMs: number;
      outputBytes: number;
      artifactBytes: number;
    };
    redactions: {
      apiKeyLike: number;
      bearer: number;
    };
    commands: Array<{
      commandId: string;
      cmd: string;
      args: string[];
      cwd: string;
      phase: SandboxCommand['phase'];
      startedAtMs: number;
      endedAtMs: number;
      durationMs: number;
      outputBytes: number;
      redactions: {
        apiKeyLike: number;
        bearer: number;
      };
      exitCode: number;
    }>;
  };
};

export function createDefaultPolicy(): SandboxPolicy {
  return {
    commandAllowlist: new Set([
      'git',
      'ls',
      'cat',
      'sed',
      'rg',
      'node',
      'npm',
      'pnpm',
      'bun',
    ]),
    networkProfile: 'deny_all',
    allowlistDomains: [],
    envAllowlist: new Set(['CI', 'HOME']),
    budget: {
      maxWallTimeMs: 15 * 60 * 1000,
      maxCommandTimeoutMs: 30 * 1000,
      maxCommandCount: 30,
      maxOutputBytes: 2 * 1024 * 1024,
      maxArtifactBytes: 2 * 1024 * 1024,
    },
  };
}

function createNetworkPolicy(
  profile: NetworkProfile,
  allowlistDomains: string[]
): NetworkPolicy {
  switch (profile) {
    case 'deny_all':
      return 'deny-all';
    case 'allowlist_only':
      return {
        allow: allowlistDomains,
      };
    case 'bootstrap_then_deny':
      return {
        allow: ['registry.npmjs.org', 'github.com', ...allowlistDomains],
      };
  }
}

function sanitizeEnv(
  command: SandboxCommand,
  allowlist: Set<string>
): Record<string, string> {
  const output: Record<string, string> = {};
  if (!command.env) {
    return output;
  }
  for (const [key, value] of Object.entries(command.env)) {
    if (allowlist.has(key)) {
      output[key] = value;
    }
  }
  return output;
}

function enforceCommandPolicy(
  command: SandboxCommand,
  policy: SandboxPolicy
): void {
  if (command.cmd.includes('/') || command.cmd.includes('\\')) {
    throw new Error(
      `command "${command.cmd}" is blocked by sandbox policy: command paths are not allowed`
    );
  }
  if (!policy.commandAllowlist.has(command.cmd)) {
    throw new Error(`command "${command.cmd}" is blocked by sandbox policy`);
  }
}

function redactSecrets(text: string): {
  text: string;
  redactions: { apiKeyLike: number; bearer: number };
} {
  const apiKeyLikePattern = /(sk-[a-zA-Z0-9]{20,})/g;
  const bearerPattern = /(Bearer\s+[a-zA-Z0-9._-]+)/g;
  const apiKeyLike = [...text.matchAll(apiKeyLikePattern)].length;
  const bearer = [...text.matchAll(bearerPattern)].length;
  return {
    text: text
      .replaceAll(apiKeyLikePattern, '[REDACTED_SECRET]')
      .replaceAll(bearerPattern, 'Bearer [REDACTED]'),
    redactions: {
      apiKeyLike,
      bearer,
    },
  };
}

export async function runInSandbox(
  input: SandboxExecutionInput
): Promise<SandboxExecutionOutput> {
  function sanitizeFilePath(filePath: string): string {
    const resolvedPath = resolve(SANDBOX_ROOT, filePath);
    const relativePath = relative(SANDBOX_ROOT, resolvedPath);
    if (
      relativePath.length === 0 ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`)
    ) {
      throw new Error(`file path escapes sandbox root: ${filePath}`);
    }
    return relativePath;
  }

  const validatedCommands = input.commands.map((command) =>
    SandboxCommandSchema.parse(command)
  );
  const budget = SandboxBudgetSchema.parse(input.policy.budget);

  if (validatedCommands.length > budget.maxCommandCount) {
    throw new Error(
      `sandbox command budget exceeded: ${validatedCommands.length} > ${budget.maxCommandCount}`
    );
  }

  for (const command of validatedCommands) {
    enforceCommandPolicy(command, input.policy);
  }

  const files =
    input.files && input.files.length > 0
      ? input.files.map((file) => ({
          path: sanitizeFilePath(file.path),
          content: file.content,
        }))
      : undefined;

  const sandbox = await Sandbox.create({
    runtime: input.runtime ?? DEFAULT_SANDBOX_RUNTIME,
    timeout: budget.maxWallTimeMs,
    networkPolicy: createNetworkPolicy(
      input.policy.networkProfile,
      input.policy.allowlistDomains
    ),
  });

  const startedAt = Date.now();
  const outputs: SandboxExecutionOutput['outputs'] = [];
  const artifacts: SandboxExecutionOutput['artifacts'] = [];
  const commandAudits: SandboxExecutionOutput['audit']['commands'] = [];
  let outputBytes = 0;
  let artifactBytes = 0;
  const redactionTotals = {
    apiKeyLike: 0,
    bearer: 0,
  };
  let denyAllApplied = input.policy.networkProfile !== 'bootstrap_then_deny';

  try {
    if (files && files.length > 0) {
      await sandbox.writeFiles(files);
    }

    for (const command of validatedCommands) {
      if (
        input.policy.networkProfile === 'bootstrap_then_deny' &&
        !denyAllApplied &&
        command.phase !== 'bootstrap'
      ) {
        await sandbox.updateNetworkPolicy('deny-all');
        denyAllApplied = true;
      }

      const commandId = randomUUID();
      const commandStartedAt = Date.now();
      const timeoutMs = Math.min(
        command.timeoutMs ?? budget.maxCommandTimeoutMs,
        budget.maxCommandTimeoutMs
      );
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const finished = await (async () => {
        try {
          return await sandbox.runCommand({
            cmd: command.cmd,
            args: command.args,
            cwd: command.cwd,
            env: sanitizeEnv(command, input.policy.envAllowlist),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
      })();

      const stdoutSanitized = redactSecrets(await finished.stdout());
      const stderrSanitized = redactSecrets(await finished.stderr());
      const commandRedactions = {
        apiKeyLike:
          stdoutSanitized.redactions.apiKeyLike +
          stderrSanitized.redactions.apiKeyLike,
        bearer:
          stdoutSanitized.redactions.bearer + stderrSanitized.redactions.bearer,
      };
      redactionTotals.apiKeyLike += commandRedactions.apiKeyLike;
      redactionTotals.bearer += commandRedactions.bearer;

      const stdout = stdoutSanitized.text;
      const stderr = stderrSanitized.text;
      const commandOutputBytes =
        Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
      outputBytes += Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
      if (outputBytes > budget.maxOutputBytes) {
        throw new Error(
          `sandbox output budget exceeded: ${outputBytes} > ${budget.maxOutputBytes}`
        );
      }

      outputs.push({
        commandId,
        command,
        exitCode: finished.exitCode,
        stdout,
        stderr,
      });
      const commandEndedAt = Date.now();
      commandAudits.push({
        commandId,
        cmd: command.cmd,
        args: command.args,
        cwd: command.cwd,
        phase: command.phase,
        startedAtMs: commandStartedAt,
        endedAtMs: commandEndedAt,
        durationMs: commandEndedAt - commandStartedAt,
        outputBytes: commandOutputBytes,
        redactions: commandRedactions,
        exitCode: finished.exitCode,
      });

      if (Date.now() - startedAt > budget.maxWallTimeMs) {
        throw new Error('sandbox wall time budget exceeded');
      }
    }

    if (
      input.policy.networkProfile === 'bootstrap_then_deny' &&
      !denyAllApplied
    ) {
      await sandbox.updateNetworkPolicy('deny-all');
      denyAllApplied = true;
    }

    for (const artifact of input.artifacts ?? []) {
      const artifactPath = sanitizeFilePath(artifact.path);
      const content = await sandbox.readFileToBuffer({ path: artifactPath });
      if (!content) {
        continue;
      }
      artifactBytes += content.byteLength;
      if (artifactBytes > budget.maxArtifactBytes) {
        throw new Error(
          `sandbox artifact budget exceeded: ${artifactBytes} > ${budget.maxArtifactBytes}`
        );
      }

      const sanitized = redactSecrets(content.toString('utf8'));
      redactionTotals.apiKeyLike += sanitized.redactions.apiKeyLike;
      redactionTotals.bearer += sanitized.redactions.bearer;
      artifacts.push({
        path: artifactPath,
        content: sanitized.text,
        byteLength: content.byteLength,
      });
    }

    const consumed = {
      commandCount: outputs.length,
      wallTimeMs: Date.now() - startedAt,
      outputBytes,
      artifactBytes,
    };
    const audit: SandboxExecutionOutput['audit'] = {
      policy: {
        networkProfile: input.policy.networkProfile,
        allowlistDomains: input.policy.allowlistDomains,
        commandAllowlistSize: input.policy.commandAllowlist.size,
        envAllowlistSize: input.policy.envAllowlist.size,
      },
      consumed,
      redactions: redactionTotals,
      commands: commandAudits,
    };
    const result: SandboxExecutionOutput = {
      sandboxId: sandbox.sandboxId,
      outputs,
      artifacts,
      audit,
    };
    return result;
  } finally {
    await sandbox.stop({ blocking: true });
  }
}
