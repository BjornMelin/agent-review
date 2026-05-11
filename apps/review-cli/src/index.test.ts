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
    expect(result.stdout).toContain('AI Gateway auth detected');
    expect(result.stdout).not.toContain('OPENROUTER_API_KEY');
  });

  it('still reports missing OpenRouter auth for the OpenRouter route', () => {
    const result = runDoctor('openrouter');

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('OPENROUTER_API_KEY is not configured');
  });

  it('maps invalid doctor provider filters to usage failures', () => {
    const result = spawnSync(
      'tsx',
      [cliPath, 'doctor', '--provider', 'nope', '--json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
        },
      }
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'invalid provider filter "nope"; expected codex|gateway|openrouter|all'
    );
    expect(result.stderr).not.toContain('at Command');
  });
});

describe('review-agent provider model routing', () => {
  it('rejects mismatched routed model prefixes before review execution', () => {
    const result = spawnSync(
      'tsx',
      [
        cliPath,
        'run',
        '--prompt',
        'review this',
        '--provider',
        'gateway',
        '--model',
        'openrouter:openai/gpt-5',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          AI_GATEWAY_API_KEY: 'test-gateway-key',
          OPENROUTER_API_KEY: 'test-openrouter-key',
        },
      }
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      '--provider gateway cannot use "openrouter:" model ids'
    );
  });
});
