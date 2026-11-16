/**
 * Data layout of `.csgs` GPU playback (`dynamic/csgs-curve-modifier.ts`): one
 * section packed for a modifier that evaluates the curves in the
 * gather/vertex stage, so the page uploads a section once instead of every
 * frame.
 *
 * Kept free of TSL and three.js so the clip worker can build it, and not
 * exported from `formats/csgs/index.ts`: the layout is an implementation
 * detail of `@voluma/vlam/dynamic`. Per section:
 *  - **knots**: an RGBA16F texture (half floats, 8 B per texel). Each splat
 *    owns a contiguous block, groups in coding order (`P` xyz, `R` wxyz,
 *    `S` xyz, `O`, `D` xyz): one texel per knot, except the scalar opacity,
 *    whose knots pack four to a texel (knot `j` in component `j & 3` of
 *    texel `j >> 2`). Half precision is ~0.05 % of a value. Position knots
 *    are stored **relative to the splat's first position knot** (which the
 *    pool center holds in float32), so their precision follows how far a
 *    splat moves within a section, not how far it stands from the clip's
 *    origin: absolute half floats step by ~8 mm at 8 to 16 m.
 *  - **headers**: per splat, the block's first texel, the five knot counts
 *    packed into one integer, and the birth and death frames packed into
 *    another, all exact in float32 (the per-splat channels are float32).
 *    Birth and death are **section-relative** (`frame − g0`, clamped to
 *    `[0, nframes]`), so the 4096 radix limits a section, not the clip, to
 *    4095 frames.
 *  - **base**: the pool's copy of the splats. Centers sit on the first
 *    position knot, the covariance is the identity (the modifier's linear
 *    output `M = R(t)·S(t)` then yields `M·Mᵀ`), the color is neutral
 *    (the modifier adds the DC term), and the SH is the section's.
 *  - **bounds**: the box of every absolute position knot. The hat curves
 *    interpolate between knots, so every pose stays inside it; the player
 *    declares it as the mesh's `displacementBounds`, which the depth sort
 *    quantizes against.
 */
import type { CsgsPlaybackSection } from './csgs-frame';
import type { SplatData } from '../../core/splat-data';
import { floatToHalf, halfToFloat } from '../../core/half-float';

/** Floats per group knot, in coding order: P, R, S, O, D. */
export const CSGS_GROUP_DIMS = [3, 4, 3, 1, 3] as const;
/** Index of the opacity group, whose scalar knots pack four per texel. */
const OPACITY_GROUP = 3;
/** Pool texture rows (and the knot texture) are this many texels wide. */
export const CSGS_KNOT_TEXTURE_WIDTH = 2048;
/** Multiplier between packed knot counts (each count is 1 to {@link CSGS_GPU_MAX_KNOTS}). */
export const CSGS_K_RADIX = 8;
/** Most knots per curve the packed counts hold; a section with more stays on the frame path. */
export const CSGS_GPU_MAX_KNOTS = CSGS_K_RADIX - 1;
/** Multiplier between the packed (section-relative) birth and death frames. */
export const CSGS_LIFE_RADIX = 4096;
/** Pool byte color of the neutral base, which the modifier replaces. */
export const CSGS_NEUTRAL_BYTE = 128;
/** Upper bound on a log-scale before `exp`, as the CPU evaluator clamps it. */
export const CSGS_MAX_LOG_SCALE = 20;

/** One section packed for GPU playback. */
export interface CsgsGpuSection {
  readonly g0: number;
  readonly nframes: number;
  /** Splats of the section (the active slots). */
  readonly count: number;
  /** Texels of `knots` in use. */
  readonly texels: number;
  /** RGBA half-float knot texels (bits), `texels * 4` used. Positions are deltas. */
  readonly knots: Uint16Array;
  /** Per splat: first knot texel. */
  readonly base: Float32Array;
  /** Per splat: `kP + 8·kR + 64·kS + 512·kO + 4096·kD`. */
  readonly k: Float32Array;
  /** Per splat: `(birth − g0) + 4096·(death − g0)`, each clamped to `[0, nframes]`. */
  readonly life: Float32Array;
  /** The section's `count` pool splats, one per slot. */
  readonly pool: SplatData;
  /** Box of every absolute position knot (see {@link csgsSectionBounds}). */
  readonly bounds: CsgsBounds;
}

