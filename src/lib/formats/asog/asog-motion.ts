/**
 * The TRiGS motion of `.asog` splats on the CPU (format sections 4.1 and 5):
 * the frame path's evaluator and the reference the GPU modifier
 * (`dynamic/asog-motion-modifier.ts`) is checked against.
 *
 * Ported from the MIT-licensed reference of
 * [animated-sog](https://github.com/arrival-space/animated-sog)
 * (`js/src/core/motion.js`, Copyright (c) 2026 Arrival.Space).
 */
import { writeCovariance } from '../../core/splat-data';
import { ASOG_CLIP_FLOATS, ASOG_MOTION, ASOG_MOTION_FLOATS, type AsogData } from './parse-asog';

/** The temporal opacity cut: `weight = max((γ − 0.05) / (1 − 0.05), 0)`. */
export const ASOG_TEMPORAL_THRESHOLD = 0.05;
/** Half-width of a splat's visible life in σ: where γ reaches the 0.05 cut. */
export const ASOG_LIFE_SIGMAS = Math.sqrt(-2 * Math.log(ASOG_TEMPORAL_THRESHOLD));

/** Temporal weight of a dynamic splat `dt` seconds from its centre time. */
export function asogTemporalWeight(dt: number, sigma: number): number {
  const x = dt / sigma;
  return Math.max(
    (Math.exp(-0.5 * x * x) - ASOG_TEMPORAL_THRESHOLD) / (1 - ASOG_TEMPORAL_THRESHOLD),
    0,
  );
}

/**
 * Weight of clip `c` at global time `t`: 0 outside its active range,
 * smoothstep fades outside its core range, else 1.
 */
export function asogClipWeight(clips: ArrayLike<number>, c: number, t: number): number {
  const o = c * ASOG_CLIP_FLOATS;
  if (t < clips[o + 1]! || t >= clips[o + 2]!) return 0;
  const coreStart = clips[o + 4]!;
  const coreEnd = clips[o + 5]!;
  const fadeIn = clips[o + 6]!;
  const fadeOut = clips[o + 7]!;
  let x: number;
  if (fadeIn > 0 && t < coreStart) x = (t - (coreStart - fadeIn)) / fadeIn;
  else if (fadeOut > 0 && t >= coreEnd) x = (coreEnd + fadeOut - t) / fadeOut;
  else return 1;
  x = Math.min(1, Math.max(0, x));
  return x * x * (3 - 2 * x);
}

/** Clip-local time of clip `c` at global time `t`. */
export function asogClipLocalTime(clips: ArrayLike<number>, c: number, t: number): number {
  return t - clips[c * ASOG_CLIP_FLOATS]!;
}

/**
 * Evaluates splat `i` at clip-local time `t`. Writes its centre to
 * `out[0..2]` and the motion's rotation `q(w)` to `out[3..6]` as x y z w,
 * which pre-multiplies the splat's own rotation. A static splat, or one
 * invisible at `t`, keeps its canonical centre and an identity rotation.
 *
 * @returns the temporal weight (1 for a static splat, 0 when invisible).
 */
