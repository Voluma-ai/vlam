import { defineConfig } from 'vitest/config';
import { vlamPackageAliases } from './site/.vitepress/viewer-dev-plugin';

/**
 * Dev-only unit tests; not part of the published package.
 *
 * Sample tests import `@voluma/vlam` the way an embedder would. CI runs them
 * before `dist/` exists, so the package name maps to source.
 */
export default defineConfig({
  resolve: {
    alias: vlamPackageAliases(import.meta.dirname),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'docs/examples/samples/__tests__/**/*.test.ts'],
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
