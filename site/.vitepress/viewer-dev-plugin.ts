import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const siteDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(siteDir, '../..');
const assetsDir = path.join(repoRoot, 'assets');
const repoRootFs = repoRoot.replace(/\\/g, '/');

/**
 * Runnable example apps (site/examples/*.md links into these). Each shell
 * loads the very sample file its documentation page inlines, so a reader
 * cannot be shown code that differs from what they just watched run.
 */
export const EXAMPLE_APPS = [
  'first-viewer',
  'open-local-file',
  'big-scenes',
  'click-the-world',
  'change-the-look',
  'splats-and-objects',
  'stand-on-surface',
  'select-and-cut',
  'fast-on-phones',
  'in-vr',
  'many-captures',
  'collision-walk',
  'custom-effect',
  'depth-of-field',
  'relight',
  'tiny-planet',
  'frame-the-camera',
  'annotations',
  'webgl-fallback',
  'share-a-viewpoint',
  'react-viewer',
] as const;

/** Package-name aliases that match docs/guide/samples/tsconfig.json. Longest specifier first. */
export function vlamPackageAliases(fromRoot: string) {
  const lib = (file: string) => path.join(fromRoot, 'src/lib', file);
  return [
    { find: '@voluma/vlam/static-lod', replacement: lib('static-lod/index.ts') },
    { find: '@voluma/vlam/streaming', replacement: lib('streaming/index.ts') },
    { find: '@voluma/vlam/selection', replacement: lib('selection/index.ts') },
    { find: '@voluma/vlam/loaders', replacement: lib('loaders/index.ts') },
    { find: '@voluma/vlam/unified', replacement: lib('unified/index.ts') },
    { find: '@voluma/vlam/effects', replacement: lib('effects/index.ts') },
    { find: '@voluma/vlam', replacement: lib('core/index.ts') },
  ];
}

const HTML_PAGES: Readonly<Record<string, string>> = {
  '/demo': 'src/viewer/index.html',
  '/demo/': 'src/viewer/index.html',
  '/demo/index.html': 'src/viewer/index.html',
  '/chunk-harness.html': 'src/viewer/chunk-harness.html',
  '/unified-harness.html': 'src/viewer/unified-harness.html',
  ...Object.fromEntries(
    EXAMPLE_APPS.flatMap((slug) => {
      const file = `example-apps/${slug}/index.html`;
      return [
        [`/examples/live/${slug}`, file],
        [`/examples/live/${slug}/`, file],
        [`/examples/live/${slug}/index.html`, file],
      ];
    }),
  ),
};

const ASSET_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.sog': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.spz': 'application/octet-stream',
  '.splat': 'application/octet-stream',
  '.ksplat': 'application/octet-stream',
  '.rad': 'application/octet-stream',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

function contentType(filePath: string): string {
  return ASSET_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Rewrite script URLs so Vite can load them from the repo root: the viewer's
 * absolute `/src/…`, and the example shells' `../../docs/…`, which is correct
 * on disk (what the production build resolves) but not against the URL the
 * shell is served at.
 */
function rewriteRepoScripts(html: string): string {
  return html
    .replaceAll('src="/src/', `src="/@fs/${repoRootFs}/src/`)
    .replaceAll('src="../../docs/', `src="/@fs/${repoRootFs}/docs/`);
}

/**
 * Serve the interactive viewer (and GPU harnesses) from the VitePress dev
 * server on the same port, production already nests the viewer at `/demo/`.
 */
export function viewerDevPlugin(): Plugin {
  return {
    name: 'vlam-viewer-dev',
    config() {
      return {
        server: {
          fs: { allow: [repoRoot] },
        },
        // The example samples import the package name an embedder would write,
        // not a relative path, that is the point of them. Map it to the
        // source tree, exactly as docs/guide/samples/tsconfig.json does for
        // the type-check. Longest specifier first: alias matching is ordered.
        resolve: {
          alias: vlamPackageAliases(repoRoot),
          dedupe: ['three'],
        },
      };
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();

        const requested = new URL(req.url ?? '/', 'http://localhost');
        const pathname = requested.pathname;

        const htmlFile = HTML_PAGES[pathname];
        if (htmlFile !== undefined) {
          try {
            let html = fs.readFileSync(path.join(repoRoot, htmlFile), 'utf8');
            html = rewriteRepoScripts(html);
            const transformUrl = pathname.endsWith('.html')
              ? pathname
              : pathname.endsWith('/')
                ? `${pathname}index.html`
                : `${pathname}/`;
            html = await server.transformIndexHtml(transformUrl, html);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(html);
            return;
          } catch (error) {
            next(error);
            return;
          }
        }

        // Repo `assets/` at site root (goose.sog, logos the viewer loads as `/…`).
        if (
          pathname.startsWith('/@') ||
          pathname.startsWith('/node_modules') ||
          pathname.startsWith('/.vitepress') ||
          pathname.startsWith('/api') ||
          pathname.includes('..')
        ) {
          return next();
        }

        // Let Vite transform module imports (e.g. `/vlam-light.png?import` from
        // the home page), serving the raw file here breaks VitePress routing.
        const q = requested.searchParams;
        if (
          q.has('import') ||
          q.has('url') ||
          q.has('raw') ||
          [...q.keys()].some((k) => k.startsWith('vue'))
        ) {
          return next();
        }

        const assetPath = path.normalize(path.join(assetsDir, pathname));
        if (!assetPath.startsWith(assetsDir)) return next();
        if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) return next();

        res.statusCode = 200;
        res.setHeader('Content-Type', contentType(assetPath));
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        fs.createReadStream(assetPath).pipe(res);
      });
    },
  };
}

/** Local mkcert pair from the repo root, when present (phone / WebGPU HTTPS). */
export function localHttpsCertificate(): { key: Buffer; cert: Buffer } | undefined {
  const key = path.join(repoRoot, 'localhost+5-key.pem');
  const cert = path.join(repoRoot, 'localhost+5.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) return undefined;
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}
