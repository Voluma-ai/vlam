#!/usr/bin/env node
/**
 * Writes the procedural goose (`src/viewer/goose-procedural.ts`) as a
 * skinned, animated `KHR_gaussian_splatting` glTF (`src/viewer/goose-gltf.ts`).
 *
 *   node scripts/export-goose-glb.mjs [--out <file>]
 *
 * Default output: `.tmp/benchmark-assets/procedural-goose.glb`, which the
 * dev server serves at `/benchmark-assets/procedural-goose.glb`. The file is
 * about 20 MB and is not checked in.
 *
 * The generator is TypeScript shared with the viewer; esbuild bundles it for
 * Node, with three left external.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const out = resolve(root, argument('--out') ?? '.tmp/benchmark-assets/procedural-goose.glb');

const bundle = join(root, '.tmp', 'export-goose-glb.bundle.mjs');
await build({
  stdin: {
    contents: `export { buildGooseGlb } from './src/viewer/goose-gltf';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['three', 'three/*'],
  outfile: bundle,
  logLevel: 'warning',
});
const { buildGooseGlb } = await import(pathToFileURL(bundle).href);

const started = performance.now();
const { glb, splats, bones, clips } = buildGooseGlb();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, glb);
console.log(
  `${splats} splats, ${bones} bones, clips ${clips.join(', ')}: ` +
    `${(glb.byteLength / 1e6).toFixed(1)} MB in ${((performance.now() - started) / 1000).toFixed(1)} s → ${out}`,
);
