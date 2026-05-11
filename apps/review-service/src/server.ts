import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { ConvexMetadataBridge } from '@review-agent/review-convex-bridge';
import { createCodexDelegateProvider } from '@review-agent/review-provider-codex';
import { createOpenAICompatibleReviewProvider } from '@review-agent/review-provider-openai';
import { ReviewWorker } from '@review-agent/review-worker';
import { createReviewServiceApp } from './app.js';

const app = createReviewServiceApp({
  providers: {
    codexDelegate: createCodexDelegateProvider(),
    openaiCompatible: createOpenAICompatibleReviewProvider(),
  },
  worker: new ReviewWorker(),
  bridge: new ConvexMetadataBridge(),
  uuid: randomUUID,
});

const port = Number.parseInt(process.env.PORT ?? '3042', 10);
console.error(`review-service listening on :${port}`);
serve({
  fetch: app.fetch,
  port,
});
