/**
 * Evaluates a decoded `.csgs` section at a frame time into {@link SplatData}.
 *
 * The section's integer knots are dequantized once ({@link prepareCsgsSection});
 * each frame then evaluates every alive splat's hat curves at a fractional
 * frame time ({@link evaluateCsgsFrame}) - the CPU mirror of Faltwerk's GPU
 * curve evaluation, with gsplat's attribute conventions: `R` is a `wxyz`
 * quaternion (normalized after interpolation), `S` a log-scale, `O` an opacity
 * logit and `D` the DC SH color.
 */
import {
  SH_C0,
  writeCovariance,
  type SplatData,
  type SplatPackedShData,
} from '../../core/splat-data';
import { packShCoefficient, symmetricShRange } from '../../core/sh-pack';
import type { CsgsParams, CsgsSection } from './parse-csgs';

/** Group order the renderer needs; Faltwerk's encoder emits exactly this layout. */
const GROUP_TAGS = ['P', 'R', 'S', 'O', 'D'] as const;
const GROUP_DIMS = [3, 4, 3, 1, 3] as const;
/** 15 coefficients × RGB of degree-3 SH beyond the DC term. */
const SN_SCALARS = 45;
const SH_COEFFICIENTS = 15;
/**
 * Bound on a log-scale before `exp`. A corrupt or synthetic knot far outside
 * any real capture would otherwise overflow to Infinity and poison the
 * covariance; `exp(20)` is already a splat larger than any scene.
 */
const MAX_LOG_SCALE = 20;

/** A section with dequantized knots, ready for per-frame evaluation. */
export interface CsgsPlaybackSection {
  readonly g0: number;
  readonly nframes: number;
  /** Splats carried by the section (alive at some frame of it). */
  readonly count: number;
  /** First absolute frame at which each splat is drawn. */
  readonly birthFrame: Uint32Array;
  /** First absolute frame at which each splat is no longer drawn. */
  readonly deathFrame: Uint32Array;
  /** Knot count per splat, per group in {@link GROUP_TAGS} order. */
  readonly k: readonly Uint8Array[];
  /** Start of each splat's knots in the group's float array. */
  readonly knotOff: readonly Uint32Array[];
  /** Dequantized knots per group, knot-major per splat. */
  readonly knots: readonly Float32Array[];
  /** Static higher-order SH, packed per splat for a vlam pool. */
  readonly shPacked: SplatPackedShData;
}

/** Reusable output buffers of {@link evaluateCsgsFrame}, grown on demand. */
export interface CsgsFrameBuffers {
  positions: Float32Array;
  colors: Uint8Array;
  covariances: Float32Array;
  shPacked: Uint32Array;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Largest absolute SH coefficient a section's quantization table can produce. */
export function csgsShExtent(params: CsgsParams): number {
  const base = params.offsets.length - params.nSn;
  let extent = 0;
  for (let c = 0; c < params.nSn; c++) {
    const offset = params.offsets[base + c] as number;
    const scale = params.scales[base + c] as number;
    extent = Math.max(extent, Math.abs(offset), Math.abs(offset + 255 * scale));
  }
  return extent;
}

/**
 * Dequantizes a section for playback.
 *
 * @param shExtent Symmetric packed-SH range to quantize against. Pass one value
 * for every section of a stream so the pool never has to requantize; defaults
 * to this section's own extent.
 * @throws {Error} if the stream's group layout is not the renderer's `P3 R4 S3 O1 D3` + 45 SH.
 */
export function prepareCsgsSection(
  section: CsgsSection,
  params: CsgsParams,
  shExtent = csgsShExtent(params),
): CsgsPlaybackSection {
  const layoutOk =
    params.groups.length === GROUP_TAGS.length &&
    params.groups.every(([tag, dims], g) => tag === GROUP_TAGS[g] && dims === GROUP_DIMS[g]);
  if (!layoutOk || params.nSn !== SN_SCALARS) {
    throw new Error('CSGS: playback expects groups P3 R4 S3 O1 D3 and 45 SH scalars.');
  }
  const { n, nCont } = section;
  const birthFrame = new Uint32Array(n);
  const deathFrame = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    birthFrame[i] = i < nCont ? 0 : section.g0 + (section.birth[i - nCont] as number);
    deathFrame[i] = section.g0 + (section.death[i] as number);
  }
  const knots: Float32Array[] = [];
  let scalar = 0;
  for (let g = 0; g < GROUP_TAGS.length; g++) {
    const dims = GROUP_DIMS[g] as number;
    const source = section.knots[g] as Int32Array;
    const out = new Float32Array(source.length);
    for (let i = 0; i < source.length; i++) {
      const c = scalar + (i % dims);
      out[i] = (params.offsets[c] as number) + (source[i] as number) * (params.scales[c] as number);
    }
    knots.push(out);
    scalar += dims;
  }
  const snBase = params.offsets.length - SN_SCALARS;
  const packed = new Uint32Array(n * SH_COEFFICIENTS);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < SH_COEFFICIENTS; c++) {
      const s = i * SN_SCALARS + c * 3;
      const value = (channel: number) =>
        (params.offsets[snBase + c * 3 + channel] as number) +
        (section.sn[s + channel] as number) * (params.scales[snBase + c * 3 + channel] as number);
      packed[i * SH_COEFFICIENTS + c] = packShCoefficient(value(0), value(1), value(2), shExtent);
    }
  }
  return {
    g0: section.g0,
    nframes: section.nframes,
    count: n,
    birthFrame,
    deathFrame,
    k: section.k,
    knotOff: section.knotOff,
    knots,
    shPacked: { bands: 3, packed, range: symmetricShRange(shExtent) },
  };
}

