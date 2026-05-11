import type { ReviewProvider } from '@review-agent/review-types';
import { describe, expect, it } from 'vitest';
import {
  createReviewProviders,
  DEFAULT_MODEL_BY_ROUTE,
  filterDoctorChecks,
  listModelCatalog,
  normalizeCliProviderModel,
  normalizeOpenAICompatibleModelId,
  parseOpenAICompatibleModelId,
  runProviderDoctorChecks,
} from './index.js';

function makeProvider(
  id: ReviewProvider['id'],
  doctor: NonNullable<ReviewProvider['doctor']>
): ReviewProvider {
  return {
    id,
    capabilities: () => ({
      jsonSchemaOutput: true,
      reasoningControl: false,
      streaming: false,
    }),
    doctor,
    run: async () => ({ raw: null, text: '' }),
  };
}

describe('provider model policy', () => {
  it('normalizes CLI provider aliases to canonical review providers', () => {
    expect(normalizeCliProviderModel('codex', 'gpt-5')).toEqual({
      provider: 'codexDelegate',
      model: 'gpt-5',
    });
    expect(normalizeCliProviderModel('gateway', undefined)).toEqual({
      provider: 'openaiCompatible',
      model: DEFAULT_MODEL_BY_ROUTE.gateway,
    });
    expect(normalizeCliProviderModel('gateway', 'openai/gpt-5')).toEqual({
      provider: 'openaiCompatible',
      model: 'gateway:openai/gpt-5',
    });
    expect(normalizeCliProviderModel('openrouter', 'openai/gpt-5')).toEqual({
      provider: 'openaiCompatible',
      model: 'openrouter:openai/gpt-5',
    });
  });

  it('rejects mismatched or unsupported model route prefixes', () => {
    expect(() =>
      normalizeOpenAICompatibleModelId('gateway', 'openrouter:openai/gpt-5')
    ).toThrow(/cannot use "openrouter:"/);
    expect(() =>
      normalizeOpenAICompatibleModelId('gateway', 'other:openai/gpt-5')
    ).toThrow(/unsupported model route/);
  });

  it('parses routed model identifiers', () => {
    expect(parseOpenAICompatibleModelId('gateway:openai/gpt-5')).toEqual({
      route: 'gateway',
      model: 'openai/gpt-5',
    });
    expect(parseOpenAICompatibleModelId('gateway: openai/gpt-5 ')).toEqual({
      route: 'gateway',
      model: 'openai/gpt-5',
    });
    expect(() => parseOpenAICompatibleModelId('gateway:')).toThrow(
      /invalid model id/
    );
    expect(() => parseOpenAICompatibleModelId('gateway:   ')).toThrow(
      /invalid model id/
    );
  });

  it('marks one default model per OpenAI-compatible route', () => {
    const defaults = listModelCatalog().filter((model) => model.default);

    expect(defaults).toEqual([
      expect.objectContaining({
        provider: 'gateway',
        id: DEFAULT_MODEL_BY_ROUTE.gateway,
      }),
      expect.objectContaining({
        provider: 'openrouter',
        id: DEFAULT_MODEL_BY_ROUTE.openrouter,
      }),
    ]);
  });

  it('injects the canonical default model into OpenAI-compatible providers', () => {
    const providers = createReviewProviders({
      openaiCompatible: {
        gatewayApiKey: 'test-gateway-key',
      },
    });

    const diagnostics =
      providers.openaiCompatible.validateRequest?.({
        request: {
          cwd: process.cwd(),
          target: { type: 'uncommittedChanges' },
          provider: 'openaiCompatible',
          executionMode: 'localTrusted',
          outputFormats: ['json'],
        },
        capabilities: providers.openaiCompatible.capabilities(),
      }) ?? [];

    expect(diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'configuration_error' }),
      ])
    );
    expect(diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'auth_missing' }),
      ])
    );
  });
});

describe('provider doctor policy', () => {
  it('continues checks when one provider throws', async () => {
    const checks = await runProviderDoctorChecks({
      codexDelegate: makeProvider('codexDelegate', async () => {
        throw new Error('doctor failure');
      }),
      openaiCompatible: makeProvider('openaiCompatible', async () => [
        {
          code: 'provider_unavailable',
          ok: true,
          severity: 'info',
          detail: 'openai available',
        },
      ]),
    });

    const keys = checks.map((check) => check.name);
    expect(keys).toContain('provider.codexDelegate.doctor');
    expect(keys).toContain('provider.openaiCompatible.provider_unavailable');
    expect(
      checks.find((check) => check.name === 'provider.codexDelegate.doctor')
        ?.detail
    ).toContain('doctor failure');
  });

  it('filters route-specific OpenAI-compatible diagnostics', () => {
    const checks = [
      {
        name: 'provider.openaiCompatible.available',
        ok: true,
        detail: 'openaiCompatible provider is configured',
      },
      {
        name: 'provider.openaiCompatible.gateway.auth_available',
        ok: true,
        detail: 'gateway auth detected',
      },
      {
        name: 'provider.openaiCompatible.openrouter.auth_missing',
        ok: false,
        detail: 'OPENROUTER_API_KEY is not configured',
        remediation: 'Set OPENROUTER_API_KEY for openrouter:* model routing.',
      },
    ];

    expect(filterDoctorChecks(checks, 'gateway')).toEqual([
      checks[0],
      checks[1],
    ]);
    expect(filterDoctorChecks(checks, 'openrouter')).toEqual([
      checks[0],
      checks[2],
    ]);
  });
});
