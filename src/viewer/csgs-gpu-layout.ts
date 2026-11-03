/**
 * Data layout of `.csgs` GPU playback (`csgs-gpu.ts`): one section packed
 * for a modifier that evaluates the curves in the gather/vertex stage, so the
 * page uploads a section once instead of every frame.
 *
 * Kept free of TSL so the clip worker can build it. Per section:
 *  - **knots**: an RGBA16F texture (half floats, 8 B per texel). Each splat
 *    owns a contiguous block, groups in coding order (`P` xyz, `R` wxyz,
 *    `S` xyz, `O`, `D` xyz): one texel per knot, except the scalar opacity,
 *    whose knots pack four to a texel (knot `j` in component `j & 3` of
 *    texel `j >> 2`). Half precision is ~0.05 % of a value: about a
 *    millimetre on a 2 m capture, below what the curves were quantized to.
 *  - **headers**: per splat, the block's first texel, the five knot counts
 *    packed into one integer, and the birth and death frames packed into
 *    another, all exact in float32 (the per-splat channels are float32).
 *  - **base**: the pool's copy of the splats. Centers sit on the first
 *    position knot, the covariance is the identity (the modifier's linear
 *    output `M = R(t)·S(t)` then yields `M·Mᵀ`), the color is neutral
 *    (the modifier adds the DC term), and the SH is the section's. Two extra
 *    inactive splats at the corners of every position knot's box keep the
 *    pool bounds, which the depth sort quantizes against, covering every pose.
 */
import type { CsgsPlaybackSection } from '../lib/formats/csgs';
import type { SplatData } from '../lib/core';
import { floatToHalf, halfToFloat } from '../lib/core/half-float';

/** Floats per group knot, in coding order: P, R, S, O, D. */
export const CSGS_GROUP_DIMS = [3, 4, 3, 1, 3] as const;
/** Index of the opacity group, whose scalar knots pack four per texel. */
const OPACITY_GROUP = 3;
/** Pool texture rows (and the knot texture) are this many texels wide. */
export const CSGS_KNOT_TEXTURE_WIDTH = 2048;
/** Multiplier between packed knot counts (each count is 1 to 7). */
export const CSGS_K_RADIX = 8;
/** Multiplier between the packed birth and death frames. */
export const CSGS_LIFE_RADIX = 4096;
/** Pool byte color of the neutral base, which the modifier replaces. */
export const CSGS_NEUTRAL_BYTE = 128;
/** Bounds marker splats written after a section's slots. */
export const CSGS_BOUNDS_MARKERS = 2;
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
  /** RGBA half-float knot texels (bits), `texels * 4` used. */
  readonly knots: Uint16Array;
  /** Per splat: first knot texel. */
  readonly base: Float32Array;
  /** Per splat: `kP + 8·kR + 64·kS + 512·kO + 4096·kD`. */
  readonly k: Float32Array;
  /** Per splat: `birth + 4096·death` (absolute frames). */
  readonly life: Float32Array;
  /** `count + 2` pool splats: the section's slots, then the bounds markers. */
  readonly pool: SplatData;
}

/** Texels group `g` takes for `K` knots: one per knot, opacity four per texel. */
function groupTexels(g: number, K: number): number {
  return g === OPACITY_GROUP ? Math.ceil(K / 4) : K;
}

/** Largest finite half float: knots beyond it cannot be stored. */
export const CSGS_HALF_MAX = 65504;

/**
 * Whether every knot of a section fits a half float (the GPU path's
 * contract). Captures are metres across; Faltwerk's synthetic stress streams
 * are not, and stay on the float32 worker path.
 */
export function csgsGpuHalfSafe(section: CsgsPlaybackSection): boolean {
  for (const knots of section.knots) {
    for (const value of knots) if (!(Math.abs(value) <= CSGS_HALF_MAX)) return false;
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

/** Packs one section for GPU playback (see the module comment). */
export function packCsgsGpuSection(section: CsgsPlaybackSection): CsgsGpuSection {
  const { count } = section;
  const texels = csgsGpuTexels(section);
  const knots = new Uint16Array(texels * 4);
  const base = new Float32Array(count);
  const k = new Float32Array(count);
  const life = new Float32Array(count);
  const slots = count + CSGS_BOUNDS_MARKERS;
  const positions = new Float32Array(slots * 3);
  const colors = new Uint8Array(slots * 4);
  const covariances = new Float32Array(slots * 6);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
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
      for (let j = 0; j < K; j++) {
        for (let c = 0; c < dims; c++) {
          const value = source[offset + j * dims + c]!;
          const slot =
            g === OPACITY_GROUP ? (cursor + (j >> 2)) * 4 + (j & 3) : (cursor + j) * 4 + c;
          knots[slot] = floatToHalf(value);
          if (g === 0) {
            min[c] = Math.min(min[c]!, value);
            max[c] = Math.max(max[c]!, value);
          }
        }
      }
      if (g === 0) {
        for (let c = 0; c < 3; c++) positions[i * 3 + c] = source[offset + c]!;
      }
      cursor += groupTexels(g, K);
      packedK += K * radix;
      radix *= CSGS_K_RADIX;
    }
    k[i] = packedK;
    life[i] = section.birthFrame[i]! + CSGS_LIFE_RADIX * section.deathFrame[i]!;
  }
  for (let i = 0; i < slots; i++) {
    colors.fill(CSGS_NEUTRAL_BYTE, i * 4, i * 4 + 3);
    // The markers draw nothing (and are not active anyway).
    colors[i * 4 + 3] = i < count ? 255 : 0;
    // Upper triangle of the identity.
    covariances[i * 6] = i < count ? 1 : 0;
    covariances[i * 6 + 3] = i < count ? 1 : 0;
    covariances[i * 6 + 5] = i < count ? 1 : 0;
  }
  if (count > 0) {
    for (let c = 0; c < 3; c++) {
      positions[count * 3 + c] = min[c]!;
      positions[(count + 1) * 3 + c] = max[c]!;
    }
  }
  const words = section.shPacked.packed.length / Math.max(count, 1);
  const shPacked = new Uint32Array(slots * words);
  shPacked.set(section.shPacked.packed);
  return {
    g0: section.g0,
    nframes: section.nframes,
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
  };
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
 * from the packed (half-float) data alone. The reference the layout is
 * tested against.
 */
export function sampleCsgsGpuSection(packed: CsgsGpuSection, i: number, t: number): CsgsGpuSample {
  const span = Math.max(packed.nframes - 1, 1);
  const life = packed.life[i]!;
  const birth = life % CSGS_LIFE_RADIX;
  const death = Math.floor(life / CSGS_LIFE_RADIX);
  const frame = Math.floor(t);
  const groups: number[][] = [];
  let packedK = packed.k[i]!;
  let cursor = packed.base[i]!;
  for (let g = 0; g < 5; g++) {
    const K = packedK % CSGS_K_RADIX;
    packedK = Math.floor(packedK / CSGS_K_RADIX);
    const km1 = K - 1;
    const tau = km1 > 0 ? Math.min(Math.max(((t - packed.g0) * km1) / span, 0), km1) : 0;
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
  const length = Math.hypot(r[0]!, r[1]!, r[2]!, r[3]!) || 1;
  return {
    alive: frame >= birth && frame < death,
    position: [p[0]!, p[1]!, p[2]!],
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