/** An axis-aligned box as plain tuples, so it crosses a worker boundary. */
export interface CsgsBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * Box of every absolute position knot of a section. The hat curves
 * interpolate linearly between knots, so every pose of every splat stays
 * inside it. An empty section gives an empty box (`min` above `max`).
 */
export function csgsSectionBounds(section: CsgsPlaybackSection): CsgsBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const positions = section.knots[0]!;
  for (let i = 0; i < section.count; i++) {
    const offset = section.knotOff[0]![i]!;
    const K = section.k[0]![i]!;
    for (let j = 0; j < K; j++) {
      for (let c = 0; c < 3; c++) {
        const value = positions[offset + j * 3 + c]!;
        if (value < min[c]!) min[c] = value;
        if (value > max[c]!) max[c] = value;
      }
    }
  }
  return { min, max };
}

/** Texels group `g` takes for `K` knots: one per knot, opacity four per texel. */
function groupTexels(g: number, K: number): number {
  return g === OPACITY_GROUP ? Math.ceil(K / 4) : K;
}

/** Largest finite half float: knots beyond it cannot be stored. */
export const CSGS_HALF_MAX = 65504;

/**
 * Whether every stored knot of a section fits a half float (the GPU path's
 * contract), positions taken as deltas from each splat's first knot, as
 * they are packed. Captures are metres across; Faltwerk's synthetic stress
 * streams are not, and stay on the float32 worker path. Sections longer than
 * 4095 frames do not fit the packed life either, nor curves of more than
 * {@link CSGS_GPU_MAX_KNOTS} knots the packed counts (the container allows any).
 */
export function csgsGpuHalfSafe(section: CsgsPlaybackSection): boolean {
  if (section.nframes >= CSGS_LIFE_RADIX) return false;
  for (const counts of section.k) {
    for (let i = 0; i < section.count; i++) {
      if (!(counts[i]! >= 1 && counts[i]! <= CSGS_GPU_MAX_KNOTS)) return false;
    }
  }
  for (let g = 1; g < 5; g++) {
    for (const value of section.knots[g]!) if (!(Math.abs(value) <= CSGS_HALF_MAX)) return false;
  }
  const positions = section.knots[0]!;
  for (let i = 0; i < section.count; i++) {
    const offset = section.knotOff[0]![i]!;
    const K = section.k[0]![i]!;
    for (let j = 0; j < K; j++) {
      for (let c = 0; c < 3; c++) {
        const delta = positions[offset + j * 3 + c]! - positions[offset + c]!;
        if (!(Math.abs(delta) <= CSGS_HALF_MAX)) return false;
      }
    }
  }
  return true;
}

/** Texels a section needs (see the module comment). */
export function csgsGpuTexels(section: CsgsPlaybackSection): number {
  let texels = 0;
  for (let g = 0; g < 5; g++) {
    const k = section.k[g]!;
    for (let i = 0; i < section.count; i++) texels += groupTexels(g, k[i]!);
  }
  return texels;
}

/** Section-relative frame, clamped to `[0, nframes]` (see the module comment). */
function relativeFrame(frame: number, g0: number, nframes: number): number {
  return Math.min(Math.max(frame - g0, 0), nframes);
}

/** Packs one section for GPU playback (see the module comment). */
export function packCsgsGpuSection(section: CsgsPlaybackSection): CsgsGpuSection {
  const { count, g0, nframes } = section;
  const texels = csgsGpuTexels(section);
  const knots = new Uint16Array(texels * 4);
  const base = new Float32Array(count);
  const k = new Float32Array(count);
  const life = new Float32Array(count);
  const slots = count;
  const positions = new Float32Array(slots * 3);
  const colors = new Uint8Array(slots * 4);
  const covariances = new Float32Array(slots * 6);
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    base[i] = cursor;
    let packedK = 0;
    let radix = 1;
    for (let g = 0; g < 5; g++) {
      const dims = CSGS_GROUP_DIMS[g]!;
      const K = section.k[g]![i]!;
      const source = section.knots[g]!;
      const offset = section.knotOff[g]![i]!;
      if (g === 0) {
        // The pool center holds the first knot in float32; the texture the rest relative to it.
        for (let c = 0; c < 3; c++) positions[i * 3 + c] = source[offset + c]!;
      }
      for (let j = 0; j < K; j++) {
        for (let c = 0; c < dims; c++) {
          const value = source[offset + j * dims + c]!;
          const slot =
            g === OPACITY_GROUP ? (cursor + (j >> 2)) * 4 + (j & 3) : (cursor + j) * 4 + c;
          if (g === 0) {
            knots[slot] = floatToHalf(value - positions[i * 3 + c]!);
          } else {
            knots[slot] = floatToHalf(value);
          }
        }
      }
      cursor += groupTexels(g, K);
      packedK += K * radix;
      radix *= CSGS_K_RADIX;
    }
    k[i] = packedK;
    life[i] =
      relativeFrame(section.birthFrame[i]!, g0, nframes) +
      CSGS_LIFE_RADIX * relativeFrame(section.deathFrame[i]!, g0, nframes);
  }
  for (let i = 0; i < slots; i++) {
    colors.fill(CSGS_NEUTRAL_BYTE, i * 4, i * 4 + 3);
    colors[i * 4 + 3] = 255;
    // Upper triangle of the identity.
    covariances[i * 6] = 1;
    covariances[i * 6 + 3] = 1;
    covariances[i * 6 + 5] = 1;
  }
  // A copy: the section keeps its own SH for the frame path.
  const shPacked = section.shPacked.packed.slice();
  return {
    g0,
    nframes,
    count,
    texels,
    knots,
    base,
    k,
    life,
    pool: {
      count: slots,
      positions,
      colors,
      covariances,
      shPacked: { bands: 3, packed: shPacked, range: section.shPacked.range },
    },
    bounds: csgsSectionBounds(section),
  };
}

