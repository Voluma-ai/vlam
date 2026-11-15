/**
 * The `SplatModifier`s of `.csgs` GPU playback: they evaluate every splat's
 * hat curves at a time uniform from a section packed by
 * `formats/csgs/csgs-gpu-layout.ts`, so a section is uploaded once and a
 * frame costs no CPU evaluation and no upload.
 *
 * {@link csgsCurveModifier} moves the center (`offset`, the position knots
 * are deltas from the pool center), shapes the covariance through its linear
 * output (the base covariance is the identity, so `M = R(t)·S(t)` gives
 * `R·S²·Rᵀ`), sets the DC color and opacity, and masks dead splats.
 * {@link csgsPositionModifier} is its position part alone, for
 * `SplatMesh.sortDisplacement`: 2 texture reads and 2 channel reads per
 * splat per sort instead of 10 and 3.
 */
import * as THREE from 'three/webgpu';
import {
  clamp,
  exp,
  float,
  floor,
  int,
  ivec2,
  mat3,
  max,
  min,
  mix,
  textureLoad,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { SplatContext, SplatModifier } from '../core/splat-modifier';
import {
  CSGS_K_RADIX,
  CSGS_KNOT_TEXTURE_WIDTH,
  CSGS_LIFE_RADIX,
  CSGS_MAX_LOG_SCALE,
  CSGS_NEUTRAL_BYTE,
} from '../formats/csgs/csgs-gpu-layout';

const SH_C0 = 0.28209479177387814;

/** Channel names of the per-splat headers (see the layout module). */
export const CSGS_CHANNELS = ['csgsBase', 'csgsK', 'csgsLife'] as const;

/** Uniforms of the shown section. */
export interface CsgsCurveUniforms {
  /**
   * Section-local frame time, `t − g0` (fractional frames interpolate),
   * computed on the CPU in double precision.
   */
  readonly local: THREE.UniformNode<'float', number>;
  /** `max(nframes − 1, 1)` of the shown section. */
  readonly span: THREE.UniformNode<'float', number>;
}

type ChannelContext = Pick<SplatContext, 'channel'>;

/** Reads knot texels, knot counts and segment weights for one splat. */
function curveReader(knots: THREE.DataTexture, u: CsgsCurveUniforms, ctx: ChannelContext) {
  const width = int(CSGS_KNOT_TEXTURE_WIDTH);
  const fetch = (texel: Node<'int'>): Node<'vec4'> =>
    textureLoad(knots, ivec2(texel.mod(width), texel.div(width)));
  const radix = int(CSGS_K_RADIX);
  const packedK = int(ctx.channel('csgsK'));
  const count = (group: number): Node<'int'> => {
    let divisor = 1;
    for (let g = 0; g < group; g++) divisor *= CSGS_K_RADIX;
    return (group === 0 ? packedK : packedK.div(int(divisor))).mod(radix);
  };
  const startP = int(ctx.channel('csgsBase'));
  // Hat curve: the segment under `local` and its blend weight; one knot is
  // a constant (km1 = 0 pins both reads to it and the weight to zero).
  const segment = (k: Node<'int'>) => {
    const km1 = float(k.sub(1));
    const tau = clamp(u.local.mul(km1).div(u.span), 0, km1);
    const j = min(floor(tau), max(km1.sub(1), 0));
    return { j: int(j), next: int(min(j.add(1), km1)), w: tau.sub(j) };
  };
  const sample = (start: Node<'int'>, k: Node<'int'>): Node<'vec4'> => {
    const { j, next, w } = segment(k);
    return mix(fetch(start.add(j)), fetch(start.add(next)), w);
  };
  return { fetch, count, startP, segment, sample };
}

/**
 * The position part of {@link csgsCurveModifier}, for
 * `SplatMesh.sortDisplacement` (reads only the `P` knots).
 */
export function csgsPositionModifier(
  knots: THREE.DataTexture,
  u: CsgsCurveUniforms,
): SplatModifier {
  return (ctx) => {
    const { count, startP, sample } = curveReader(knots, u, ctx);
    return { offset: ctx.offset.add(sample(startP, count(0)).xyz) };
  };
}

/** The curve-evaluating modifier over `knots` (see the module comment). */
export function csgsCurveModifier(knots: THREE.DataTexture, u: CsgsCurveUniforms): SplatModifier {
  return (ctx) => {
    const { fetch, count, startP, segment, sample } = curveReader(knots, u, ctx);
    const kP = count(0);
    const kR = count(1);
    const kS = count(2);
    const kO = count(3);
    const kD = count(4);
    const startR = startP.add(kP);
    const startS = startR.add(kR);
    const startO = startS.add(kS);
    // Opacity knots pack four per texel (see csgs-gpu-layout.ts).
    const startD = startO.add(kO.add(3).div(4));
    /** Knot `index` of the packed scalar opacity curve. */
    const scalar = (start: Node<'int'>, index: Node<'int'>): Node<'float'> => {
      const lane = index.mod(int(4));
      const pick = vec4(
        lane.equal(int(0)).toFloat(),
        lane.equal(int(1)).toFloat(),
        lane.equal(int(2)).toFloat(),
        lane.equal(int(3)).toFloat(),
      );
      return fetch(start.add(index.div(int(4)))).dot(pick);
    };
    // Position knots are deltas from the pool center (the first knot).
    const delta = sample(startP, kP).xyz;
    const q = sample(startR, kR).normalize();
    const s = exp(min(sample(startS, kS).xyz, float(CSGS_MAX_LOG_SCALE)));
    const opacityKnots = segment(kO);
    const logit = mix(
      scalar(startO, opacityKnots.j),
      scalar(startO, opacityKnots.next),
      opacityKnots.w,
    );
    const dc = sample(startD, kD).xyz;
    // Rotation matrix of the wxyz quaternion, columns scaled: M = R·S, the
    // same convention as `writeCovariance`.
    const w = q.x;
    const x = q.y;
    const y = q.z;
    const z = q.w;
    const linear = mat3(
      vec3(
        float(1).sub(y.mul(y).add(z.mul(z)).mul(2)),
        x.mul(y).add(w.mul(z)).mul(2),
        x.mul(z).sub(w.mul(y)).mul(2),
      ).mul(s.x),
      vec3(
        x.mul(y).sub(w.mul(z)).mul(2),
        float(1).sub(x.mul(x).add(z.mul(z)).mul(2)),
        y.mul(z).add(w.mul(x)).mul(2),
      ).mul(s.y),
      vec3(
        x.mul(z).add(w.mul(y)).mul(2),
        y.mul(z).sub(w.mul(x)).mul(2),
        float(1).sub(x.mul(x).add(y.mul(y)).mul(2)),
      ).mul(s.z),
    );
    // Liveness as a float mask on alpha: `visible`/`select` drop splats in a
    // modifier graph (see proxy-depth.ts). Birth and death are section-local.
    const life = int(ctx.channel('csgsLife'));
    const frame = floor(u.local);
    const alive = frame
      .greaterThanEqual(float(life.mod(int(CSGS_LIFE_RADIX))))
      .and(frame.lessThan(float(life.div(int(CSGS_LIFE_RADIX)))))
      .toFloat();
    const opacity = float(1)
      .div(float(1).add(exp(logit.negate())))
      .mul(alive);
    // The pool's neutral color plus SH; swap the neutral DC for the curve's.
    const rgb = clamp(ctx.color.rgb.sub(CSGS_NEUTRAL_BYTE / 255).add(dc.mul(SH_C0).add(0.5)), 0, 1);
    return {
      offset: ctx.offset.add(delta),
      rotation: ctx.rotation.mul(linear),
      color: vec4(rgb, opacity),
    };
  };
}
