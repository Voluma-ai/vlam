/**
 * Decodes a whole `.asog` file (Animated SOG v1) into flat arrays: the
 * SOG v2 static attributes (centres, rotations, scales, colours, the SH
 * palette) and the TRiGS motion per splat, dequantised as format section 4.2
 * says. Three-free and worker-safe; zlib streams are inflated with the
 * platform's `DecompressionStream('deflate')`.
 *
 * Ported from the MIT-licensed reference decoder of
 * [animated-sog](https://github.com/arrival-space/animated-sog)
 * (`js/src/core/{decode,dequant,planes,inflate}.js`, Copyright (c) 2026
 * Arrival.Space). Unlike the reference, which packs half floats for its
 * GPU textures, the motion is kept in float32, and `m_ref` is computed from
 * those float32 control points (spec 4.2 asks a reduced-precision decoder
 * to use the values it stores).
 */
import { SH_C0, type SplatShData } from '../../core/splat-data';
import {
  ASOG_HEADER_SIZE,
  asogShBands,
  parseAsogHeader,
  parseAsogManifest,
  type AsogHeader,
  type AsogManifest,
  type AsogStreamDesc,
} from './asog-container';

/**
 * Floats of motion per splat in {@link AsogData.motion} (five RGBA texels):
 *
 * | floats | values |
 * |---|---|
 * | 0–3 | μ, σ, flags (bit 0 static, bits 1+ clip index), anchor x |
 * | 4–7 | anchor y, anchor z, O0 x, O0 y |
 * | 8–11 | O0 z, O1 x, O1 y, O1 z |
 * | 12–15 | O2 x, O2 y, O2 z, G0 |
 * | 16–19 | G1, G2, G3, G4 |
 *
 * @experimental
 */
export const ASOG_MOTION_FLOATS = 20;
/** Offsets into one splat's {@link ASOG_MOTION_FLOATS}. */
export const ASOG_MOTION = { mu: 0, sigma: 1, flags: 2, anchor: 3, omega: 6, g: 15 } as const;
/** Floats per clip in {@link AsogData.clips}. */
export const ASOG_CLIP_FLOATS = 8;

/**
 * A decoded `.asog` file.
 *
 * @experimental
 */
export interface AsogData {
  readonly header: AsogHeader;
  readonly manifest: AsogManifest;
  /** Splats. */
  readonly count: number;
  /** SH bands beyond DC (0 for none). */
  readonly shBands: 0 | 1 | 2 | 3;
  /** Canonical (unmoved) centres, xyz per splat, in the file's y-down frame. */
  readonly centers: Float32Array;
  /** Canonical rotations, unit quaternions as w x y z per splat. */
  readonly rotations: Float32Array;
  /** Linear scales, xyz per splat. */
  readonly scales: Float32Array;
  /** Base colour (degree 0 SH) and opacity, RGBA bytes per splat. */
  readonly colors: Uint8Array;
  /** Higher-order SH palette and labels, or null without SH. */
  readonly sh: SplatShData | null;
  /** The motion, {@link ASOG_MOTION_FLOATS} floats per splat. */
  readonly motion: Float32Array;
  /**
   * The clip table, {@link ASOG_CLIP_FLOATS} per clip: time offset, active
   * start, active end, 0, core start, core end, fade-in and fade-out
   * (seconds).
   */
  readonly clips: Float32Array;
  /** The soundtrack, or null when the file has none. */
  readonly audio: { readonly mime: string; readonly bytes: Uint8Array } | null;
}

/** The streams every v1 file has; `shlabels` and `shpalette` are optional. */
const REQUIRED_STREAMS = [
  'means',
  'quats',
  'quatmode',
  'scales',
  'sh0',
  'opacity',
  'mu',
  'logsigma',
  'anchor',
  'omega',
  'g',
  'flags',
] as const;

/** Every stream VLAM decodes. */
const STREAM_NAMES = [...REQUIRED_STREAMS, 'shlabels', 'shpalette'] as const;
type AsogStreamName = (typeof STREAM_NAMES)[number];

/**
 * The known stream a file's stream name stands for, or undefined. Returns
 * VLAM's own constant, never the file's string, so nothing the file names is
 * used as a property key (a name such as `constructor` or `toString` would
 * otherwise find a member of `Object.prototype`).
 */
