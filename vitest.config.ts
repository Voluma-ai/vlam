import { defineConfig } from 'vitest/config';

/** Dev-only unit tests; not part of the published package. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Coverage tracks the published library only; the demo is exercised
      // visually (see AGENTS.md verification workflow), not by unit tests.
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/__tests__/**'],
      reporter: ['text', 'cobertura'],
      reportsDirectory: 'coverage',
    },
  },
});
