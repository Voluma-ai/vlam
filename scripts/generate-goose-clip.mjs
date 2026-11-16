#!/usr/bin/env node
/**
 * Regenerates VLAM's own 4DGS demo clip, `assets/goose-walk/`, from
 * `assets/goose.sog`: the pixel-art goose walking in place and honking, as
 * a looping Faltwerk `.csgs` stream (see `src/tools/csgs/goose-walk.ts`).
 *
 *   node scripts/generate-goose-clip.mjs [--out <dir>] [--preview <dir>]
 *
 * The output is deterministic and checked in, so this only needs to run
 * when the animation or the encoder changes. `--preview` also writes a PNG
 * strip of evaluated frames (side view, points only) for a quick look.
 *
 * The builder is TypeScript shared with the unit tests; esbuild bundles it
 * for Node, and sharp stands in for the browser's WebP decoder.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import sharp from 'sharp';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const outDir = resolve(root, argument('--out') ?? 'assets/goose-walk');
const previewDir = argument('--preview');

// parseSog decodes WebP through WebCodecs when there is no canvas.
globalThis.ImageDecoder = class {
  constructor({ data }) {
    this.data = data;
  }
  async decode() {
    const { data, info } = await sharp(this.data)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      image: {
        codedWidth: info.width,
        codedHeight: info.height,
        copyTo: async (target) => void target.set(data),
        close() {},
      },
    };
  }
  close() {}
};

const bundle = join(root, '.tmp', 'generate-goose-clip.bundle.mjs');
await build({
  stdin: {
    contents: `
      export { buildGooseWalk } from './src/tools/csgs/goose-walk';
      export { parseSog } from './src/lib/formats/sog';
      export {
        CsgsDecoder, createCsgsFrameBuffers, evaluateCsgsFrame, prepareCsgsSection,
      } from './src/lib/formats/csgs';
      export { csgsGpuHalfSafe } from './src/lib/formats/csgs/csgs-gpu-layout';
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'warning',
});
const tools = await import(pathToFileURL(bundle).href);

const sog = readFileSync(join(root, 'assets', 'goose.sog'));
const data = await tools.parseSog(
  sog.buffer.slice(sog.byteOffset, sog.byteOffset + sog.byteLength),
);
const clip = tools.buildGooseWalk(data);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'scene_goose-walk.json'), JSON.stringify(clip.scene, null, 2) + '\n');
let total = 0;
clip.files.forEach((bytes, index) => {
  writeFileSync(join(outDir, clip.scene.sections[index].url), bytes);
  total += bytes.length;
  console.log(`${clip.scene.sections[index].url}  ${(bytes.length / 1024).toFixed(0)} kB`);
});

// Decode what was written, as a browser would, and report GPU eligibility.
const decoder = new tools.CsgsDecoder();
const prepared = clip.files.map((bytes) =>
  tools.prepareCsgsSection(decoder.decode(bytes), decoder.params),
);
const frames = clip.scene.sections.reduce((sum, section) => sum + section.nframes, 0);
console.log(
  `${data.count} splats, ${frames} frames at ${clip.scene.fps} fps, ` +
    `${(total / 1e6).toFixed(2)} MB → ${outDir}\n` +
    `GPU-eligible: ${prepared.every((section) => tools.csgsGpuHalfSafe(section))}`,
);

if (previewDir) {
  mkdirSync(previewDir, { recursive: true });
  const size = 256;
  const shots = 16;
  const strip = Buffer.alloc(size * shots * size * 3, 46);
  const buffers = tools.createCsgsFrameBuffers(data.count);
  for (let shot = 0; shot < shots; shot++) {
    const frame = (shot * frames) / shots;
    const section = prepared.find((s) => frame >= s.g0 && frame < s.g0 + s.nframes);
    const evaluated = tools.evaluateCsgsFrame(section, frame, buffers);
    const depth = new Float32Array(size * size).fill(-Infinity);
    for (let i = 0; i < evaluated.count; i++) {
      if (evaluated.colors[i * 4 + 3] < 100) continue;
      const x = Math.round(size / 2 + evaluated.positions[i * 3] * size * 0.8);
      const y = Math.round(size * 0.92 - evaluated.positions[i * 3 + 1] * size * 0.8);
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      if (evaluated.positions[i * 3 + 2] <= depth[y * size + x]) continue;
      depth[y * size + x] = evaluated.positions[i * 3 + 2];
      strip.set(
        evaluated.colors.subarray(i * 4, i * 4 + 3),
        (y * size * shots + shot * size + x) * 3,
      );
    }
  }
  const file = join(resolve(previewDir), 'goose-walk-strip.png');
  mkdirSync(dirname(file), { recursive: true });
  await sharp(strip, { raw: { width: size * shots, height: size, channels: 3 } })
    .png()
    .toFile(file);
  console.log(`preview → ${file}`);
}