function knownStream(name: string): AsogStreamName | undefined {
  return STREAM_NAMES.find((known) => known === name);
}

/** Streams whose decoding reads what another stream decoded. */
const STREAM_NEEDS: Readonly<Partial<Record<AsogStreamName, readonly AsogStreamName[]>>> = {
  quatmode: ['quats'],
  opacity: ['sh0'],
  anchor: ['means'],
  omega: ['anchor', 'logsigma'],
  g: ['omega', 'logsigma'],
};

/** Channels of each per-splat stream (the SH palette has `coeffs · 3`). */
const STREAM_CHANNELS: Readonly<Record<string, number>> = {
  means: 3,
  quats: 3,
  scales: 3,
  sh0: 3,
  anchor: 3,
  omega: 9,
  g: 5,
};

/**
 * Deflate's largest expansion: one compressed byte yields at most about 1032
 * bytes. A stream whose shape needs more than this times its compressed size
 * is not a real stream.
 */
const MAX_INFLATE_RATIO = 1032;

function fail(why: string): never {
  throw new Error(`ASOG: ${why}`);
}

/**
 * Inflates a zlib (RFC 1950) stream to exactly `size` bytes.
 *
 * @internal
 */
export async function inflateAsogStream(bytes: Uint8Array, size: number): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
    .getReader();
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.length > size) {
      await reader.cancel().catch(() => {});
      fail(`a stream inflates to more than its declared ${size} bytes.`);
    }
    out.set(value, offset);
    offset += value.length;
  }
  if (offset !== size) fail(`a stream inflates to ${offset} bytes, not its declared ${size}.`);
  return out;
}

/**
 * Decodes channel `channel` of an inflated stream into `out[0 .. count)`
 * (format section 3.1): byte planes, then zigzag, then the delta sum along
 * the rows. Exact for values below 2⁵³.
 *
 * @internal
 */
export function decodeAsogChannel(
  desc: AsogStreamDesc,
  raw: Uint8Array,
  channel: number,
  out: Float64Array,
): void {
  const { channels, count, planes, zigzag, delta } = desc;
  let previous = 0;
  for (let i = 0; i < count; i++) {
    let value = 0;
    for (let p = planes - 1; p >= 0; p--)
      value = value * 256 + raw[(p * channels + channel) * count + i]!;
    if (zigzag) value = value % 2 ? -(value + 1) / 2 : value / 2;
    if (delta) value = previous += value;
    out[i] = value;
  }
}

/** SOG v2 log-mapped position on one axis. */
function dequantPosition(q: number, min: number, max: number): number {
  const v = min + (q / 65535) * (max - min);
  return Math.sign(v) * Math.expm1(Math.abs(v));
}

/**
 * `m_ref · qp / 1000`: the G quantisation step from the stored control
 * points `O` (spec 4.2).
 */
function gStep(o: Float32Array, at: number, life: number, samples: number, qp: number): number {
  let smallest = Infinity;
  for (let s = 0; s < samples; s++) {
    const tau = s / (samples - 1);
    const u = 1 - tau;
    const b0 = u * u;
    const b1 = 2 * u * tau;
    const b2 = tau * tau;
    let squared = 0;
    for (let c = 0; c < 3; c++) {
      const x = b0 * o[at + c]! + b1 * o[at + 3 + c]! + b2 * o[at + 6 + c]!;
      squared += x * x;
    }
    if (squared < smallest) smallest = squared;
  }
  return (Math.max(Math.sqrt(smallest) * life, 1e-9) * qp) / 1000;
}

/**
 * The clip table (format section 5): per clip its time offset, active range,
 * core range and fade lengths, in seconds.
 *
 * @internal
 */
export function asogClipTable(manifest: AsogManifest): Float32Array {
  const fps = manifest.timeline.frameRate;
  const table = new Float32Array(manifest.clips.length * ASOG_CLIP_FLOATS);
  manifest.clips.forEach((clip, c) => {
    const g = clip.global;
    const r = clip.render;
    table.set(
      [
        (g.frameStart - clip.local.frameStart) / fps,
        g.activeTimeStart,
        g.activeTimeEnd,
        0,
        g.coreTimeStart,
        g.coreTimeEnd,
        (r?.fadeInFrames ?? 0) / fps,
        (r?.fadeOutFrames ?? 0) / fps,
      ],
      c * ASOG_CLIP_FLOATS,
    );
  });
  return table;
}

