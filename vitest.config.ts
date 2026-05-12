import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'test/**/*.test.ts',
      'test/**/*.test.tsx',
      'apps/**/*.test.ts',
      'apps/**/*.test.tsx',
      'packages/**/*.test.ts',
      'packages/**/*.test.tsx',
      'packages/**/test/**/*.test.ts',
      'packages/**/test/**/*.test.tsx',
    ],
    reporters: ['default'],
    coverage: {
      enabled: false,
    },
  },
});