/** Allocates frame buffers for `count` splats. */
export function createCsgsFrameBuffers(count: number): CsgsFrameBuffers {
  return {
    positions: new Float32Array(count * 3),
    colors: new Uint8Array(count * 4),
    covariances: new Float32Array(count * 6),
    shPacked: new Uint32Array(count * SH_COEFFICIENTS),
  };
}

/**
 * Hat-curve position of a splat's `K`-knot curve at frame `t`: the segment
 * index and the weight of its second knot. Mirrors Faltwerk's `seg()`.
 */
function curveSegment(t: number, g0: number, span: number, K: number): [number, number] {
  if (K <= 1) return [0, 0];
  const km1 = K - 1;
  const tau = Math.min(Math.max(((t - g0) * km1) / span, 0), km1);
  const j = Math.min(Math.floor(tau), km1 - 1);
  return [j, tau - j];
}

/** Linear interpolation of one `K`-knot, `dims`-wide curve at frame `t`, into `out`. */
function sampleHatCurve(
  knots: Float32Array,
  offset: number,
  K: number,
  dims: number,
  t: number,
  g0: number,
  span: number,
  out: Float32Array,
): void {
  const [j, w] = curveSegment(t, g0, span, K);
  const a = offset + j * dims;
  for (let c = 0; c < dims; c++) {
    const from = knots[a + c] as number;
    out[c] = K <= 1 ? from : from + ((knots[a + dims + c] as number) - from) * w;
  }
}

/**
 * Samples one splat's curve of group `group` (0 = P … 4 = D) at absolute frame
 * time `t`, writing its `dims` values to `out`. The rotation curve is returned
 * as interpolated, not yet normalized.
 */
export function sampleCsgsCurve(
  section: CsgsPlaybackSection,
  group: number,
  splat: number,
  t: number,
  out: Float32Array,
): void {
  const dims = GROUP_DIMS[group];
  if (dims === undefined) throw new RangeError(`CSGS: no curve group ${group}.`);
  sampleHatCurve(
    section.knots[group] as Float32Array,
    (section.knotOff[group] as Uint32Array)[splat] as number,
    (section.k[group] as Uint8Array)[splat] as number,
    dims,
    t,
    section.g0,
    Math.max(section.nframes - 1, 1),
    out,
  );
}

/** Options of {@link evaluateCsgsFrame}. */
export interface CsgsFrameOptions {
  /**
   * Write every splat of the section at its own index (`count` is then the
   * section's), the dead ones with zero opacity and zero covariance, instead
   * of only the alive splats packed together. Fixed slots let a host update
   * a frame in place and keep the static SH of the section where it is.
   */
  readonly allSlots?: boolean;
}