/**
 * Decodes a whole `.asog` file held in memory.
 *
 * @throws {Error} on a file that is not version-1 `.asog`, a missing or
 * misordered stream, or a stream that inflates to the wrong size.
 * @experimental
 */
export async function parseAsog(input: ArrayBuffer | Uint8Array): Promise<AsogData> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const header = parseAsogHeader(bytes.subarray(0, ASOG_HEADER_SIZE));
  const manifestEnd = header.manifestOffset + header.manifestLength;
  const payloadEnd = header.payloadOffset + header.payloadLength;
  if (manifestEnd > bytes.length || payloadEnd > bytes.length) {
    fail(
      `the file is truncated (${bytes.length} bytes, the header names ${Math.max(manifestEnd, payloadEnd)}).`,
    );
  }
  const manifest = parseAsogManifest(bytes.subarray(header.manifestOffset, manifestEnd));
  const n = manifest.count;
  const present = new Set(manifest.streams.map((s) => s.name));
  for (const name of REQUIRED_STREAMS) {
    if (!present.has(name)) fail(`the file has no "${name}" stream.`);
  }
  const shN = manifest.shN;
  const hasSh = !!shN && present.has('shlabels') && present.has('shpalette');
  const shBands = hasSh ? asogShBands(shN.coeffs) : 0;
  if (hasSh && shBands === 0) fail(`shN.coeffs ${shN.coeffs} is not 3, 8 or 15.`);
  if (hasSh && !(Number.isInteger(shN.count) && shN.count > 0)) {
    fail(`shN.count ${shN.count} is not a palette size.`);
  }

  // Every stream's shape, and a size its compressed bytes can hold, before
  // `count` sizes any allocation: a few bytes of manifest must not ask for
  // gigabytes.
  const shapeOf = (s: AsogStreamDesc): { rows: number; channels: number } | null => {
    if (s.name === 'shpalette') return hasSh ? { rows: shN.count, channels: shN.coeffs * 3 } : null;
    if (s.name === 'shlabels') return hasSh ? { rows: n, channels: 1 } : null;
    if (!(REQUIRED_STREAMS as readonly string[]).includes(s.name)) return null;
    return { rows: n, channels: STREAM_CHANNELS[s.name] ?? 1 };
  };
  for (const s of manifest.streams) {
    const shape = shapeOf(s);
    if (!shape) continue;
    if (s.count !== shape.rows || s.channels !== shape.channels) {
      fail(
        `stream "${s.name}" is ${s.count} × ${s.channels}, expected ${shape.rows} × ${shape.channels}.`,
      );
    }
    if (!(Number.isInteger(s.planes) && s.planes >= 1 && s.planes <= 6)) {
      fail(`stream "${s.name}" has ${s.planes} byte planes.`);
    }
    if (
      !(Number.isInteger(s.byteOffset) && s.byteOffset >= 0) ||
      !(Number.isInteger(s.byteLength) && s.byteLength >= 0)
    ) {
      fail(`stream "${s.name}" has no valid byte range.`);
    }
    const size = s.count * s.channels * s.planes;
    if (size > s.byteLength * MAX_INFLATE_RATIO + 64) {
      fail(`stream "${s.name}" needs ${size} bytes, more than its ${s.byteLength} can inflate to.`);
    }
  }

  const centers = new Float32Array(n * 3);
  const rotations = new Float32Array(n * 4);
  const scales = new Float32Array(n * 3);
  const colors = new Uint8Array(n * 4);
  const motion = new Float32Array(n * ASOG_MOTION_FLOATS);
  const labels = hasSh ? new Uint32Array(n) : null;
  const paletteWidth = hasSh ? 64 * shN.coeffs : 0;
  const paletteHeight = hasSh ? Math.max(1, Math.ceil(shN.count / 64)) : 0;
  const palette = hasSh ? new Float32Array(paletteWidth * paletteHeight * 4) : null;
  /** Smallest-three components (q / 255 − 0.5)·√2, until `quatmode` places them. */
  const smallest = new Float32Array(n * 3);
  /** Visible half-life L = sm · σ per splat. */
  const life = new Float64Array(n);
  /** The Ω step per splat, then the G step. */
  const step = new Float64Array(n);

  const { mins, maxs } = manifest.means;
  const mo = manifest.motion;
  const wO = [1, mo.midO, 1];
  const wG = [1, mo.midG, mo.midG, mo.midG, 1];
  const ls = manifest.logsigma;
  const sigmaSteps = 2 ** ls.bits - 1;
  const v = new Float64Array(Math.max(n, hasSh ? shN.count : 0));
  const scaleBook = manifest.scales.codebook;
  const sh0Book = manifest.sh0.codebook;

  const decoders: Record<AsogStreamName, (s: AsogStreamDesc, raw: Uint8Array) => void> = {
    means(s, raw) {
      for (let c = 0; c < 3; c++) {
        decodeAsogChannel(s, raw, c, v);
        for (let i = 0; i < n; i++) centers[i * 3 + c] = dequantPosition(v[i]!, mins[c]!, maxs[c]!);
      }
    },
    quats(s, raw) {
      for (let c = 0; c < 3; c++) {
        decodeAsogChannel(s, raw, c, v);
        for (let i = 0; i < n; i++) smallest[i * 3 + c] = (v[i]! / 255 - 0.5) * Math.SQRT2;
      }
    },
    quatmode(s, raw) {
      decodeAsogChannel(s, raw, 0, v);
      for (let i = 0; i < n; i++) {
        const a = smallest[i * 3]!;
        const b = smallest[i * 3 + 1]!;
        const c = smallest[i * 3 + 2]!;
        const d = Math.sqrt(Math.max(0, 1 - (a * a + b * b + c * c)));
        const mode = v[i]!;
        // wxyz with the largest component (index `mode`) left out of the three.
        const q =
          mode === 0
            ? [d, a, b, c]
            : mode === 1
              ? [a, d, b, c]
              : mode === 2
                ? [a, b, d, c]
                : [a, b, c, d];
        rotations.set(q, i * 4);
      }
    },
    scales(s, raw) {
      for (let c = 0; c < 3; c++) {
        decodeAsogChannel(s, raw, c, v);
        for (let i = 0; i < n; i++) scales[i * 3 + c] = Math.exp(scaleBook[v[i]!] ?? 0);
      }
    },
    sh0(s, raw) {
      for (let c = 0; c < 3; c++) {
        decodeAsogChannel(s, raw, c, v);
        for (let i = 0; i < n; i++) {
          const color = 0.5 + SH_C0 * (sh0Book[v[i]!] ?? 0);
          colors[i * 4 + c] = Math.round(Math.min(1, Math.max(0, color)) * 255);
        }
      }
    },
    opacity(s, raw) {
      decodeAsogChannel(s, raw, 0, v);
      for (let i = 0; i < n; i++) colors[i * 4 + 3] = v[i]!;
    },
    shlabels(s, raw) {
      decodeAsogChannel(s, raw, 0, v);
      for (let i = 0; i < n; i++) {
        if (v[i]! >= shN!.count)
          fail(`splat ${i} has SH label ${v[i]} beyond the palette of ${shN!.count}.`);
        labels![i] = v[i]!;
      }
    },
    shpalette(s, raw) {
      const { count, coeffs, codebook: book } = shN!;
      for (let channel = 0; channel < coeffs * 3; channel++) {
        decodeAsogChannel(s, raw, channel, v);
        const j = Math.floor(channel / 3);
        const c = channel % 3;
        for (let k = 0; k < count; k++) {
          palette![((k >> 6) * paletteWidth + (k & 63) * coeffs + j) * 4 + c] = book[v[k]!] ?? 0;
        }
      }
    },
    mu(s, raw) {
      decodeAsogChannel(s, raw, 0, v);
      for (let i = 0; i < n; i++)
        motion[i * ASOG_MOTION_FLOATS + ASOG_MOTION.mu] = v[i]! / manifest.mu.scale;
    },
    logsigma(s, raw) {
      decodeAsogChannel(s, raw, 0, v);
      for (let i = 0; i < n; i++) {
        const sigma = Math.exp(ls.min + (v[i]! / sigmaSteps) * (ls.max - ls.min));
        motion[i * ASOG_MOTION_FLOATS + ASOG_MOTION.sigma] = sigma;
        life[i] = mo.sm * Math.fround(sigma);
      }
    },
    anchor(s, raw) {
      step.fill(0); // |x − a|² first
      for (let c = 0; c < 3; c++) {
        decodeAsogChannel(s, raw, c, v);
        for (let i = 0; i < n; i++) {
          const a = (v[i]! * mo.qa) / 1000;
          const at = i * ASOG_MOTION_FLOATS + ASOG_MOTION.anchor + c;
          motion[at] = a;
          const d = centers[i * 3 + c]! - motion[at];
          step[i] = step[i]! + d * d;
        }
      }
      for (let i = 0; i < n; i++) step[i] = mo.qp / 1000 / Math.max(Math.sqrt(step[i]!), mo.r_min);
    },
    omega(s, raw) {
      for (let channel = 0; channel < 9; channel++) {
        decodeAsogChannel(s, raw, channel, v);
        const k = Math.floor(channel / 3);
        for (let i = 0; i < n; i++) {
          motion[i * ASOG_MOTION_FLOATS + ASOG_MOTION.omega + channel] =
            (v[i]! * step[i]! * wO[k]!) / life[i]!;
        }
      }
      // The G step, from the control points as stored (float32).
      for (let i = 0; i < n; i++) {
        step[i] = gStep(
          motion,
          i * ASOG_MOTION_FLOATS + ASOG_MOTION.omega,
          life[i]!,
          mo.mref_samples,
          mo.qp,
        );
      }
    },
    g(s, raw) {
      for (let j = 0; j < 5; j++) {
        decodeAsogChannel(s, raw, j, v);
        for (let i = 0; i < n; i++) {
          const l = life[i]!;
          motion[i * ASOG_MOTION_FLOATS + ASOG_MOTION.g + j] =
            (v[i]! * step[i]! * wG[j]!) / (l * l);
        }
      }
    },
    flags(s, raw) {
      decodeAsogChannel(s, raw, 0, v);
      for (let i = 0; i < n; i++) {
        if (v[i]! >> 1 >= manifest.clips.length)
          fail(`splat ${i} names clip ${v[i]! >> 1}, which the file lacks.`);
        motion[i * ASOG_MOTION_FLOATS + ASOG_MOTION.flags] = v[i]!;
      }
    },
  };

  const decoded = new Set<AsogStreamName>();
  for (const s of [...manifest.streams].sort((a, b) => a.byteOffset - b.byteOffset)) {
    // Unknown streams are skipped; shapes and byte ranges were checked above.
    const name = knownStream(s.name);
    if (name === undefined || (!hasSh && (name === 'shlabels' || name === 'shpalette'))) continue;
    for (const need of STREAM_NEEDS[name] ?? []) {
      if (!decoded.has(need)) fail(`stream "${name}" comes before "${need}", which it needs.`);
    }
    const start = header.payloadOffset + s.byteOffset;
    if (s.byteOffset < 0 || start + s.byteLength > payloadEnd) {
      fail(`stream "${s.name}" lies outside the payload.`);
    }
    const raw = await inflateAsogStream(
      bytes.subarray(start, start + s.byteLength),
      s.count * s.channels * s.planes,
    );
    decoders[name](s, raw);
    decoded.add(name);
  }

  let audio: AsogData['audio'] = null;
  if (manifest.audio) {
    const start = header.payloadOffset + manifest.audio.byteOffset;
    const end = start + manifest.audio.byteLength;
    if (end > payloadEnd) fail('the soundtrack lies outside the payload.');
    audio = { mime: manifest.audio.mime, bytes: bytes.slice(start, end) };
  }

  return {
    header,
    manifest,
    count: n,
    shBands,
    centers,
    rotations,
    scales,
    colors,
    sh:
      hasSh && shBands > 0
        ? { bands: shBands, labels: labels!, palette: palette!, paletteWidth, paletteHeight }
        : null,
    motion,
    clips: asogClipTable(manifest),
    audio,
  };
}
