import type { ReviewResult } from '@review-agent/review-types';
import { ConvexHttpClient } from 'convex/browser';

type ConvexClientLike = {
  mutation(functionName: unknown, ...args: unknown[]): Promise<unknown>;
  query?(functionName: unknown, ...args: unknown[]): Promise<unknown>;
};

export type ConvexBridgeOptions = {
  url?: string;
  client?: ConvexClientLike;
  functionName?: string;
  readFunctionName?: string;
  healthFunctionName?: string;
};

export type MirrorWritePayload = {
  reviewId: string;
  provider: string;
  model: string;
  findingsCount: number;
  overallCorrectness: string;
  summary: string;
  completedAt: number;
};

export type MirrorReadPayload = {
  reviewId: string;
  provider: string;
  model: string;
  findingsCount: number;
  overallCorrectness: string;
  summary: string;
  completedAt: number;
};

function isMirrorReadPayload(value: unknown): value is MirrorReadPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.reviewId === 'string' &&
    typeof candidate.provider === 'string' &&
    typeof candidate.model === 'string' &&
    typeof candidate.findingsCount === 'number' &&
    typeof candidate.overallCorrectness === 'string' &&
    typeof candidate.summary === 'string' &&
    typeof candidate.completedAt === 'number'
  );
}

export type ConvexBridgeHealth = {
  enabled: boolean;
  reachable: boolean;
  latencyMs?: number;
  detail: string;
};

export class ConvexMetadataBridge {
  private readonly client: ConvexClientLike | null;
  private readonly functionName: string;
  private readonly readFunctionName: string;
  private readonly healthFunctionName: string;

  constructor(options: ConvexBridgeOptions = {}) {
    const url = options.url ?? process.env.CONVEX_URL;
    this.client = options.client ?? (url ? new ConvexHttpClient(url) : null);
    this.functionName = options.functionName ?? 'reviewMetadata:mirrorWrite';
    this.readFunctionName =
      options.readFunctionName ?? 'reviewMetadata:readSummary';
    this.healthFunctionName =
      options.healthFunctionName ?? 'reviewMetadata:health';
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  async mirrorWrite(reviewId: string, result: ReviewResult): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    const payload: MirrorWritePayload = {
      reviewId,
      provider: result.metadata.provider,
      model: result.metadata.modelResolved,
      findingsCount: result.findings.length,
      overallCorrectness: result.overallCorrectness,
      summary: result.overallExplanation,
      completedAt: Date.now(),
    };

    try {
      await this.client.mutation(this.functionName, payload);
      return true;
    } catch (error) {
      console.warn(
        `[review-convex-bridge] non-blocking mirror write failed: ${String(error)}`
      );
      return false;
    }
  }

  async readSummary(reviewId: string): Promise<MirrorReadPayload | null> {
    if (!this.client || !this.client.query) {
      return null;
    }
    try {
      const result = await this.client.query(this.readFunctionName, {
        reviewId,
      });
      if (!isMirrorReadPayload(result)) {
        return null;
      }
      return result;
    } catch (error) {
      console.warn(
        `[review-convex-bridge] non-blocking mirror read failed: ${String(error)}`
      );
      return null;
    }
  }

  async health(): Promise<ConvexBridgeHealth> {
    if (!this.client) {
      return {
        enabled: false,
        reachable: false,
        detail: 'Convex metadata bridge disabled (missing CONVEX_URL)',
      };
    }
    if (!this.client.query) {
      return {
        enabled: true,
        reachable: false,
        detail: 'Convex query client is unavailable',
      };
    }

    const startedAt = Date.now();
    try {
      await this.client.query(this.healthFunctionName, {});
      return {
        enabled: true,
        reachable: true,
        latencyMs: Date.now() - startedAt,
        detail: 'Convex metadata bridge is reachable',
      };
    } catch (error) {
      return {
        enabled: true,
        reachable: false,
        latencyMs: Date.now() - startedAt,
        detail: `Convex metadata bridge health check failed: ${String(error)}`,
      };
    }
  }
}
