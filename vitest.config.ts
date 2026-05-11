import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'test/**/*.test.ts',
      'apps/**/*.test.ts',
      'packages/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
    ],
    reporters: ['default'],
    coverage: {
      enabled: false,
    },
  },
});
