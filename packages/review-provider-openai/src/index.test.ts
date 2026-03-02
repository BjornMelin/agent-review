import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateTextMock = vi.fn();

vi.mock('@ai-sdk/gateway', () => ({
  createGatewayProvider: () => (modelId: string) => ({
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

import { OpenAICompatibleReviewProvider } from './index.js';

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

describe('openai-compatible provider contract', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    Reflect.deleteProperty(process.env, 'AI_GATEWAY_API_KEY');
    Reflect.deleteProperty(process.env, 'OPENROUTER_API_KEY');
  });

  it('returns structured output with mocked generateText', async () => {
    generateTextMock.mockResolvedValue({ output: RAW_OUTPUT });
    const provider = new OpenAICompatibleReviewProvider({
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
    expect(result.raw).toEqual(RAW_OUTPUT);
    expect(result.text).toContain('overall_correctness');
  });

  it('diagnoses invalid model format in validateRequest', () => {
    const provider = new OpenAICompatibleReviewProvider({
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

  it('diagnoses missing auth per routed provider', () => {
    const provider = new OpenAICompatibleReviewProvider({});

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
        (item) => item.code === 'auth_missing' && !item.ok
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
        (item) => item.code === 'auth_missing' && !item.ok
      )
    ).toBe(true);
  });

  it('doctor returns deterministic auth diagnostics', async () => {
    const provider = new OpenAICompatibleReviewProvider({});
    const diagnostics = await provider.doctor();

    expect(
      diagnostics.some((item) => item.code === 'auth_missing' && !item.ok)
    ).toBe(true);
  });
});
