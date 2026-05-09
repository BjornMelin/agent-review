import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliPath = fileURLToPath(new URL('./index.ts', import.meta.url));

function runDoctor(provider: 'gateway' | 'openrouter') {
  return spawnSync(
    'tsx',
    [cliPath, 'doctor', '--provider', provider, '--json'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        AI_GATEWAY_API_KEY: 'test-gateway-key',
        OPENROUTER_API_KEY: '',
      },
    }
  );
}

describe('review-agent doctor provider filtering', () => {
  it('does not fail gateway checks when OpenRouter auth is absent', () => {
    const result = runDoctor('gateway');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gateway auth detected');
    expect(result.stdout).not.toContain('OPENROUTER_API_KEY');
  });

  it('still reports missing OpenRouter auth for the OpenRouter route', () => {
    const result = runDoctor('openrouter');

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('OPENROUTER_API_KEY is not configured');
  });
});