/**
 * Evaluates the section at absolute frame time `t` (fractional frames
 * interpolate; liveness uses the whole frame). By default only the splats
 * alive at `t` are written, so the returned `count` varies per frame (see
 * {@link CsgsFrameOptions.allSlots}). Views into `buffers` are returned, so
 * consume the result before the next call reuses them.
 */
export function evaluateCsgsFrame(
  section: CsgsPlaybackSection,
  t: number,
  buffers: CsgsFrameBuffers = createCsgsFrameBuffers(section.count),
  options: CsgsFrameOptions = {},
): SplatData {
  const allSlots = options.allSlots === true;
  const frame = Math.floor(t);
  const span = Math.max(section.nframes - 1, 1);
  const [kP, kR, kS, kO, kD] = section.k as [
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
  ];
  const [oP, oR, oS, oO, oD] = section.knotOff as [
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
  ];
  const [vP, vR, vS, vO, vD] = section.knots as [
    Float32Array,
    Float32Array,
    Float32Array,
    Float32Array,
    Float32Array,
  ];
  const { positions, colors, covariances, shPacked } = buffers;
  const value = new Float32Array(4);
  const evaluate = (knots: Float32Array, offset: number, K: number, dims: number): void =>
    sampleHatCurve(knots, offset, K, dims, t, section.g0, span, value);
  let count = 0;
  for (let i = 0; i < section.count; i++) {
    if (frame < (section.birthFrame[i] as number) || frame >= (section.deathFrame[i] as number)) {
      if (!allSlots) continue;
      // A dead slot draws nothing; its position stays on the curve so it
      // does not stretch the bounds the depth sort quantizes against.
      evaluate(vP, oP[i] as number, kP[i] as number, 3);
      positions[count * 3] = value[0] as number;
      positions[count * 3 + 1] = value[1] as number;
      positions[count * 3 + 2] = value[2] as number;
      covariances.fill(0, count * 6, count * 6 + 6);
      colors.fill(0, count * 4, count * 4 + 4);
      count++;
      continue;
    }
    evaluate(vP, oP[i] as number, kP[i] as number, 3);
    positions[count * 3] = value[0] as number;
    positions[count * 3 + 1] = value[1] as number;
    positions[count * 3 + 2] = value[2] as number;
    evaluate(vR, oR[i] as number, kR[i] as number, 4);
    const qw = value[0] as number;
    const qx = value[1] as number;
    const qy = value[2] as number;
    const qz = value[3] as number;
    evaluate(vS, oS[i] as number, kS[i] as number, 3);
    writeCovariance(
      covariances,
      count,
      Math.exp(Math.min(value[0] as number, MAX_LOG_SCALE)),
      Math.exp(Math.min(value[1] as number, MAX_LOG_SCALE)),
      Math.exp(Math.min(value[2] as number, MAX_LOG_SCALE)),
      qw,
      qx,
      qy,
      qz,
    );
    evaluate(vD, oD[i] as number, kD[i] as number, 3);
    for (let c = 0; c < 3; c++) {
      colors[count * 4 + c] = Math.max(
        0,
        Math.min(255, Math.round((0.5 + SH_C0 * (value[c] as number)) * 255)),
      );
    }
    evaluate(vO, oO[i] as number, kO[i] as number, 1);
    colors[count * 4 + 3] = Math.round(sigmoid(value[0] as number) * 255);
    // Every slot written: the section's packed words are returned whole below.
    if (!allSlots)
      shPacked.set(
        section.shPacked.packed.subarray(i * SH_COEFFICIENTS, (i + 1) * SH_COEFFICIENTS),
        count * SH_COEFFICIENTS,
      );
    count++;
  }
  // A frame where every splat is alive keeps the section's packed words verbatim.
  const packedWords =
    count === section.count
      ? section.shPacked.packed
      : shPacked.subarray(0, count * SH_COEFFICIENTS);
  return {
    count,
    positions: positions.subarray(0, count * 3),
    colors: colors.subarray(0, count * 4),
    covariances: covariances.subarray(0, count * 6),
    shPacked: { bands: 3, packed: packedWords, range: section.shPacked.range },
  };
}
