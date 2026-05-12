import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const appDir = dirname(fileURLToPath(import.meta.url));
const buildIdPattern = /^(?=.{1,128}$)(?=.*[A-Za-z0-9])[A-Za-z0-9._-]+$/;

function resolveBuildId(): string {
  const buildId =
    process.env.REVIEW_WEB_BUILD_ID ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GITHUB_SHA ??
    'local';

  if (!buildIdPattern.test(buildId)) {
    throw new Error(
      'Review Room build IDs must be 1-128 characters, include at least one letter or number, and contain only letters, numbers, dots, underscores, or hyphens.'
    );
  }

  return buildId;
}

const nextConfig: NextConfig = {
  typedRoutes: true,
  generateBuildId: async () => resolveBuildId(),
  turbopack: {
    root: resolve(appDir, '../..'),
  },
};

export default nextConfig;
