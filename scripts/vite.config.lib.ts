import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const repoRoot = resolve(import.meta.dirname, '..');

/**
 * Drops sourcemaps for chunks that were never emitted.
 *
 * The three workers are inlined (`?worker&inline`), so their code becomes a
 * string literal inside the importing chunk and the worker `.js` is discarded -
 * but Vite still writes the map, leaving ~420 KB of `dist/assets/*.js.map`
 * pointing at files that do not exist. There is no config knob for this:
 * `bundleWorkerEntry` sets `sourcemap: config.build.sourcemap` *after* spreading
 * `worker.rollupOptions.output`, so the option cannot be overridden.
 *
 * The inlined worker string still ends with its own `//# sourceMappingURL=`
 * comment. That reference was already dead before this plugin - a `blob:` worker
 * resolves it against the page origin, not the package directory - and removing
 * it here would shift `dist/index.js` byte offsets out from under
 * `index.js.map`, so it stays.
 */
function dropOrphanWorkerMaps(): Plugin {
  return {
    name: 'vlam:drop-orphan-worker-maps',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        if (name.endsWith('.js.map') && !bundle[name.slice(0, -4)]) delete bundle[name];
      }
    },
  };
}

const syntheticNamespaceAdapter = /import\([^)]*\)\.then\(\s*\(([\w$]+)\)\s*=>\s*\1\.[\w$]+\s*\)/;

/**
 * Guards every emitted chunk against Rollup's synthetic internal namespaces.
 *
 * The published core entry is consumed by other bundlers. An adapter such as
 * `.then(module => module.<synthetic export>)` can be tree-shaken incorrectly
 * when the package is rebundled. Stable named/default exports do not need it.
 */
function verifyStableDynamicImports(): Plugin {
  return {
    name: 'vlam:verify-stable-dynamic-imports',
    generateBundle(_options, bundle) {
      const streaming = bundle['streaming.js'];
      if (streaming?.type !== 'chunk') {
        this.error('The library build must emit dist/streaming.js as a JavaScript chunk.');
      }
      if (!streaming.code.includes('import("./formats/lcc.js")')) {
        this.error('dist/streaming.js must lazy-load LCC through the public formats/lcc.js entry.');
      }
      if (!streaming.code.includes('import("./formats/rad.js")')) {
        this.error('dist/streaming.js must lazy-load RAD through the public formats/rad.js entry.');
      }
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        const adapter = output.code.match(syntheticNamespaceAdapter)?.[0];
        if (adapter) {
          this.error(
            `${output.fileName} contains an unstable synthetic namespace adapter: ${adapter}`,
          );
        }
      }
    },
  };
}

// Library build: ES module with three externalized (peer dependency).
// Type declarations are emitted separately via `tsc -p tsconfig.lib.json`.
export default defineConfig({
  root: repoRoot,
  plugins: [dropOrphanWorkerMaps(), verifyStableDynamicImports()],
  build: {
    lib: {
      // Core renderer plus optional loaders, streaming, unified, selection,
      // effects, and format subpaths. Format entries emit their own chunks
      // so a host that never imports them can leave them out. The inlined
      // load-worker lives behind `@voluma/vlam/loaders`, not the core entry.
      entry: {
        index: 'src/lib/core/index.ts',
        loaders: 'src/lib/loaders/index.ts',
        'static-lod': 'src/lib/static-lod/index.ts',
        streaming: 'src/lib/streaming/index.ts',
        unified: 'src/lib/unified/index.ts',
        selection: 'src/lib/selection/index.ts',
        effects: 'src/lib/effects/index.ts',
        'formats/ply': 'src/lib/formats/ply/index.ts',
        'formats/sog': 'src/lib/formats/sog/index.ts',
        'formats/rad': 'src/lib/formats/rad/index.ts',
        'formats/lcc': 'src/lib/formats/lcc/index.ts',
        'formats/spz': 'src/lib/formats/spz/index.ts',
        'formats/splat': 'src/lib/formats/splat/index.ts',
        'formats/ksplat': 'src/lib/formats/ksplat/index.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      // three and its subpath entries (three/webgpu, three/tsl) stay external.
      external: /^three(\/|$)/,
    },
    // Deliberate: JS source maps ship. They embed `sourcesContent`, so they
    // stand alone (nothing resolves back into `src/`, which `package.json#files`
    // does not publish) and a consumer can step through real library code. The
    // cost is ~1.7 MB of dist's ~2.6 MB, paid only by whoever fetches a `.map`.
    // Declaration maps are the opposite trade and are off - see tsconfig.lib.json.
    sourcemap: true,
    outDir: 'dist',
    emptyOutDir: true,
  },
  worker: {
    format: 'es',
  },
});
