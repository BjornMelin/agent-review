import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const appDir = dirname(fileURLToPath(import.meta.url));
const buildId =
  process.env.REVIEW_WEB_BUILD_ID ??
  process.env.VERCEL_GIT_COMMIT_SHA ??
  process.env.GITHUB_SHA ??
  'local';

const nextConfig: NextConfig = {
  typedRoutes: true,
  generateBuildId: async () => buildId,
  turbopack: {
    root: resolve(appDir, '../..'),
  },
};

export default nextConfig;
