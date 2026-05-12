// @vitest-environment happy-dom

import type {
  ProviderPolicyTelemetry,
  ReviewRunListResponse,
  ReviewStatusResponse,
} from '@review-agent/review-types';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewRoom } from './review-room';

const replace = vi.fn();
const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({ refresh, replace }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

class MockEventSource {
  static readonly CLOSED = 2;
  readonly readyState = 0;

  addEventListener(): void {}

  close(): void {}
}

const telemetry: ProviderPolicyTelemetry = {
  policyVersion: 'provider-policy.v1',
  requestedModel: 'gpt-5.2',
  resolvedModel: 'gpt-5.2',
  route: 'gateway',
  finalProvider: 'openai',
  fallbackOrder: ['openai', 'anthropic'],
  fallbackUsed: false,
  maxInputChars: 200_000,
  maxOutputTokens: 4096,
  timeoutMs: 120_000,
  maxAttempts: 2,
  retention: 'zdrEnforced',
  zdrRequired: true,
  disallowPromptTraining: true,
  failureClass: 'none',
  totalLatencyMs: 1200,
  attempts: [
    {
      route: 'gateway',
      model: 'gpt-5.2',
      provider: 'openai',
      status: 'success',
      latencyMs: 1200,
      generationId: 'gen_123',
      usage: {
        status: 'reported',
        inputTokens: 1200,
        outputTokens: 320,
        totalTokens: 1520,
        costUsd: 0.0034,
      },
    },
  ],
  usage: {
    status: 'reported',
    inputTokens: 1200,
    outputTokens: 320,
    totalTokens: 1520,
    costUsd: 0.0034,
  },
};

function reviewStatus(
  providerTelemetry: ProviderPolicyTelemetry | undefined
): ReviewStatusResponse {
  const resultTelemetry = providerTelemetry ?? telemetry;
  return {
    reviewId: 'review-1',
    status: 'completed',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_060_000,
    result: {
      findings: [],
      overallCorrectness: 'patch is correct',
      overallExplanation: 'The review completed without findings.',
      overallConfidenceScore: 0.91,
      metadata: {
        provider: 'openaiCompatible',
        modelResolved: 'gpt-5.2',
        executionMode: 'remoteSandbox',
        promptPack: 'default',
        gitContext: {
          mode: 'diff',
          baseRef: 'main',
          commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        providerTelemetry: resultTelemetry,
      },
    },
    summary: {
      reviewId: 'review-1',
      status: 'completed',
      request: {
        provider: 'openaiCompatible',
        executionMode: 'remoteSandbox',
        targetType: 'uncommittedChanges',
        outputFormats: ['json', 'markdown'],
        model: 'gpt-5.2',
      },
      findingCount: 0,
      artifactFormats: ['json'],
      publicationCount: 0,
      modelResolved: 'gpt-5.2',
      ...(providerTelemetry ? { providerTelemetry } : {}),
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_060_000,
    },
    publications: [],
    triage: [],
    artifacts: [],
  };
}

function runs(): ReviewRunListResponse {
  return {
    runs: [
      {
        reviewId: 'review-1',
        status: 'completed',
        request: {
          provider: 'openaiCompatible',
          executionMode: 'remoteSandbox',
          targetType: 'uncommittedChanges',
          outputFormats: ['json', 'markdown'],
          model: 'gpt-5.2',
        },
        findingCount: 0,
        artifactFormats: ['json'],
        publicationCount: 0,
        modelResolved: 'gpt-5.2',
        providerTelemetry: telemetry,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_060_000,
      },
    ],
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  replace.mockClear();
  refresh.mockClear();
});

describe('ReviewRoom', () => {
  it('renders provider policy telemetry in the metadata tab', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            reviewId: 'review-1',
            target: {
              owner: 'owner',
              repo: 'repo',
              repositoryId: 1,
              installationId: 2,
              commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
            items: [],
            existingPublications: [],
            summary: { pullRequestCommentCount: 0, blockedCount: 0 },
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      })
    );

    render(
      <ReviewRoom
        runs={{ ok: true, data: runs(), serviceUrl: 'http://localhost:3042' }}
        selected={{
          ok: true,
          data: reviewStatus(telemetry),
          serviceUrl: 'http://localhost:3042',
        }}
        selectedReviewId="review-1"
      />
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Metadata' }));

    expect(screen.getByText('provider-policy.v1')).toBeTruthy();
    expect(screen.getByText('gateway')).toBeTruthy();
    expect(screen.getByText('openai')).toBeTruthy();
    expect(screen.getByText('not used')).toBeTruthy();
    expect(screen.getByText('1200ms')).toBeTruthy();
    expect(screen.getByText('120000ms')).toBeTruthy();
    expect(
      screen.getByText('1200 in / 320 out / 1520 total / $0.003400')
    ).toBeTruthy();
    expect(screen.getByText('zdrEnforced')).toBeTruthy();
  });

  it('falls back to result metadata when the summary has no provider telemetry', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('fetch', vi.fn());

    render(
      <ReviewRoom
        runs={{ ok: true, data: runs(), serviceUrl: 'http://localhost:3042' }}
        selected={{
          ok: true,
          data: reviewStatus(undefined),
          serviceUrl: 'http://localhost:3042',
        }}
        selectedReviewId="review-1"
      />
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Metadata' }));

    expect(screen.getByText('provider-policy.v1')).toBeTruthy();
    expect(screen.getByText('zdrEnforced')).toBeTruthy();
  });
});
