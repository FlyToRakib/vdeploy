import { defineConfig } from 'vitest/config';

// eslint-disable-next-line no-restricted-syntax -- vitest requires a default export
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test-helpers.ts', 'src/index.ts'],
      // The policy engine is the security boundary (§34.2): a gap is a breach.
      thresholds: {
        'src/policy/**': { branches: 100, functions: 100, lines: 100, statements: 100 },
      },
    },
  },
});
