import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateTextMock = vi.fn();

vi.mock('@ai-sdk/gateway', () => ({
  createGateway: () => (modelId: string) => ({
    provider: 'gateway',
    modelId,
  }),
}));

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: () => ({
    chatModel: (modelId: string) => ({ provider: 'openrouter', modelId }),
  }),
}));

vi.mock('ai', () => ({
  Output: {
    object: ({ schema, name, description }: Record<string, unknown>) => ({
      schema,
      name,
      description,
    }),
  },
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

import {
  type OpenAICompatibleModelPolicy,
  type OpenAICompatibleProviderOptions,
  OpenAICompatibleReviewProvider,
  type OpenAICompatibleRouteConfig,
} from './index.js';

const RAW_OUTPUT = {
  findings: [
    {
      title: '[P1] Missing guard',
      body: 'Guard this branch before dereferencing.',
      confidence_score: 0.9,
      priority: 1,
      code_location: {
        absolute_file_path: '/tmp/file.ts',
        line_range: { start: 1, end: 1 },
      },
    },
  ],
  overall_correctness: 'patch is incorrect',
  overall_explanation: 'A guard is missing.',
  overall_confidence_score: 0.88,
};

const CAPABILITIES = {
  jsonSchemaOutput: true,
  reasoningControl: false,
  streaming: false,
};

function makePolicy(
  id: string,
  overrides: Partial<OpenAICompatibleModelPolicy> = {}
): OpenAICompatibleModelPolicy {
  const route = id.slice(0, id.indexOf(':'));
  return {
    id,
    route,
    policyVersion: 'provider-policy.test',
    fallbackModelIds: [],
    maxInputChars: 120_000,
    maxOutputTokens: 4096,
    timeoutMs: 120_000,
    maxAttempts: 1,
    retention: route === 'openrouter' ? 'providerRetained' : 'unknown',
    zdrRequired: false,
    disallowPromptTraining: route === 'gateway',
    ...overrides,
  };
}

function makePolicies(): OpenAICompatibleModelPolicy[] {
  return [
    makePolicy('gateway:openai/gpt-5', {
      fallbackModelIds: ['gateway:anthropic/claude-sonnet-4-5'],
      maxAttempts: 2,
    }),
    makePolicy('gateway:anthropic/claude-sonnet-4-5'),
    makePolicy('openrouter:openai/gpt-5'),
  ];
}

function makeRoutes(
  options: {
    gatewayApiKey?: string | undefined;
    openRouterApiKey?: string | undefined;
  } = {}
): OpenAICompatibleRouteConfig[] {
  return [
    {
      id: 'gateway',
      kind: 'gateway',
      displayName: 'AI Gateway',
      apiKeyEnv: 'AI_GATEWAY_API_KEY',
      ...(options.gatewayApiKey !== undefined
        ? { apiKey: options.gatewayApiKey }
        : {}),
    },
    {
      id: 'openrouter',
      kind: 'openaiCompatibleChat',
      displayName: 'OpenRouter',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      baseURL: 'https://openrouter.ai/api/v1',
      ...(options.openRouterApiKey !== undefined
        ? { apiKey: options.openRouterApiKey }
        : {}),
    },
  ];
}

function makeProvider(
  options: Partial<OpenAICompatibleProviderOptions> & {
    gatewayApiKey?: string | undefined;
    openRouterApiKey?: string | undefined;
  } = {}
): OpenAICompatibleReviewProvider {
  return new OpenAICompatibleReviewProvider({
    capabilities: options.capabilities ?? CAPABILITIES,
    modelPolicies: options.modelPolicies ?? makePolicies(),
    routes:
      options.routes ??
      makeRoutes({
        gatewayApiKey: options.gatewayApiKey,
        openRouterApiKey: options.openRouterApiKey,
      }),
    ...(options.defaultModelId !== undefined
      ? { defaultModelId: options.defaultModelId }
      : {}),
  });
}

describe('openai-compatible provider contract', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    Reflect.deleteProperty(process.env, 'AI_GATEWAY_API_KEY');
    Reflect.deleteProperty(process.env, 'OPENROUTER_API_KEY');
  });

  it('returns structured output and provider telemetry with mocked generateText', async () => {
    generateTextMock.mockResolvedValue({
      output: RAW_OUTPUT,
      usage: {
        inputTokens: 25,
        inputTokenDetails: { cacheReadTokens: 4 },
        outputTokens: 12,
        outputTokenDetails: { reasoningTokens: 2 },
        totalTokens: 37,
      },
      totalUsage: {
        inputTokens: 25,
        inputTokenDetails: { cacheReadTokens: 4 },
        outputTokens: 12,
        outputTokenDetails: { reasoningTokens: 2 },
        totalTokens: 37,
      },
      providerMetadata: {
        gateway: {
          routing: { finalProvider: 'openai' },
          cost: '0.00012',
          marketCost: '0.00012',
          generationId: 'gen_test',
        },
      },
    });
    const provider = makeProvider({
      gatewayApiKey: 'test-gateway-key',
      openRouterApiKey: 'test-openrouter-key',
      defaultModelId: 'gateway:openai/gpt-5',
    });

    const result = await provider.run({
      request: {
        cwd: process.cwd(),
        target: { type: 'uncommittedChanges' },
        provider: 'openaiCompatible',
        executionMode: 'localTrusted',
        outputFormats: ['json'],
      },
      resolvedPrompt: 'prompt',
      rubric: 'rubric',
      normalizedDiffChunks: [
        { file: 'file.ts', patch: 'diff --git a/file.ts b/file.ts' },
      ],
    });

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 4096,
        timeout: {
          totalMs: 120_000,
          stepMs: 120_000,
        },
        providerOptions: expect.objectContaining({
          gateway: expect.objectContaining({
            disallowPromptTraining: true,
          }),
        }),
      })
    );
    expect(result.raw).toEqual(RAW_OUTPUT);
    expect(result.text).toContain('overall_correctness');
    expect(result.providerTelemetry).toMatchObject({
      policyVersion: 'provider-policy.test',
      resolvedModel: 'gateway:openai/gpt-5',
      route: 'gateway',
      finalProvider: 'openai',
      fallbackOrder: ['gateway:anthropic/claude-sonnet-4-5'],
      fallbackUsed: false,
      timeoutMs: 120_000,
      usage: {
        status: 'reported',
        inputTokens: 25,
        outputTokens: 12,
        totalTokens: 37,
        reasoningTokens: 2,
        cachedInputTokens: 4,
        costUsd: 0.00012,
      },
    });
  });

  it('diagnoses invalid model format in validateRequest', () => {
    const provider = makeProvider({
      gatewayApiKey: 'test-gateway-key',
      openRouterApiKey: 'test-openrouter-key',
    });

    const diagnostics = provider.validateRequest({
      request: {
        cwd: process.cwd(),
        target: { type: 'uncommittedChanges' },
        provider: 'openaiCompatible',
        executionMode: 'localTrusted',
        outputFormats: ['json'],
        model: 'invalid-model-id',
      },
      capabilities: provider.capabilities(),
    });

    expect(
      diagnostics.some((item) => item.code === 'invalid_model_id' && !item.ok)
    ).toBe(true);
  });

  it('requires registry-owned defaults when request omits a model', () => {
    const provider = makeProvider({
      gatewayApiKey: 'test-gateway-key',
      openRouterApiKey: 'test-openrouter-key',
    });

    const diagnostics = provider.validateRequest({
      request: {
        cwd: process.cwd(),
        target: { type: 'uncommittedChanges' },
        provider: 'openaiCompatible',
        executionMode: 'localTrusted',
        outputFormats: ['json'],
      },
      capabilities: provider.capabilities(),
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'configuration_error',
        ok: false,
      }),
    ]);
  });

  it('diagnoses missing auth per routed provider', () => {
    const provider = makeProvider();

    const gatewayDiagnostics = provider.validateRequest({
      request: {
        cwd: process.cwd(),
        target: { type: 'uncommittedChanges' },
        provider: 'openaiCompatible',
        executionMode: 'localTrusted',
        outputFormats: ['json'],
        model: 'gateway:openai/gpt-5',
      },
      capabilities: provider.capabilities(),
    });
    expect(
      gatewayDiagnostics.some(
        (item) =>
          item.code === 'auth_missing' && item.scope === 'gateway' && !item.ok
      )
    ).toBe(true);

    const openRouterDiagnostics = provider.validateRequest({
      request: {
        cwd: process.cwd(),
        target: { type: 'uncommittedChanges' },
        provider: 'openaiCompatible',
        executionMode: 'localTrusted',
        outputFormats: ['json'],
        model: 'openrouter:openai/gpt-5',
      },
      capabilities: provider.capabilities(),
    });
    expect(
      openRouterDiagnostics.some(
        (item) =>
          item.code === 'auth_missing' &&
          item.scope === 'openrouter' &&
          !item.ok
      )
    ).toBe(true);
  });

  it('rejects whitespace-only auth signals', async () => {
    process.env.AI_GATEWAY_API_KEY = '   ';
    process.env.OPENROUTER_API_KEY = '   ';
    const provider = makeProvider();

    const diagnostics = await provider.doctor();

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'auth_missing',
          scope: 'gateway',
          ok: false,
        }),
        expect.objectContaining({
          code: 'auth_missing',
          scope: 'openrouter',
          ok: false,
        }),
      ])
    );
  });

  it('rejects whitespace-only routed model bodies', () => {
    const provider = makeProvider({
      gatewayApiKey: 'test-gateway-key',
    });

    const diagnostics = provider.validateRequest({
      request: {
        cwd: process.cwd(),
        target: { type: 'uncommittedChanges' },
        provider: 'openaiCompatible',
        executionMode: 'localTrusted',
        outputFormats: ['json'],
        model: 'gateway:   ',
      },
      capabilities: provider.capabilities(),
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_model_id',
        scope: 'gateway',
        ok: false,
      }),
    ]);
  });

  it('rejects routed models outside the policy allowlist', () => {
    const provider = makeProvider({
      gatewayApiKey: 'test-gateway-key',
    });

    const diagnostics = provider.validateRequest({
      request: {
        cwd: process.cwd(),
        target: { type: 'uncommittedChanges' },
        provider: 'openaiCompatible',
        executionMode: 'localTrusted',
        outputFormats: ['json'],
        model: 'gateway:unapproved/model',
      },
      capabilities: provider.capabilities(),
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_model_id',
        ok: false,
        detail: expect.stringContaining('provider policy catalog'),
      }),
    ]);
  });

  it('fails before provider execution when the input budget is exceeded', async () => {
    const provider = makeProvider({
      gatewayApiKey: 'test-gateway-key',
      modelPolicies: [
        makePolicy('gateway:openai/gpt-5', {
          maxInputChars: 40,
        }),
      ],
      defaultModelId: 'gateway:openai/gpt-5',
    });

    await expect(
      provider.run({
        request: {
          cwd: process.cwd(),
          target: { type: 'uncommittedChanges' },
          provider: 'openaiCompatible',
          executionMode: 'localTrusted',
          outputFormats: ['json'],
        },
        resolvedPrompt: 'prompt',
        rubric: 'rubric',
        normalizedDiffChunks: [
          {
            file: 'file.ts',
            patch: 'diff --git a/file.ts b/file.ts\n'.repeat(10),
          },
        ],
      })
    ).rejects.toThrow(/input budget exceeded/);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('records explicit fallback evidence when a policy fallback succeeds', async () => {
    generateTextMock
      .mockRejectedValueOnce(
        Object.assign(new Error('upstream unavailable'), {
          name: 'APICallError',
          statusCode: 503,
          isRetryable: true,
        })
      )
      .mockResolvedValueOnce({
        output: RAW_OUTPUT,
        usage: {
          inputTokens: 10,
          inputTokenDetails: {},
          outputTokens: 5,
          outputTokenDetails: {},
          totalTokens: 15,
        },
        providerMetadata: {
          gateway: {
            routing: { finalProvider: 'anthropic' },
            generationId: 'gen_fallback',
          },
        },
      });
    const provider = makeProvider({
      gatewayApiKey: 'test-gateway-key',
      defaultModelId: 'gateway:openai/gpt-5',
    });

    const result = await provider.run({
      request: {
        cwd: process.cwd(),
        target: { type: 'uncommittedChanges' },
        provider: 'openaiCompatible',
        executionMode: 'localTrusted',
        outputFormats: ['json'],
      },
      resolvedPrompt: 'prompt',
      rubric: 'rubric',
      normalizedDiffChunks: [
        { file: 'file.ts', patch: 'diff --git a/file.ts b/file.ts' },
      ],
    });

    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(result.resolvedModel).toBe('gateway:anthropic/claude-sonnet-4-5');
    expect(result.providerTelemetry).toMatchObject({
      resolvedModel: 'gateway:anthropic/claude-sonnet-4-5',
      fallbackUsed: true,
      finalProvider: 'anthropic',
      attempts: [
        {
          model: 'gateway:openai/gpt-5',
          status: 'failed',
          failureClass: 'provider_unavailable',
          retryable: true,
        },
        {
          model: 'gateway:anthropic/claude-sonnet-4-5',
          status: 'success',
          generationId: 'gen_fallback',
        },
      ],
    });
  });

  it('classifies policy timeouts as fallback failures', async () => {
    generateTextMock
      .mockRejectedValueOnce(
        Object.assign(new Error('The request timed out.'), {
          name: 'TimeoutError',
        })
      )
      .mockResolvedValueOnce({
        output: RAW_OUTPUT,
        usage: {
          inputTokens: 10,
          inputTokenDetails: {},
          outputTokens: 5,
          outputTokenDetails: {},
          totalTokens: 15,
        },
        providerMetadata: {
          gateway: {
            routing: { finalProvider: 'anthropic' },
          },
        },
      });
    const provider = makeProvider({
      gatewayApiKey: 'test-gateway-key',
      defaultModelId: 'gateway:openai/gpt-5',
      modelPolicies: [
        makePolicy('gateway:openai/gpt-5', {
          fallbackModelIds: ['gateway:anthropic/claude-sonnet-4-5'],
          maxAttempts: 2,
          timeoutMs: 1_500,
        }),
        makePolicy('gateway:anthropic/claude-sonnet-4-5', {
          timeoutMs: 1_500,
        }),
      ],
    });

    const result = await provider.run({
      request: {
        cwd: process.cwd(),
        target: { type: 'uncommittedChanges' },
        provider: 'openaiCompatible',
        executionMode: 'localTrusted',
        outputFormats: ['json'],
      },
      resolvedPrompt: 'prompt',
      rubric: 'rubric',
      normalizedDiffChunks: [
        { file: 'file.ts', patch: 'diff --git a/file.ts b/file.ts' },
      ],
    });

    expect(generateTextMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        timeout: { totalMs: 1_500, stepMs: 1_500 },
      })
    );
    expect(result.providerTelemetry).toMatchObject({
      timeoutMs: 1_500,
      attempts: [
        {
          model: 'gateway:openai/gpt-5',
          status: 'failed',
          failureClass: 'timeout',
        },
        {
          model: 'gateway:anthropic/claude-sonnet-4-5',
          status: 'success',
        },
      ],
    });
  });

  it('preserves abort errors for review cancellation normalization', async () => {
    const abortError = new Error('provider aborted');
    abortError.name = 'AbortError';
    generateTextMock.mockRejectedValueOnce(abortError);
    const provider = makeProvider({
      gatewayApiKey: 'test-gateway-key',
      defaultModelId: 'gateway:openai/gpt-5',
    });

    await expect(
      provider.run({
        request: {
          cwd: process.cwd(),
          target: { type: 'uncommittedChanges' },
          provider: 'openaiCompatible',
          executionMode: 'localTrusted',
          outputFormats: ['json'],
        },
        resolvedPrompt: 'prompt',
        rubric: 'rubric',
        normalizedDiffChunks: [
          { file: 'file.ts', patch: 'diff --git a/file.ts b/file.ts' },
        ],
      })
    ).rejects.toBe(abortError);
  });

  it('doctor returns deterministic auth diagnostics', async () => {
    const provider = makeProvider();
    const diagnostics = await provider.doctor();

    expect(
      diagnostics.some(
        (item) =>
          item.code === 'auth_missing' && item.scope === 'gateway' && !item.ok
      )
    ).toBe(true);
  });
});
