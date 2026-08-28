import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { EXAMPLE_APPS, vlamPackageAliases } from './site/.vitepress/viewer-dev-plugin';

/**
 * Production build of the runnable example apps → `/examples/live/<slug>/`.
 * Their documentation pages live in `site/examples/` and link here; the shells
 * load the same sample files those pages inline, so the code a reader copies is
 * the code they just watched run. In dev the same shells are served by
 * `viewerDevPlugin` on the VitePress port.
 */
export default defineConfig({
  root: 'example-apps',
  base: '/examples/live/',
  // No public dir: the examples fetch `/goose.sog` and `/favicon.ico` from the
  // site root, which build-site.mjs puts there. Copying assets/ in here would
  // just duplicate the capture under /examples/live/.
  publicDir: false,
  resolve: {
    // Matches docs/guide/samples/tsconfig.json - samples import the package
    // name, not a relative path. Longest specifier first.
    alias: vlamPackageAliases(import.meta.dirname),
    dedupe: ['three'],
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist-site/examples/live'),
    emptyOutDir: true,
    // The samples are written as flat scripts with top-level `await` - the
    // shortest honest way to show "load the scene, then render it", and what
    // their documentation pages tell readers to copy. Vite's default target
    // predates it, so state the floor the examples actually require.
    target: 'es2022',
    rollupOptions: {
      input: Object.fromEntries(
        EXAMPLE_APPS.map((slug) => [
          slug,
          resolve(import.meta.dirname, `example-apps/${slug}/index.html`),
        ]),
      ),
      output: {
        manualChunks(id) {
          const path = id.replace(/\\/g, '/');
          if (path.includes('/src/lib/')) return 'vlam';
          if (path.includes('/node_modules/three/')) return 'three';
          return undefined;
        },
      },
    },
  },
});