export function evaluateAsogSplat(
  motion: Float32Array,
  centers: Float32Array,
  i: number,
  t: number,
  out: Float64Array | Float32Array | number[],
): number {
  const m = i * ASOG_MOTION_FLOATS;
  const x = centers[i * 3]!;
  const y = centers[i * 3 + 1]!;
  const z = centers[i * 3 + 2]!;
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = 0;
  out[4] = 0;
  out[5] = 0;
  out[6] = 1;
  if (motion[m + ASOG_MOTION.flags]! % 2 === 1) return 1;
  const mu = motion[m + ASOG_MOTION.mu]!;
  const sigma = motion[m + ASOG_MOTION.sigma]!;
  const dt = t - mu;
  const weight = asogTemporalWeight(dt, sigma);
  if (weight <= 0) return 0;

  const tau = Math.min(1, Math.max(0, (t - (mu - 2 * sigma)) / (4 * sigma)));
  const u = 1 - tau;
  const b0 = u * u;
  const b1 = 2 * u * tau;
  const b2 = tau * tau;
  const o = m + ASOG_MOTION.omega;
  const ox = b0 * motion[o]! + b1 * motion[o + 3]! + b2 * motion[o + 6]!;
  const oy = b0 * motion[o + 1]! + b1 * motion[o + 4]! + b2 * motion[o + 7]!;
  const oz = b0 * motion[o + 2]! + b1 * motion[o + 5]! + b2 * motion[o + 8]!;
  const G = m + ASOG_MOTION.g;
  const g =
    b0 * b0 * motion[G]! +
    2 * b0 * b1 * motion[G + 1]! +
    (b1 * b1 + 2 * b0 * b2) * motion[G + 2]! +
    2 * b1 * b2 * motion[G + 3]! +
    b2 * b2 * motion[G + 4]!;
  const A = m + ASOG_MOTION.anchor;
  let ax = motion[A]!;
  let ay = motion[A + 1]!;
  let az = motion[A + 2]!;
  const oo = ox * ox + oy * oy + oz * oz;
  if (oo >= 1e-8) {
    const ad = (ax * ox + ay * oy + az * oz) / oo;
    ax -= ad * ox;
    ay -= ad * oy;
    az -= ad * oz;
  }
  const gs = g / Math.max(oo, 1e-24);
  const wx = ox * dt;
  const wy = oy * dt;
  const wz = oz * dt;
  const vx = gs * ox * dt;
  const vy = gs * oy * dt;
  const vz = gs * oz * dt;
  const th = Math.sqrt(wx * wx + wy * wy + wz * wz);
  const sh = Math.sin(0.5 * th);
  const ch = Math.cos(0.5 * th);
  const small = th < 1e-6;
  const cA = small ? 1 : (2 * sh * ch) / th;
  const cB = small ? 0.5 : (2 * sh * sh) / (th * th);
  const cC = small ? 1 / 6 : (th - 2 * sh * ch) / (th * th * th);

  const rx = x - ax;
  const ry = y - ay;
  const rz = z - az;
  const wrx = wy * rz - wz * ry;
  const wry = wz * rx - wx * rz;
  const wrz = wx * ry - wy * rx;
  const wwrx = wy * wrz - wz * wry;
  const wwry = wz * wrx - wx * wrz;
  const wwrz = wx * wry - wy * wrx;
  const wvx = wy * vz - wz * vy;
  const wvy = wz * vx - wx * vz;
  const wvz = wx * vy - wy * vx;
  const wwvx = wy * wvz - wz * wvy;
  const wwvy = wz * wvx - wx * wvz;
  const wwvz = wx * wvy - wy * wvx;
  out[0] = rx + cA * wrx + cB * wwrx + ax + vx + cB * wvx + cC * wwvx;
  out[1] = ry + cA * wry + cB * wwry + ay + vy + cB * wvy + cC * wwvy;
  out[2] = rz + cA * wrz + cB * wwrz + az + vz + cB * wvz + cC * wwvz;
  const s = small ? 0.5 : sh / th; // sin(θ/2) / θ
  out[3] = wx * s;
  out[4] = wy * s;
  out[5] = wz * s;
  out[6] = ch;
  return weight;
}

/**
 * Output buffers of {@link evaluateAsogFrame}, sized for every splat.
 *
 * @experimental
 */
export interface AsogFrameBuffers {
  positions: Float32Array;
  colors: Uint8Array;
  covariances: Float32Array;
}

/** Fresh {@link AsogFrameBuffers} for `count` splats. */
export function createAsogFrameBuffers(count: number): AsogFrameBuffers {
  return {
    positions: new Float32Array(count * 3),
    colors: new Uint8Array(count * 4),
    covariances: new Float32Array(count * 6),
  };
}

/**
 * Evaluates every splat at global time `t` into `buffers`, splat `i` in
 * slot `i`; an invisible splat gets opacity 0. With `compact`, only visible
 * splats are written, packed from slot 0, and `sources` (when given)
 * receives the splat index of each written slot.
 *
 * With `keepInvisible`, an invisible splat's slot gets only its opacity
 * (0); its position and covariance stay as the buffers hold them. Playback
 * passes it for buffers that hold an earlier frame of the same clip, or the
 * canonical pose ({@link writeAsogCanonical}), in every slot: most splats are
 * invisible at any one time, and this skips their pose entirely.
 *
 * @returns `count`, the slots written, and `alive`, the visible splats.
 * @experimental
 */
