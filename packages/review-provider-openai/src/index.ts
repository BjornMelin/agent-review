import { createGatewayProvider } from '@ai-sdk/gateway';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  type ProviderDiagnostic,
  RawModelOutputSchema,
  type ReviewProvider,
  type ReviewProviderCapabilities,
  type ReviewProviderRunInput,
  type ReviewProviderRunOutput,
  type ReviewProviderValidationInput,
} from '@review-agent/review-types';
import { Output, generateText } from 'ai';

const DEFAULT_GATEWAY_MODEL_ID = 'gateway:openai/gpt-5';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export type OpenAICompatibleProviderOptions = {
  defaultModelId?: string;
  gatewayApiKey?: string;
  gatewayBaseURL?: string;
  openRouterApiKey?: string;
  openRouterBaseURL?: string;
  openRouterHeaders?: Record<string, string>;
};

type TextModel = Parameters<typeof generateText>[0]['model'];
type ProviderId = 'gateway' | 'openrouter';
type LanguageModelFactory = (modelId: string) => TextModel;

function buildReviewInput(input: ReviewProviderRunInput): string {
  const chunks = input.normalizedDiffChunks
    .map((chunk, index) => {
      return `### Diff Chunk ${index + 1}: ${chunk.file}\n${chunk.patch}`;
    })
    .join('\n\n');

  return [
    'Review target instructions:',
    input.resolvedPrompt,
    '',
    'Git diff chunks to review:',
    chunks,
  ].join('\n');
}

export class OpenAICompatibleReviewProvider implements ReviewProvider {
  id = 'openaiCompatible' as const;
  private readonly defaultModelId: string;
  private readonly registry: Record<ProviderId, LanguageModelFactory>;
  private readonly options: OpenAICompatibleProviderOptions;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    this.options = options;
    this.defaultModelId = options.defaultModelId ?? DEFAULT_GATEWAY_MODEL_ID;

    const gatewayOptions: { apiKey?: string; baseURL?: string } = {};
    const gatewayApiKey =
      this.options.gatewayApiKey ?? process.env.AI_GATEWAY_API_KEY;
    if (gatewayApiKey !== undefined) {
      gatewayOptions.apiKey = gatewayApiKey;
    }
    if (this.options.gatewayBaseURL) {
      gatewayOptions.baseURL = this.options.gatewayBaseURL;
    }

    const openRouterOptions: {
      baseURL: string;
      name: string;
      apiKey?: string;
      headers?: Record<string, string>;
      supportsStructuredOutputs: boolean;
    } = {
      baseURL: this.options.openRouterBaseURL ?? DEFAULT_OPENROUTER_BASE_URL,
      name: 'openrouter',
      supportsStructuredOutputs: true,
    };
    const openRouterApiKey =
      this.options.openRouterApiKey ?? process.env.OPENROUTER_API_KEY;
    if (openRouterApiKey !== undefined) {
      openRouterOptions.apiKey = openRouterApiKey;
    }
    if (this.options.openRouterHeaders) {
      openRouterOptions.headers = this.options.openRouterHeaders;
    }

    const gatewayProvider = createGatewayProvider(gatewayOptions);
    const openRouterProvider = createOpenAICompatible(openRouterOptions);