/** Whether splat `i` of a packed section is alive at section-local integer frame `local`. */
export function csgsGpuAlive(life: Float32Array, i: number, local: number): boolean {
  const packed = life[i]!;
  return local >= packed % CSGS_LIFE_RADIX && local < Math.floor(packed / CSGS_LIFE_RADIX);
}

/** The values the GPU modifier derives for one splat at frame time `t`. */
export interface CsgsGpuSample {
  readonly alive: boolean;
  readonly position: readonly [number, number, number];
  /** Normalized quaternion, wxyz. */
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
  readonly opacity: number;
  /** DC color, `0.5 + C0·D`, unclamped. */
  readonly color: readonly [number, number, number];
}

const SH_C0 = 0.28209479177387814;

/**
 * Evaluates splat `i` of a packed section exactly as the GPU modifier does,
 * from the packed (half-float) data alone, at absolute frame time `t`. The
 * reference the layout is tested against.
 */
export function sampleCsgsGpuSection(packed: CsgsGpuSection, i: number, t: number): CsgsGpuSample {
  const span = Math.max(packed.nframes - 1, 1);
  // The host computes the section-local time in double precision.
  const local = t - packed.g0;
  const groups: number[][] = [];
  let packedK = packed.k[i]!;
  let cursor = packed.base[i]!;
  for (let g = 0; g < 5; g++) {
    const K = packedK % CSGS_K_RADIX;
    packedK = Math.floor(packedK / CSGS_K_RADIX);
    const km1 = K - 1;
    const tau = km1 > 0 ? Math.min(Math.max((local * km1) / span, 0), km1) : 0;
    const j = km1 > 0 ? Math.min(Math.floor(tau), km1 - 1) : 0;
    const w = km1 > 0 ? tau - j : 0;
    const knot = (index: number, c: number): number =>
      halfToFloat(
        packed.knots[
          g === OPACITY_GROUP ? (cursor + (index >> 2)) * 4 + (index & 3) : (cursor + index) * 4 + c
        ]!,
      );
    const value: number[] = [];
    for (let c = 0; c < 4; c++) {
      const from = knot(j, c);
      value.push(from + (knot(Math.min(j + 1, km1), c) - from) * w);
    }
    groups.push(value);
    cursor += groupTexels(g, K);
  }
  const [p, r, s, o, d] = groups as [number[], number[], number[], number[], number[]];
  const center = packed.pool.positions;
  const length = Math.hypot(r[0]!, r[1]!, r[2]!, r[3]!) || 1;
  return {
    alive: csgsGpuAlive(packed.life, i, Math.floor(local)),
    position: [0, 1, 2].map((c) => center[i * 3 + c]! + p[c]!) as [number, number, number],
    rotation: [r[0]! / length, r[1]! / length, r[2]! / length, r[3]! / length],
    scale: [0, 1, 2].map((c) => Math.exp(Math.min(s[c]!, CSGS_MAX_LOG_SCALE))) as [
      number,
      number,
      number,
    ],
    opacity: 1 / (1 + Math.exp(-o[0]!)),
    color: [0, 1, 2].map((c) => 0.5 + SH_C0 * d[c]!) as [number, number, number],
  };
}
