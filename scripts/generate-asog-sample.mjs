#!/usr/bin/env node
/**
 * Writes the "Play an Animated SOG clip" example's default clip,
 * `assets/asog-sample/synthetic-ball.asog`: a small synthetic Animated SOG
 * file (a ball of splats, a quarter static, the rest living a fraction of a
 * second each and swinging about anchors near the centre), made by the
 * dev-only writer in `src/tools/asog/encode-asog.ts`, with a synthetic
 * soundtrack (a short tone every half second, rising in pitch through the
 * clip, so its sync with the motion can be heard). License-clear: no capture
 * or recording goes into it.
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
  const bytes = await encodeAsog(manifest, streams, {
    mime: 'audio/wav',
    bytes: syntheticSoundtrack(duration),
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  console.log(`${out}: ${(bytes.length / 1e6).toFixed(2)} MB`);
} finally {
  rmSync(bundle, { force: true });
}

/**
 * A mono 16-bit WAV of `duration` seconds at 11025 Hz: a 120 ms tone at
 * every half second, its pitch rising a semitone per tone from A4, so a
 * listener hears where in the clip the sound is.
 */
function syntheticSoundtrack(duration) {
  const rate = 11025;
  const samples = Math.round(duration * rate);
  const wav = new Uint8Array(44 + samples * 2);
  const view = new DataView(wav.buffer);
  const text = (at, value) => [...value].forEach((c, i) => (wav[at + i] = c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  const tone = 0.12;
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const beat = Math.floor(t * 2);
    const local = t - beat / 2;
    let value = 0;
    if (local < tone) {
      const frequency = 440 * 2 ** (beat / 12);
      const envelope = Math.sin((Math.PI * local) / tone); // no clicks at the edges
      value = 0.3 * envelope * Math.sin(2 * Math.PI * frequency * local);
    }
    view.setInt16(44 + i * 2, Math.round(value * 32767), true);
  }
  return wav;
}
