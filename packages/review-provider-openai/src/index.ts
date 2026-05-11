import { createGateway } from '@ai-sdk/gateway';
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
import { generateText, Output } from 'ai';

export type OpenAICompatibleProviderOptions = {
  defaultModelId?: string;
  capabilities: ReviewProviderCapabilities;
  routes: readonly OpenAICompatibleRouteConfig[];
};

export type GatewayRouteConfig = {
  id: string;
  kind: 'gateway';
  displayName: string;
  apiKeyEnv: string;
  apiKey?: string | undefined;
  baseURL?: string | undefined;
};

export type OpenAICompatibleChatRouteConfig = {
  id: string;
  kind: 'openaiCompatibleChat';
  displayName: string;
  apiKeyEnv: string;
  apiKey?: string | undefined;
  baseURL: string;
  headers?: Record<string, string> | undefined;
  supportsStructuredOutputs?: boolean | undefined;
};

export type OpenAICompatibleRouteConfig =
  | GatewayRouteConfig
  | OpenAICompatibleChatRouteConfig;

type TextModel = Parameters<typeof generateText>[0]['model'];
type LanguageModelFactory = (modelId: string) => TextModel;
type ResolvedRouteConfig = OpenAICompatibleRouteConfig & {
  apiKey: string | undefined;
};

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

function nonEmptySecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveRouteApiKey(
  route: OpenAICompatibleRouteConfig
): string | undefined {
  return (
    nonEmptySecret(route.apiKey) ?? nonEmptySecret(process.env[route.apiKeyEnv])
  );
}

export class OpenAICompatibleReviewProvider implements ReviewProvider {
  id = 'openaiCompatible' as const;
  private readonly defaultModelId: string | undefined;
  private readonly capabilitiesPolicy: ReviewProviderCapabilities;
  private readonly factories = new Map<string, LanguageModelFactory>();
  private readonly routes = new Map<string, ResolvedRouteConfig>();

  constructor(options: OpenAICompatibleProviderOptions) {
    this.defaultModelId = options.defaultModelId;
    this.capabilitiesPolicy = options.capabilities;

    for (const route of options.routes) {
      const apiKey = resolveRouteApiKey(route);
      const resolvedRoute = { ...route, apiKey };
      this.routes.set(route.id, resolvedRoute);
      if (route.kind === 'gateway') {
        const gatewayOptions: { apiKey?: string; baseURL?: string } = {};
        if (apiKey) {
          gatewayOptions.apiKey = apiKey;
        }
        if (route.baseURL) {
          gatewayOptions.baseURL = route.baseURL;
        }
        const provider = createGateway(gatewayOptions);
        this.factories.set(route.id, (modelId) => provider(modelId));
      } else {
        const providerOptions: {
          baseURL: string;
          name: string;
          apiKey?: string;
          headers?: Record<string, string>;
          supportsStructuredOutputs: boolean;
        } = {
          baseURL: route.baseURL,
          name: route.id,
          supportsStructuredOutputs: route.supportsStructuredOutputs ?? true,
        };
        if (apiKey) {
          providerOptions.apiKey = apiKey;
        }
        if (route.headers) {
          providerOptions.headers = route.headers;
        }
        const provider = createOpenAICompatible(providerOptions);
        this.factories.set(route.id, (modelId) => provider.chatModel(modelId));
      }
    }
  }

  capabilities(): ReviewProviderCapabilities {
    return { ...this.capabilitiesPolicy };
  }

  private parseModelId(modelId: string):
    | {
        route: ResolvedRouteConfig;
        modelId: string;
      }
    | ProviderDiagnostic {
    const separator = modelId.indexOf(':');
    if (separator < 1 || separator === modelId.length - 1) {
      return {
        code: 'invalid_model_id',
        ok: false,
        severity: 'error',
        detail: `invalid model id "${modelId}". Expected "provider:model".`,
        remediation:
          'Use routed model ids like "gateway:openai/gpt-5" or "openrouter:openai/gpt-5".',
      };
    }

    const routeId = modelId.slice(0, separator);
    const route = this.routes.get(routeId);
    if (!route) {
      return {
        code: 'configuration_error',
        ok: false,
        severity: 'error',
        scope: routeId,
        detail: `unsupported provider "${routeId}" for openaiCompatible`,
        remediation: `Use one of: ${[...this.routes.keys()].join('|')}.`,
      };
    }

    const providerModelId = modelId.slice(separator + 1).trim();
    if (!providerModelId) {
      return {
        code: 'invalid_model_id',
        ok: false,
        severity: 'error',
        scope: routeId,
        detail: `invalid model id "${modelId}". Model segment is empty.`,
        remediation: `Use a non-empty ${routeId}:<model> identifier.`,
      };
    }

    return {
      route,
      modelId: providerModelId,
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
    if (!resolvedModelId) {
      diagnostics.push({
        code: 'configuration_error',
        ok: false,
        severity: 'error',
        detail: 'openaiCompatible requires a routed model id',
        remediation:
          'Create providers through the provider registry or provide a defaultModelId option.',
      });
      return diagnostics;
    }
    const parsed = this.parseModelId(resolvedModelId);
    if ('code' in parsed) {
      diagnostics.push(parsed);
      return diagnostics;
    }

    if (!parsed.route.apiKey) {
      diagnostics.push({
        code: 'auth_missing',
        ok: false,
        severity: 'error',
        scope: parsed.route.id,
        detail: `missing ${parsed.route.displayName} API key`,
        remediation: `Set ${parsed.route.apiKeyEnv} or provide an apiKey for ${parsed.route.id}.`,
      });
    }
    return diagnostics;
  }

  async doctor(): Promise<ProviderDiagnostic[]> {
    const diagnostics: ProviderDiagnostic[] = [];
    for (const route of this.routes.values()) {
      diagnostics.push(
        route.apiKey
          ? {
              code: 'auth_available',
              ok: true,
              severity: 'info',
              scope: route.id,
              detail: `${route.displayName} auth detected`,
            }
          : {
              code: 'auth_missing',
              ok: false,
              severity: 'error',
              scope: route.id,
              detail: `${route.apiKeyEnv} is not configured`,
              remediation: `Set ${route.apiKeyEnv} for ${route.id}:* model routing.`,
            }
      );
    }
    return diagnostics;
  }

  async run(input: ReviewProviderRunInput): Promise<ReviewProviderRunOutput> {
    const resolvedModelId = input.request.model ?? this.defaultModelId;
    if (!resolvedModelId) {
      throw new Error(
        'openaiCompatible requires a routed model id. Create providers through the provider registry or provide defaultModelId.'
      );
    }
    const parsed = this.parseModelId(resolvedModelId);
    if ('code' in parsed) {
      throw new Error(parsed.detail);
    }
    const provider = this.factories.get(parsed.route.id);
    if (!provider) {
      throw new Error(
        `provider route "${parsed.route.id}" is not configured for execution.`
      );
    }
    const model = provider(parsed.modelId);

    const { output } = await generateText({
      model,
      system: input.rubric,
      prompt: buildReviewInput(input),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
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
  options: OpenAICompatibleProviderOptions
): ReviewProvider {
  return new OpenAICompatibleReviewProvider(options);
}
