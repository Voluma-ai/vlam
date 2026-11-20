#!/usr/bin/env node
/**
 * Writes the "Play an Animated SOG clip" example's default clip,
 * `assets/asog-sample/synthetic-ball.asog`: a small synthetic Animated SOG
 * file (a ball of splats, a quarter static, the rest living a fraction of a
 * second each and swinging about anchors near the centre), made by the
 * dev-only writer in `src/tools/asog/encode-asog.ts`. License-clear: no
 * capture goes into it.
 *
 *   node scripts/generate-asog-sample.mjs [--out <file>]
 *
 * The output is deterministic and checked in, so this only needs to run when
 * the writer changes. esbuild bundles the TypeScript writer for Node.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outIndex = process.argv.indexOf('--out');
const out = resolve(
  root,
  outIndex >= 0 ? process.argv[outIndex + 1] : 'assets/asog-sample/synthetic-ball.asog',
);

const bundle = join(root, '.tmp', `encode-asog-${process.pid}.mjs`);
mkdirSync(dirname(bundle), { recursive: true });
await build({
  entryPoints: [join(root, 'src/tools/asog/encode-asog.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'warning',
});
try {
  const { encodeAsog, syntheticAsogStreams } = await import(pathToFileURL(bundle).href);
  const duration = 4;
  const { manifest, streams } = syntheticAsogStreams({
    count: 30000,
    duration,
    fps: 30,
    coeffs: 8,
    seed: 7,
  });
  const bytes = await encodeAsog(manifest, streams);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  console.log(`${out}: ${(bytes.length / 1e6).toFixed(2)} MB`);
} finally {
  rmSync(bundle, { force: true });
}
