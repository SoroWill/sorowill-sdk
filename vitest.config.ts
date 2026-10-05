import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 30000,
    exclude: ['src/react/**/*.test.tsx', 'node_modules/**'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      // Include all source files so uncovered files are reported, not just
      // those that happen to be imported by at least one test.
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        // React bindings are browser-only; covered by a separate jsx env.
        'src/react/**',
      ],
      reporter: ['text', 'lcov'],
      // Modest baseline thresholds so CI fails if coverage regresses.
      // Raise these as coverage improves.
      thresholds: {
        lines: 77,
        functions: 76.5,
        branches: 72,
        statements: 77,
      },
    },
  },
});
