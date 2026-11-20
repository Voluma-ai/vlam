/**
 * An `.asog` (Animated SOG v1) **writer** for tests and the playback harness:
 * the mirror of `src/lib/formats/asog/parse-asog.ts`.
 *
 * A dev tool, not library code. It makes no attempt to fit or quantise a
 * capture: the caller hands it each stream's integers, and it does the
 * integer coding (delta, zigzag, byte planes), zlib and the container.
 * {@link syntheticAsogStreams} makes a small clip with real motion, so the
 * parser, the CPU motion and the GPU modifier can be checked on a
 * license-clear file.
 */
import type { AsogClipDesc, AsogManifest } from '../../lib/formats/asog';

/** One stream to write: row-major integers, `count × channels`. */
export interface AsogStreamInput {
  readonly name: string;
  readonly count: number;
  readonly channels: number;
  readonly values: ArrayLike<number>;
  /** Bytes per value (default: the fewest that hold every coded value). */
  readonly planes?: number;
  readonly delta?: boolean;
  readonly zigzag?: boolean;
}

/** Everything a file needs besides its streams. */
export type AsogManifestInput = Omit<AsogManifest, 'format' | 'version' | 'streams' | 'audio'>;

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function codeStream(input: AsogStreamInput): { raw: Uint8Array; planes: number } {
  const { count, channels, values, delta = false, zigzag = false } = input;
  const coded = new Float64Array(count * channels);
  let largest = 0;
  for (let c = 0; c < channels; c++) {
    let previous = 0;
    for (let i = 0; i < count; i++) {
      let x = values[i * channels + c]!;
      if (!Number.isInteger(x))
        throw new RangeError(`asog encode: ${input.name}[${i}] is not an integer.`);
      if (delta) {
        const d = x - previous;
        previous = x;
        x = d;
      }
      if (zigzag) x = x < 0 ? -2 * x - 1 : 2 * x;
      if (x < 0)
        throw new RangeError(`asog encode: ${input.name} has a negative value without zigzag.`);
      coded[c * count + i] = x;
      if (x > largest) largest = x;
    }
  }
  let planes = input.planes ?? 1;
  while (input.planes === undefined && largest >= 256 ** planes) planes++;
  const raw = new Uint8Array(count * channels * planes);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < count; i++) {
      let x = coded[c * count + i]!;
      for (let p = 0; p < planes; p++) {
        raw[(p * channels + c) * count + i] = x % 256;
        x = Math.floor(x / 256);
      }
    }
  }
  return { raw, planes };
}

/** Writes a complete `.asog` file. */
export async function encodeAsog(
  manifest: AsogManifestInput,
  streams: readonly AsogStreamInput[],
  audio?: { mime: string; bytes: Uint8Array },
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const descs: AsogManifest['streams'][number][] = [];
  let offset = 0;
  const pad = (): void => {
    const extra = (8 - (offset % 8)) % 8;
    if (extra) {
      parts.push(new Uint8Array(extra));
      offset += extra;
    }
  };
  for (const stream of streams) {
    const { raw, planes } = codeStream(stream);
    const compressed = await deflate(raw);
    descs.push({
      name: stream.name,
      count: stream.count,
      channels: stream.channels,
      planes,
      delta: stream.delta ?? false,
      zigzag: stream.zigzag ?? false,
      byteOffset: offset,
      byteLength: compressed.length,
    });
    parts.push(compressed);
    offset += compressed.length;
    pad();
  }
  let audioDesc: AsogManifest['audio'];
  if (audio) {
    audioDesc = { mime: audio.mime, byteOffset: offset, byteLength: audio.bytes.length };
    parts.push(audio.bytes);
    offset += audio.bytes.length;
  }
  const json = new TextEncoder().encode(
    JSON.stringify({
      format: 'asog',
      version: 1,
      ...manifest,
      ...(audioDesc ? { audio: audioDesc } : {}),
      streams: descs,
    }),
  );
  const payloadOffset = Math.ceil((64 + json.length) / 64) * 64;
  const file = new Uint8Array(payloadOffset + offset);
  file.set([0x41, 0x53, 0x4f, 0x47]);
  const view = new DataView(file.buffer);
  view.setBigUint64(16, 64n, true);
  view.setBigUint64(24, BigInt(json.length), true);
  view.setBigUint64(32, BigInt(payloadOffset), true);
  view.setBigUint64(40, BigInt(offset), true);
  file.set(json, 64);
  let at = payloadOffset;
  for (const part of parts) {
    file.set(part, at);
    at += part.length;
  }
  return file;
}

