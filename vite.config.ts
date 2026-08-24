import { defineConfig } from 'vite';

/**
 * Viewer production build only. Local `npm run dev` is VitePress on :5170
 * (docs + `/demo` via site/.vitepress/viewer-dev-plugin.ts).
 *
 * Docs-site packaging sets `VLAM_VIEWER_BASE=/demo/` and outDir under dist-site.
 */
const viewerBase = process.env.VLAM_VIEWER_BASE ?? '/';
const viewerOutDir = process.env.VLAM_VIEWER_OUT ?? 'dist-viewer';

export default defineConfig({
  base: viewerBase,
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
    // library build (vite.config.lib.ts), which empties it.
    outDir: viewerOutDir,
    emptyOutDir: true,
    rollupOptions: {
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