    this.registry = {
      gateway: (modelId) => gatewayProvider(modelId),
      openrouter: (modelId) => openRouterProvider.chatModel(modelId),
    };
  }

  capabilities(): ReviewProviderCapabilities {
    return {
      jsonSchemaOutput: true,
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
          'openaiCompatible does not currently accept reasoning-effort controls',
        remediation:
          'Omit --reasoning-effort until provider support is implemented.',
      });
      return diagnostics;
    }

    const resolvedModelId = input.request.model ?? this.defaultModelId;
    const separator = resolvedModelId.indexOf(':');
    if (separator < 1 || separator === resolvedModelId.length - 1) {
      diagnostics.push({
        code: 'invalid_model_id',
        ok: false,
        severity: 'error',
        detail: `invalid model id "${resolvedModelId}". Expected "provider:model".`,
        remediation:
          'Use model ids like "gateway:openai/gpt-5" or "openrouter:openai/gpt-5".',
      });
      return diagnostics;
    }
    const providerId = resolvedModelId.slice(0, separator) as ProviderId;
    if (providerId !== 'gateway' && providerId !== 'openrouter') {
      diagnostics.push({
        code: 'configuration_error',
        ok: false,
        severity: 'error',
        detail: `unsupported provider "${providerId}" for openaiCompatible`,
        remediation: 'Use "gateway" or "openrouter" model prefixes.',
      });
      return diagnostics;
    }
    const hasGatewayKey = Boolean(
      this.options.gatewayApiKey ?? process.env.AI_GATEWAY_API_KEY
    );
    const hasOpenRouterKey = Boolean(
      this.options.openRouterApiKey ?? process.env.OPENROUTER_API_KEY
    );
    if (providerId === 'gateway' && !hasGatewayKey) {
      diagnostics.push({
        code: 'auth_missing',
        ok: false,
        severity: 'error',
        detail: 'missing AI Gateway API key',
        remediation: 'Set AI_GATEWAY_API_KEY or provide gatewayApiKey option.',
      });
    }
    if (providerId === 'openrouter' && !hasOpenRouterKey) {
      diagnostics.push({
        code: 'auth_missing',
        ok: false,
        severity: 'error',
        detail: 'missing OpenRouter API key',
        remediation:
          'Set OPENROUTER_API_KEY or provide openRouterApiKey option.',
      });
    }
    return diagnostics;
  }

  async doctor(): Promise<ProviderDiagnostic[]> {
    const diagnostics: ProviderDiagnostic[] = [];
    const hasGatewayKey = Boolean(
      this.options.gatewayApiKey ?? process.env.AI_GATEWAY_API_KEY
    );
    diagnostics.push(
      hasGatewayKey
        ? {
            code: 'auth_available',
            ok: true,
            severity: 'info',
            detail: 'gateway auth detected',
          }
        : {
            code: 'auth_missing',
            ok: false,
            severity: 'error',
            detail: 'AI_GATEWAY_API_KEY is not configured',
            remediation: 'Set AI_GATEWAY_API_KEY for gateway:* model routing.',
          }
    );
    const hasOpenRouterKey = Boolean(
      this.options.openRouterApiKey ?? process.env.OPENROUTER_API_KEY
    );
    diagnostics.push(
      hasOpenRouterKey
        ? {
            code: 'auth_available',
            ok: true,
            severity: 'info',
            detail: 'openrouter auth detected',
          }
        : {
            code: 'auth_missing',
            ok: false,
            severity: 'error',
            detail: 'OPENROUTER_API_KEY is not configured',
            remediation:
              'Set OPENROUTER_API_KEY for openrouter:* model routing.',
          }
    );
    return diagnostics;
  }

  async run(input: ReviewProviderRunInput): Promise<ReviewProviderRunOutput> {
    const resolvedModelId = input.request.model ?? this.defaultModelId;
    const separator = resolvedModelId.indexOf(':');
    if (separator < 1 || separator === resolvedModelId.length - 1) {
      throw new Error(
        `invalid model id "${resolvedModelId}". Expected "provider:model".`
      );
    }
    const providerId = resolvedModelId.slice(0, separator) as ProviderId;
    const modelId = resolvedModelId.slice(separator + 1);
    const provider = this.registry[providerId];
    if (!provider) {
      throw new Error(
        `unsupported provider "${providerId}". Use "gateway" or "openrouter".`
      );
    }
    const model = provider(modelId);

    const { output } = await generateText({
      model,
      system: input.rubric,
      prompt: buildReviewInput(input),
      output: Output.object({
        schema: RawModelOutputSchema,
        name: 'code_review_output',
        description: 'Structured review findings and correctness verdict',
      }),
    });

    return {
      raw: output,
      text: JSON.stringify(output),
      resolvedModel: resolvedModelId,
    };
  }
}

export function createOpenAICompatibleReviewProvider(
  options: OpenAICompatibleProviderOptions = {}
): ReviewProvider {
  return new OpenAICompatibleReviewProvider(options);
}