/** A small deterministic PRNG (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Options of {@link syntheticAsogStreams}. */
export interface SyntheticAsogOptions {
  /** Splats (default 4096). */
  count?: number;
  /** Clip length in seconds (default 2). */
  duration?: number;
  /** Frame rate (default 30). */
  fps?: number;
  /** SH coefficients per channel: 0, 3, 8 or 15 (default 8). */
  coeffs?: 0 | 3 | 8 | 15;
  /** Fraction of static splats (default 0.25). */
  staticFraction?: number;
  /** Clips sharing the timeline (default 1); splats are dealt round-robin. */
  clips?: number;
  seed?: number;
}

/**
 * A synthetic clip: a ball of splats in the y-down frame, a quarter static,
 * the rest living a fraction of a second each and swinging about anchors
 * near the centre, with real rotation and translation along the axis.
 */
export function syntheticAsogStreams(options: SyntheticAsogOptions = {}): {
  manifest: AsogManifestInput;
  streams: AsogStreamInput[];
} {
  const {
    count: n = 4096,
    duration = 2,
    fps = 30,
    coeffs = 8,
    staticFraction = 0.25,
    clips = 1,
    seed = 1,
  } = options;
  const rand = random(seed);
  const mins = [-0.7, -0.7, -0.7];
  const maxs = [0.7, 0.7, 0.7];
  const muScale = 2048;
  const logsigma = { min: Math.log(0.05), max: Math.log(0.6), bits: 8 };
  const motion = { qp: 2, qa: 8, sm: 2.45, midO: 3, midG: 2, mref_samples: 9, r_min: 0.02 };
  const scaleBook = Array.from({ length: 256 }, (_, i) => -6 + (i / 255) * 3.5);
  const sh0Book = Array.from({ length: 256 }, (_, i) => -2 + (i / 255) * 4);
  const shBook = Array.from({ length: 256 }, (_, i) => (i / 255 - 0.5) * 0.6);
  const paletteCount = coeffs ? 64 : 0;

  const means = new Array<number>(n * 3);
  const quats = new Array<number>(n * 3);
  const quatmode = new Array<number>(n);
  const scales = new Array<number>(n * 3);
  const sh0 = new Array<number>(n * 3);
  const opacity = new Array<number>(n);
  const shlabels = new Array<number>(n);
  const mu = new Array<number>(n);
  const sigma = new Array<number>(n);
  const anchor = new Array<number>(n * 3);
  const omega = new Array<number>(n * 9);
  const g = new Array<number>(n * 5);
  const flags = new Array<number>(n);
  const toLog = (x: number) => Math.sign(x) * Math.log1p(Math.abs(x));
  for (let i = 0; i < n; i++) {
    // A point in a ball of radius 0.5.
    let p: number[];
    do p = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
    while (p[0]! ** 2 + p[1]! ** 2 + p[2]! ** 2 > 1);
    for (let c = 0; c < 3; c++) {
      const v = toLog(p[c]! * 0.5);
      means[i * 3 + c] = Math.round(((v - mins[c]!) / (maxs[c]! - mins[c]!)) * 65535);
      scales[i * 3 + c] = 40 + Math.floor(rand() * 60);
      sh0[i * 3 + c] = Math.floor(rand() * 256);
    }
    // A random unit rotation, stored smallest-three: the largest component
    // (made positive) is left out, the other three kept in w x y z order.
    const q = [rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5];
    const length = Math.hypot(...q) || 1;
    let largest = 0;
    for (let k = 1; k < 4; k++) if (Math.abs(q[k]!) > Math.abs(q[largest]!)) largest = k;
    const sign = q[largest]! < 0 ? -1 : 1;
    const rest = q.filter((_, k) => k !== largest);
    for (let k = 0; k < 3; k++) {
      const value = (sign * rest[k]!) / length;
      quats[i * 3 + k] = Math.min(255, Math.max(0, Math.round((value / Math.SQRT2 + 0.5) * 255)));
    }
    quatmode[i] = largest;
    opacity[i] = 160 + Math.floor(rand() * 96);
    shlabels[i] = paletteCount ? Math.floor(rand() * paletteCount) : 0;
    const isStatic = rand() < staticFraction;
    flags[i] = (isStatic ? 1 : 0) | ((i % clips) << 1);
    mu[i] = Math.round(rand() * duration * muScale);
    sigma[i] = Math.floor(rand() * 256);
    for (let c = 0; c < 3; c++) anchor[i * 3 + c] = Math.round((rand() - 0.5) * 40);
    // Control points of a spin up to a few rad/s, their quantised integers.
    const axis = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
    const spin = isStatic ? 0 : 20 + rand() * 300;
    for (let k = 0; k < 3; k++) {
      const wobble = 1 + 0.3 * (rand() - 0.5);
      for (let c = 0; c < 3; c++) omega[i * 9 + k * 3 + c] = Math.round(axis[c]! * spin * wobble);
    }
    for (let j = 0; j < 5; j++) g[i * 5 + j] = isStatic ? 0 : Math.round((rand() - 0.5) * 80);
  }
  const shpalette = new Array<number>(paletteCount * coeffs * 3);
  for (let k = 0; k < shpalette.length; k++) shpalette[k] = Math.floor(rand() * 256);

  const clipDescs: AsogClipDesc[] = Array.from({ length: clips }, (_, c) => ({
    global: {
      frameStart: 0,
      activeTimeStart: c === 0 ? 0 : duration * 0.25,
      activeTimeEnd: c === 0 ? duration : duration * 0.9,
      coreTimeStart: c === 0 ? 0 : duration * 0.35,
      coreTimeEnd: c === 0 ? duration : duration * 0.8,
    },
    local: { frameStart: 0 },
    render:
      c === 0
        ? {}
        : {
            fadeInFrames: Math.round(0.1 * duration * fps),
            fadeOutFrames: Math.round(0.1 * duration * fps),
          },
  }));

  const streams: AsogStreamInput[] = [
    { name: 'means', count: n, channels: 3, values: means, planes: 2 },
    { name: 'quats', count: n, channels: 3, values: quats },
    { name: 'quatmode', count: n, channels: 1, values: quatmode },
    { name: 'scales', count: n, channels: 3, values: scales },
    { name: 'sh0', count: n, channels: 3, values: sh0 },
    { name: 'opacity', count: n, channels: 1, values: opacity },
    ...(coeffs
      ? [
          { name: 'shlabels', count: n, channels: 1, values: shlabels, planes: 2 },
          { name: 'shpalette', count: paletteCount, channels: coeffs * 3, values: shpalette },
        ]
      : []),
    { name: 'mu', count: n, channels: 1, values: mu, delta: true, zigzag: true },
    { name: 'logsigma', count: n, channels: 1, values: sigma },
    { name: 'anchor', count: n, channels: 3, values: anchor, zigzag: true },
    { name: 'omega', count: n, channels: 9, values: omega, zigzag: true },
    { name: 'g', count: n, channels: 5, values: g, zigzag: true },
    { name: 'flags', count: n, channels: 1, values: flags },
  ];
  return {
    manifest: {
      count: n,
      timeline: { frameRate: fps, durationSeconds: duration },
      clips: clipDescs,
      source: { format: 'vlam.synthetic', version: 1 },
      means: { mins, maxs },
      scales: { codebook: scaleBook },
      sh0: { codebook: sh0Book },
      ...(coeffs ? { shN: { codebook: shBook, count: paletteCount, coeffs } } : {}),
      mu: { scale: muScale },
      logsigma,
      motion,
    },
    streams,
  };
}

/** {@link syntheticAsogStreams} written as a file. */
export async function syntheticAsog(options: SyntheticAsogOptions = {}): Promise<Uint8Array> {
  const { manifest, streams } = syntheticAsogStreams(options);
  return encodeAsog(manifest, streams);
}
