import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  runCommandMock,
  writeFilesMock,
  updateNetworkPolicyMock,
  stopMock,
  createMock,
} = vi.hoisted(() => {
  const runCommand = vi.fn();
  const writeFiles = vi.fn();
  const updateNetworkPolicy = vi.fn();
  const stop = vi.fn();
  const create = vi.fn(async () => ({
    sandboxId: 'sbx-test',
    writeFiles,
    runCommand,
    updateNetworkPolicy,
    stop,
  }));
  return {
    runCommandMock: runCommand,
    writeFilesMock: writeFiles,
    updateNetworkPolicyMock: updateNetworkPolicy,
    stopMock: stop,
    createMock: create,
  };
});

vi.mock('@vercel/sandbox', () => ({
  Sandbox: {
    create: createMock,
  },
}));

import { createDefaultPolicy, runInSandbox } from './index.js';

function createFinishedCommand(output: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}) {
  return {
    exitCode: output.exitCode ?? 0,
    stdout: async () => output.stdout ?? '',
    stderr: async () => output.stderr ?? '',
  };
}

describe('sandbox policy and budget enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runCommandMock.mockResolvedValue(
      createFinishedCommand({ stdout: 'ok', stderr: '' })
    );
  });

  it('blocks commands outside allowlist', async () => {
    const policy = createDefaultPolicy();

    await expect(
      runInSandbox({
        commands: [{ cmd: 'rm', args: ['-rf', '/'], cwd: '/vercel/sandbox' }],
        policy,
      })
    ).rejects.toThrow('blocked by sandbox policy');
    expect(createMock).toHaveBeenCalledTimes(0);
    expect(stopMock).toHaveBeenCalledTimes(0);
  });

  it('fails fast when staging files escapes sandbox root', async () => {
    const policy = createDefaultPolicy();

    await expect(
      runInSandbox({
        files: [{ path: '../etc/passwd', content: Buffer.from('root:x') }],
        commands: [{ cmd: 'git', args: ['--version'], cwd: '/vercel/sandbox' }],
        policy,
      })
    ).rejects.toThrow('file path escapes sandbox root');
    expect(createMock).toHaveBeenCalledTimes(0);
    expect(stopMock).toHaveBeenCalledTimes(0);
  });

  it('fails fast when command count exceeds budget', async () => {
    const policy = createDefaultPolicy();
    policy.budget.maxCommandCount = 1;

    await expect(
      runInSandbox({
        commands: [
          { cmd: 'git', args: ['--version'], cwd: '/vercel/sandbox' },
          { cmd: 'git', args: ['status'], cwd: '/vercel/sandbox' },
        ],
        policy,
      })
    ).rejects.toThrow('sandbox command budget exceeded');
    expect(createMock).toHaveBeenCalledTimes(0);
  });

  it('enforces output budget and redacts secrets', async () => {
    const policy = createDefaultPolicy();
    policy.budget.maxOutputBytes = 32;
    runCommandMock.mockResolvedValue(
      createFinishedCommand({
        stdout: 'sk-12345678901234567890\nBearer abc.def.ghi',
        stderr: '',
      })
    );

    await expect(
      runInSandbox({
        commands: [{ cmd: 'git', args: ['--version'], cwd: '/vercel/sandbox' }],
        policy,
      })
    ).rejects.toThrow('sandbox output budget exceeded');
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it('enforces artifact budget', async () => {
    const policy = createDefaultPolicy();
    policy.budget.maxArtifactBytes = 64;

    await expect(
      runInSandbox({
        commands: [{ cmd: 'git', args: ['--version'], cwd: '/vercel/sandbox' }],
        policy,
      })
    ).rejects.toThrow('sandbox artifact budget exceeded');
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it('emits audit metadata and applies bootstrap_then_deny profile', async () => {
    const policy = createDefaultPolicy();
    policy.networkProfile = 'bootstrap_then_deny';
    runCommandMock.mockResolvedValue(
      createFinishedCommand({
        stdout: 'sk-12345678901234567890\nBearer abc.def.ghi',
        stderr: '',
      })
    );

    const result = await runInSandbox({
      commands: [{ cmd: 'git', args: ['--version'], cwd: '/vercel/sandbox' }],
      policy,
    });

    expect(result.audit.policy.networkProfile).toBe('bootstrap_then_deny');
    expect(result.audit.consumed.commandCount).toBe(1);
    expect(result.audit.redactions.apiKeyLike).toBeGreaterThan(0);
    expect(result.audit.redactions.bearer).toBeGreaterThan(0);
    expect(result.audit.commands[0]?.commandId).toBeTruthy();
    expect(updateNetworkPolicyMock).toHaveBeenCalledWith('deny-all');
    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});
