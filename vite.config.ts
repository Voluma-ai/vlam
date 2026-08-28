import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * Viewer production build only. Local `npm run dev` is VitePress on :5170
 * (docs + `/demo` via site/.vitepress/viewer-dev-plugin.ts).
 *
 * Docs-site packaging sets `VLAM_VIEWER_BASE=/demo/` and outDir under dist-site.
 */
const repoRoot = dirname(fileURLToPath(import.meta.url));
const viewerHtml = resolve(repoRoot, 'src/viewer/index.html');
const viewerBase = process.env.VLAM_VIEWER_BASE ?? '/';
const viewerOutDir = process.env.VLAM_VIEWER_OUT ?? 'dist-viewer';

/**
 * Vite emits nested HTML next to its source path. The site expects
 * `index.html` at the viewer outDir root (`dist-site/demo/`).
 */
function flattenViewerHtml(): Plugin {
  return {
    name: 'vlam-flatten-viewer-html',
    writeBundle(options) {
      const outDir = options.dir ?? resolve(repoRoot, viewerOutDir);
      const nested = join(outDir, 'src/viewer/index.html');
      if (!existsSync(nested)) return;
      renameSync(nested, join(outDir, 'index.html'));
      rmSync(join(outDir, 'src'), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  base: viewerBase,
  plugins: [flattenViewerHtml()],
  // Serve the repo's assets/ directory as static files, so the viewer can
  // fetch e.g. /goose.ply directly. Large local captures do not go here -
  // drop their folder onto the viewer instead (StreamedSplatMesh.loadLocal),
  // which streams them off disk with no server and no copy.
  publicDir: 'assets',
  // `three/webgpu` and `three` are two entry points of one package that share
  // `three.core.js`, so class identity holds between them. A *second* copy of
  // three would break that - which is exactly what a linked (rather than
  // installed) `@voluma/three-transform-gizmo` brings in via its own
  // devDependency.
  resolve: { dedupe: ['three'] },
  build: {
    // Keep the viewer build out of ./dist - that directory belongs to the
    // library build (scripts/vite.config.lib.ts), which empties it.
    outDir: viewerOutDir,
    emptyOutDir: true,
    rollupOptions: {
      input: viewerHtml,
      output: {
        // Split the deployable SPA so the library (viewer) can cache
        // independently of viewer UI churn. Paths are normalized for Windows.
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
