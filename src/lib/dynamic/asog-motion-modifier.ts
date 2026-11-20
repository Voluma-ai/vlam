/**
 * The `SplatModifier`s of `.asog` GPU playback: they evaluate every splat's
 * TRiGS rigid-body motion (format section 4.1) at a time uniform, from a
 * motion texture and a clip table uploaded once, so a frame costs no CPU
 * evaluation and no upload. The twin of `evaluateAsogSplat`
 * (`formats/asog/asog-motion.ts`), in float32.
 *
 * {@link asogMotionModifier} moves the centre (`offset`), turns the
 * covariance by the motion's rotation (`rotation`, exact for a rigid turn:
 * `Σ' = R·Σ·Rᵀ`) and scales opacity by the temporal and clip weights.
 * {@link asogPositionModifier} is its position part alone, for
 * `SplatMesh.sortDisplacement`.
 *
 * Every branch is a float mask (`mix`, `step`): `select`/`If` in a modifier
 * graph drops splats.
 */
import * as THREE from 'three/webgpu';
import {
  clamp,
  cos,
  cross,
  dot,
  exp,
  float,
  floor,
  int,
  ivec2,
  mat3,
  max,
  mix,
  sin,
  sqrt,
  step,
  textureLoad,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { SplatContext, SplatModifier } from '../core/splat-modifier';
import { ASOG_TEMPORAL_THRESHOLD } from '../formats/asog/asog-motion';

/** Texels per row of the motion texture (RGBA32F). */
export const ASOG_MOTION_TEXTURE_WIDTH = 4096;
/** Motion texels per splat (`ASOG_MOTION_FLOATS / 4`). */
export const ASOG_MOTION_TEXELS = 5;
/** Channel holding each slot's first motion texel. */
export const ASOG_BASE_CHANNEL = 'asogBase';
/** Below this rotation angle (rad) A, B and C come from their series. */
const SERIES_ANGLE = 0.5;

/**
 * The GPU state of a playing clip. Both textures are uploaded once; only
 * the `time` uniform changes per frame, and each clip's local time and fade
 * weight are derived from it here.
 *
 * - `motion`: {@link ASOG_MOTION_TEXELS} RGBA32F texels per splat, the
 *   layout of `ASOG_MOTION_FLOATS`.
 * - `clips`: the clip table, two RGBA32F texels per clip: (time offset,
 *   active start, active end, 0) and (core start, core end, fade-in,
 *   fade-out), in seconds.
 * - `time`: the global clip time in seconds.
 */
export interface AsogMotionState {
  readonly motion: THREE.DataTexture;
  readonly clips: THREE.DataTexture;
  readonly time: THREE.UniformNode<'float', number>;
}

type MotionContext = Pick<SplatContext, 'channel' | 'sourceCenter'>;

/** The evaluated motion of one splat. */
function evaluateMotion(state: AsogMotionState, ctx: MotionContext) {
  const width = int(ASOG_MOTION_TEXTURE_WIDTH);
  const base = int(ctx.channel(ASOG_BASE_CHANNEL));
  const fetch = (k: number): Node<'vec4'> => {
    const texel = base.add(k);
    return textureLoad(state.motion, ivec2(texel.mod(width), texel.div(width)));
  };
  const t0 = fetch(0);
  const t1 = fetch(1);
  const t2 = fetch(2);
  const t3 = fetch(3);
  const t4 = fetch(4);
  const mu = t0.x;
  const sigma = t0.y;
  const flags = t0.z;
  const half = floor(flags.mul(0.5));
  const isStatic = flags.sub(half.mul(2));
  // The splat's clip: its local time, 0 outside its active range, smoothstep
  // fades outside its core range (`asogClipWeight`).
  const row0 = textureLoad(state.clips, ivec2(int(half).mul(2), int(0)));
  const row1 = textureLoad(state.clips, ivec2(int(half).mul(2).add(1), int(0)));
  const global = state.time;
  const t = global.sub(row0.x);
  const active = step(row0.y, global).mul(float(1).sub(step(row0.z, global)));
  const fadeIn = row1.z;
  const fadeOut = row1.w;
  const inFade = step(float(1e-9), fadeIn).mul(float(1).sub(step(row1.x, global)));
  const outFade = float(1)
    .sub(inFade)
    .mul(step(float(1e-9), fadeOut))
    .mul(step(row1.y, global));
  const xIn = global.sub(row1.x.sub(fadeIn)).div(max(fadeIn, 1e-9));
  const xOut = row1.y.add(fadeOut).sub(global).div(max(fadeOut, 1e-9));
  const fade = clamp(mix(mix(float(1), xOut, outFade), xIn, inFade), 0, 1);
  const clipWeight = active.mul(fade.mul(fade).mul(float(3).sub(fade.mul(2))));

  const dt = t.sub(mu);
  const x = dt.div(sigma);
  const gamma = exp(x.mul(x).mul(-0.5));
  const temporal = max(gamma.sub(ASOG_TEMPORAL_THRESHOLD).div(1 - ASOG_TEMPORAL_THRESHOLD), 0);
  const weight = mix(temporal, float(1), isStatic).mul(clipWeight);
  /** 1 for a dynamic splat inside its life, else 0: only those move. */
  const moving = float(1)
    .sub(isStatic)
    .mul(step(float(1e-30), temporal));

  const tau = clamp(t.sub(mu.sub(sigma.mul(2))).div(sigma.mul(4)), 0, 1);
  const u = float(1).sub(tau);
  const b0 = u.mul(u);
  const b1 = u.mul(tau).mul(2);
  const b2 = tau.mul(tau);
  const o0 = vec3(t1.z, t1.w, t2.x);
  const o1 = vec3(t2.y, t2.z, t2.w);
  const o2 = vec3(t3.x, t3.y, t3.z);
  const omega = o0.mul(b0).add(o1.mul(b1)).add(o2.mul(b2));
  const g = b0
    .mul(b0)
    .mul(t3.w)
    .add(b0.mul(b1).mul(2).mul(t4.x))
    .add(b1.mul(b1).add(b0.mul(b2).mul(2)).mul(t4.y))
    .add(b1.mul(b2).mul(2).mul(t4.z))
    .add(b2.mul(b2).mul(t4.w));
  const anchor = vec3(t0.w, t1.x, t1.y);
  const oo = dot(omega, omega);
  const perpendicular = step(float(1e-8), oo);
  const aPerp = anchor.sub(omega.mul(dot(anchor, omega).div(max(oo, 1e-30)).mul(perpendicular)));
  const gs = g.div(max(oo, 1e-24));
  const w = omega.mul(dt);
  const v = omega.mul(gs.mul(dt));
  const th2 = dot(w, w);
  const th = sqrt(th2);
  // Small angles: Taylor series to θ⁴ (float32 cancels in (θ − sin θ)/θ³).
  const series = step(th, float(SERIES_ANGLE));
  const th4 = th2.mul(th2);
  const closed = max(th, SERIES_ANGLE * 0.5);
  const sinT = sin(closed);
  const cosT = cos(closed);
  const closed2 = closed.mul(closed);
  const cA = mix(sinT.div(closed), float(1).sub(th2.div(6)).add(th4.div(120)), series);
  const cB = mix(
    float(1).sub(cosT).div(closed2),
    float(0.5).sub(th2.div(24)).add(th4.div(720)),
    series,
  );
  const cC = mix(
    closed.sub(sinT).div(closed2.mul(closed)),
    float(1 / 6)
      .sub(th2.div(120))
      .add(th4.div(5040)),
    series,
  );
  const r = ctx.sourceCenter.sub(aPerp);
  const wr = cross(w, r);
  const wv = cross(w, v);
  // centre − x = A (w × r) + B w × (w × r) + v + B (w × v) + C w × (w × v)
  const displacement = wr
    .mul(cA)
    .add(cross(w, wr).mul(cB))
    .add(v)
    .add(wv.mul(cB))
    .add(cross(w, wv).mul(cC));
  // q(w) = (w/θ · sin(θ/2), cos(θ/2)), masked to the identity when not moving.
  const sinHalfOverTh = mix(
    sin(closed.mul(0.5)).div(closed),
    float(0.5).sub(th2.div(48)).add(th4.div(3840)),
    series,
  );
  const qxyz = w.mul(sinHalfOverTh.mul(moving));
  const qw = mix(float(1), cos(th.mul(0.5)), moving);
  return { offset: displacement.mul(moving), qxyz, qw, weight };
}

/** The rotation matrix of a unit quaternion (x, y, z, w). */
function quaternionMatrix(q: Node<'vec3'>, w: Node<'float'>): Node<'mat3'> {
  const x = q.x;
  const y = q.y;
  const z = q.z;
  return mat3(
    vec3(
      float(1).sub(y.mul(y).add(z.mul(z)).mul(2)),
      x.mul(y).add(w.mul(z)).mul(2),
      x.mul(z).sub(w.mul(y)).mul(2),
    ),
    vec3(
      x.mul(y).sub(w.mul(z)).mul(2),
      float(1).sub(x.mul(x).add(z.mul(z)).mul(2)),
      y.mul(z).add(w.mul(x)).mul(2),
    ),
    vec3(
      x.mul(z).add(w.mul(y)).mul(2),
      y.mul(z).sub(w.mul(x)).mul(2),
      float(1).sub(x.mul(x).add(y.mul(y)).mul(2)),
    ),
  );
}

/** The position part of {@link asogMotionModifier}, for `SplatMesh.sortDisplacement`. */
export function asogPositionModifier(state: AsogMotionState): SplatModifier {
  return (ctx) => ({ offset: ctx.offset.add(evaluateMotion(state, ctx).offset) });
}

/** The motion-evaluating modifier over `state` (see the module comment). */
export function asogMotionModifier(state: AsogMotionState): SplatModifier {
  return (ctx) => {
    const motion = evaluateMotion(state, ctx);
    return {
      offset: ctx.offset.add(motion.offset),
      rotation: ctx.rotation.mul(quaternionMatrix(motion.qxyz, motion.qw)),
      color: vec4(ctx.color.rgb, ctx.color.a.mul(clamp(motion.weight, 0, 1))),
    };
  };
}