export function evaluateAsogFrame(
  data: Pick<
    AsogData,
    'count' | 'centers' | 'rotations' | 'scales' | 'colors' | 'motion' | 'clips'
  >,
  t: number,
  buffers: AsogFrameBuffers,
  options: { compact?: boolean; sources?: Uint32Array; keepInvisible?: boolean } = {},
): { count: number; alive: number } {
  const { count, centers, rotations, scales, colors, motion, clips } = data;
  const { positions, covariances } = buffers;
  const out = buffers.colors;
  const clipCount = clips.length / ASOG_CLIP_FLOATS;
  const clipLocal = new Float64Array(clipCount);
  const clipWeight = new Float64Array(clipCount);
  for (let c = 0; c < clipCount; c++) {
    clipLocal[c] = asogClipLocalTime(clips, c, t);
    clipWeight[c] = asogClipWeight(clips, c, t);
  }
  const moved = new Float64Array(7);
  const keep = options.keepInvisible === true && options.compact !== true;
  let slot = 0;
  let alive = 0;
  for (let i = 0; i < count; i++) {
    const m = i * ASOG_MOTION_FLOATS;
    const flags = motion[m + ASOG_MOTION.flags]!;
    const clip = Math.floor(flags / 2);
    const cw = clipWeight[clip] ?? 0;
    // Outside its visible life (|t − μ| ≥ 2.4477σ) a dynamic splat is
    // invisible: known without evaluating it.
    const outsideLife =
      flags % 2 !== 1 &&
      Math.abs(clipLocal[clip]! - motion[m + ASOG_MOTION.mu]!) >=
        ASOG_LIFE_SIGMAS * motion[m + ASOG_MOTION.sigma]!;
    const weight =
      cw > 0 && !outsideLife
        ? cw * evaluateAsogSplat(motion, centers, i, clipLocal[clip]!, moved)
        : 0;
    if (weight <= 0 && keep) {
      out[i * 4 + 3] = 0;
      slot++;
      continue;
    }
    if (weight <= 0) {
      // Canonical pose for an invisible splat, so its slot sorts sensibly.
      moved[0] = centers[i * 3]!;
      moved[1] = centers[i * 3 + 1]!;
      moved[2] = centers[i * 3 + 2]!;
      moved[3] = 0;
      moved[4] = 0;
      moved[5] = 0;
      moved[6] = 1;
    } else {
      alive++;
    }
    if (options.compact && weight <= 0) continue;
    if (options.sources) options.sources[slot] = i;
    positions[slot * 3] = moved[0]!;
    positions[slot * 3 + 1] = moved[1]!;
    positions[slot * 3 + 2] = moved[2]!;
    // rotation(t) = q(w) ⊗ rotation, quaternions as (x, y, z, w) and (w, x, y, z).
    const px = moved[3]!;
    const py = moved[4]!;
    const pz = moved[5]!;
    const pw = moved[6]!;
    const qw = rotations[i * 4]!;
    const qx = rotations[i * 4 + 1]!;
    const qy = rotations[i * 4 + 2]!;
    const qz = rotations[i * 4 + 3]!;
    writeCovariance(
      covariances,
      slot,
      scales[i * 3]!,
      scales[i * 3 + 1]!,
      scales[i * 3 + 2]!,
      pw * qw - px * qx - py * qy - pz * qz,
      pw * qx + px * qw + py * qz - pz * qy,
      pw * qy - px * qz + py * qw + pz * qx,
      pw * qz + px * qy - py * qx + pz * qw,
    );
    out[slot * 4] = colors[i * 4]!;
    out[slot * 4 + 1] = colors[i * 4 + 1]!;
    out[slot * 4 + 2] = colors[i * 4 + 2]!;
    out[slot * 4 + 3] = Math.round(colors[i * 4 + 3]! * Math.min(weight, 1));
    slot++;
  }
  return { count: slot, alive };
}

/**
 * Writes every splat in its canonical (unmoved) pose with its own opacity:
 * what the GPU path uploads once, its modifier moving and fading it.
 *
 * @experimental
 */
export function writeAsogCanonical(
  data: Pick<AsogData, 'count' | 'centers' | 'rotations' | 'scales' | 'colors'>,
  buffers: AsogFrameBuffers,
): void {
  const { count, centers, rotations, scales, colors } = data;
  buffers.positions.set(centers.subarray(0, count * 3));
  buffers.colors.set(colors.subarray(0, count * 4));
  for (let i = 0; i < count; i++) {
    writeCovariance(
      buffers.covariances,
      i,
      scales[i * 3]!,
      scales[i * 3 + 1]!,
      scales[i * 3 + 2]!,
      rotations[i * 4]!,
      rotations[i * 4 + 1]!,
      rotations[i * 4 + 2]!,
      rotations[i * 4 + 3]!,
    );
  }
}

/**
 * A box around every centre a splat of `data` takes while visible: the
 * canonical centres, and each dynamic splat sampled at 33 times across its
 * visible life (`μ ± 2.45σ`), padded by 1 % of the box's size for the path
 * between samples.
 *
 * @experimental
 */
export function asogMotionBounds(data: Pick<AsogData, 'count' | 'centers' | 'motion'>): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const { count, centers, motion } = data;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const grow = (x: number, y: number, z: number): void => {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return;
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  };
  const out = new Float64Array(7);
  const samples = 33;
  for (let i = 0; i < count; i++) {
    grow(centers[i * 3]!, centers[i * 3 + 1]!, centers[i * 3 + 2]!);
    const m = i * ASOG_MOTION_FLOATS;
    if (motion[m + ASOG_MOTION.flags]! % 2 === 1) continue;
    const mu = motion[m + ASOG_MOTION.mu]!;
    const half = ASOG_LIFE_SIGMAS * motion[m + ASOG_MOTION.sigma]!;
    for (let s = 0; s < samples; s++) {
      const t = mu - half + (2 * half * s) / (samples - 1);
      if (evaluateAsogSplat(motion, centers, i, t, out) > 0) grow(out[0]!, out[1]!, out[2]!);
    }
  }
  if (!(min[0] <= max[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  const pad = 0.01 * Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-6);
  return {
    min: [min[0] - pad, min[1] - pad, min[2] - pad],
    max: [max[0] + pad, max[1] + pad, max[2] + pad],
  };
}
