import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { viewerDevPlugin } from '../site/.vitepress/viewer-dev-plugin';
import { benchmarkDevPlugin } from '../site/.vitepress/benchmark-dev-plugin';

// Start a fresh server per variant. This alias also applies to Vite's worker
// bundle, unlike runtime query parameters on the viewer page.
const root = resolve(import.meta.dirname, '..');
const variant = process.env.VLAM_EXPERIMENT ?? 'baseline';
const permitted = new Set([
  'baseline',
  'skip-empty',
  'bounded-threshold',
  'heap',
  'one-pass',
  'rad-decode-2',
  'rad-decode-4',
  'exact-stream',
  'approximate-sh-stream',
  'first-vertex',
]);
if (!permitted.has(variant)) throw new Error(`Unknown VLAM experiment: ${variant}`);

export default defineConfig({
  root,
  plugins: [benchmarkDevPlugin(), viewerDevPlugin()],
  publicDir: 'assets',
  resolve: {
    dedupe: ['three'],
    alias: [
      ...(process.env.VLAM_SPARK_VERSION === '2.1.0'
        ? [
            {
              find: '@sparkjsdev/spark',
              replacement: resolve(root, '.tmp/spark-2.1/package/dist/spark.module.js'),
            },
          ]
        : []),
      {
        // Imports are relative in the library and viewer; an absolute-file
        // alias alone misses them before Vite resolves the importer path.
        find: /^.*\/experiments(?:\.ts)?$/,
        replacement: resolve(root, 'src/lib/internal/experiments.benchmark.ts'),
      },
    ],
  },
  define: { __VLAM_EXPERIMENT__: JSON.stringify(variant) },
});
