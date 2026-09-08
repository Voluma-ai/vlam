/** Shared TSL math; callers own storage access, policy, and output encoding. */
import type * as THREE from 'three/webgpu';
import { If, float, mat3, mix, vec2, vec3 } from 'three/tsl';
import { asNode } from './splat-material-types';
import { MAX_DOF_VARIANCE } from './depth-of-field';

type Scalar = THREE.Node<'float'>;
type ScalarInput = Scalar | number;

/** Projects an already transformed covariance through the perspective Jacobian. */
export function projectSplatCovariance(
  covariance: THREE.Node<'mat3'>,
  viewCenter: THREE.Node<'vec4'>,
  focal: THREE.Node<'vec2'>,
  viewRotationT: THREE.Node<'mat3'>,
): { a: Scalar; b: Scalar; d: Scalar } {
  const invZ = float(1).div(viewCenter.z);
  const invZ2 = invZ.mul(invZ);
  const j1 = vec3(focal.x.mul(invZ), 0, focal.x.negate().mul(viewCenter.x).mul(invZ2));
  const j2 = vec3(0, focal.y.mul(invZ), focal.y.negate().mul(viewCenter.y).mul(invZ2));
  const u1 = viewRotationT.mul(j1);
  const u2 = viewRotationT.mul(j2);
  return {
    a: asNode<'float'>(u1.dot(covariance.mul(u1))),
    d: asNode<'float'>(u2.dot(covariance.mul(u2))),
    b: asNode<'float'>(u1.dot(covariance.mul(u2))),
  };
}

/** Filters screen covariance and writes integral-preserving opacity compensation. */
export function filterSplatCovariance(
  raw: { a: Scalar; b: Scalar; d: Scalar },
  options: {
    lowPassVariance: ScalarInput;
    /** Boolean specializes the standalone graph; unified uses a live weight. */
    compensate: boolean | Scalar;
    isotropicMix: Scalar | null;
    viewZ: Scalar;
    focalX: Scalar;
    focusDistance: Scalar;
    aperture: Scalar;
  },
  opacityCompensation: Scalar,
): { a: Scalar; b: Scalar; d: Scalar } {
  const { lowPassVariance, compensate, isotropicMix } = options;
  const a = raw.a.add(lowPassVariance).toVar();
  const d = raw.d.add(lowPassVariance).toVar();
  const b = raw.b;
  const detBlur = a.mul(d).sub(b.mul(b)).max(1e-9).toVar();
  const detRaw = raw.a.mul(raw.d).sub(raw.b.mul(raw.b)).max(0);
  const detBase = raw.a
    .add(lowPassVariance)
    .mul(raw.d.add(lowPassVariance))
    .sub(raw.b.mul(raw.b))
    .max(1e-9);
  const withIsotropic = (fade: Scalar): Scalar =>
    isotropicMix === null ? fade : asNode<'float'>(mix(fade, float(1), isotropicMix));
  if (typeof compensate === 'boolean') {
    if (compensate)
      opacityCompensation.assign(withIsotropic(asNode<'float'>(detRaw.div(detBlur).sqrt())));
  } else {
    opacityCompensation.assign(float(1));
    If(compensate.greaterThan(0), () => {
      const mipFade = detRaw.div(detBlur).sqrt();
      opacityCompensation.assign(
        withIsotropic(asNode<'float'>(mix(float(1), mipFade, compensate))),
      );
    });
  }
  // Keep the live aperture branch: zero aperture performs no CoC calculation.
  If(options.aperture.greaterThan(0), () => {
    const depth = options.viewZ.negate().max(1e-4);
    const focus = options.focusDistance.max(1e-4);
    const halfApertureAngle = options.aperture.mul(0.5).div(focus).atan();
    const focusBlur = depth.sub(focus).abs().div(depth);
    const apertureRadius = options.focalX.mul(halfApertureAngle.tan());
    const cocRadiusPx = focusBlur.mul(apertureRadius);
    const cocVar = cocRadiusPx.mul(cocRadiusPx).min(float(MAX_DOF_VARIANCE));
    a.assign(raw.a.add(lowPassVariance).add(cocVar));
    d.assign(raw.d.add(lowPassVariance).add(cocVar));
    detBlur.assign(a.mul(d).sub(b.mul(b)).max(1e-9));
    const fade =
      typeof compensate === 'boolean'
        ? (compensate ? raw.a.mul(raw.d).sub(raw.b.mul(raw.b)).max(0) : detBase).div(detBlur).sqrt()
        : mix(detBase.div(detBlur).sqrt(), detRaw.div(detBlur).sqrt(), compensate);
    opacityCompensation.assign(withIsotropic(asNode<'float'>(fade)));
  });
  return { a: asNode<'float'>(a), b, d: asNode<'float'>(d) };
}

/** Eigenvalues of the symmetric projected covariance, before optional caps. */
export function projectedSplatEigenvalues(
  a: Scalar,
  b: Scalar,
  d: Scalar,
): { lambda1: Scalar; lambda2: Scalar } {
  const mid = a.add(d).mul(0.5);
  const radius = vec2(a.sub(d).mul(0.5), b).length();
  return {
    lambda1: asNode<'float'>(mid.add(radius)),
    lambda2: asNode<'float'>(mid.sub(radius).max(0)),
  };
}

/** Stable major-axis direction, including axis-aligned ellipses. */
export function projectedSplatEigenvector(
  a: Scalar,
  b: Scalar,
  lambda1: Scalar,
): THREE.Node<'vec2'> {
  return asNode<'vec2'>(vec2(b, lambda1.sub(a)).add(vec2(1e-6, 0)).normalize());
}

/** Screen ellipse axes with the existing maximum-then-minimum radius policy. */
export function projectedSplatAxes(
  direction: THREE.Node<'vec2'>,
  majorVariance: Scalar,
  minorVariance: Scalar,
  stdDev: Scalar,
  maxRadius: ScalarInput,
  minRadius: Scalar,
): { major: THREE.Node<'vec2'>; minor: THREE.Node<'vec2'> } {
  return {
    major: asNode<'vec2'>(
      direction.mul(majorVariance.sqrt().mul(stdDev).min(maxRadius).max(minRadius)),
    ),
    minor: asNode<'vec2'>(
      vec2(direction.y, direction.x.negate()).mul(
        minorVariance.sqrt().mul(stdDev).min(maxRadius).max(minRadius),
      ),
    ),
  };
}

/** RAD merged parents widen their cutoff without inflating covariance. */
export function radSplatStdDev(alpha: Scalar, base: Scalar): Scalar {
  const remap = alpha.mul(4).sub(3).min(5);
  return asNode<'float'>(alpha.greaterThan(1).select(base.add(remap.sub(1).mul(0.7)), base));
}

/** Gaussian falloff with a caller-specialized exponent (normally -4.5). */
export function gaussianSplatOpacity(
  distanceSquared: Scalar,
  exponent: ScalarInput,
  alpha: Scalar,
): Scalar {
  return asNode<'float'>(distanceSquared.mul(exponent).exp().mul(alpha));
}

/** RAD leaf/parent falloff. Visual fades are deliberately applied by the caller. */
export function radSplatOpacity(distanceSquared: Scalar, stdDev: Scalar, alpha: Scalar): Scalar {
  const g = distanceSquared.mul(stdDev.mul(stdDev).mul(-0.5)).exp();
  const remap = alpha.mul(4).sub(3).min(5);
  const aExp = remap
    .mul(remap)
    .sub(1)
    .mul(1 / Math.E)
    .exp();
  const merged = g.oneMinus().pow(aExp).oneMinus();
  return asNode<'float'>(alpha.greaterThan(1).select(merged, g.mul(alpha)));
}

/**
 * Tests whether a capped ellipse can cover any viewport pixel. The lateral
 * test uses the complete projected footprint, not merely its center, so a
 * large sky splat remains drawable while crossing a screen edge.
 */
export function isSplatFootprintInFrustum(
  clipCenter: THREE.Node<'vec4'>,
  viewport: THREE.Node<'vec2'>,
  majorAxis: THREE.Node<'vec2'>,
  minorAxis: THREE.Node<'vec2'>,
): THREE.Node<'bool'> {
  const nearMargin = clipCenter.w.mul(1.2);
  const ndcCenter = clipCenter.xy.div(clipCenter.w);
  // The enclosing quad reaches |major| + |minor| on each screen axis.
  const footprint = vec2(
    majorAxis.x.abs().add(minorAxis.x.abs()),
    majorAxis.y.abs().add(minorAxis.y.abs()),
  )
    .mul(2)
    .div(viewport);
  return asNode<'bool'>(
    clipCenter.z
      .greaterThan(nearMargin.negate())
      .and(clipCenter.z.lessThan(clipCenter.w))
      .and(ndcCenter.x.abs().lessThanEqual(float(1).add(footprint.x)))
      .and(ndcCenter.y.abs().lessThanEqual(float(1).add(footprint.y))),
  );
}

/** Default variance scale for isotropic point mode: (0.35 × min-axis)². */
export const DEFAULT_ISOTROPIC_VARIANCE_SCALE = 0.35 * 0.35;
/** Default isotropic screen-space sigma radius (px); only used when a modifier opts in. */
export const DEFAULT_ISOTROPIC_SCREEN_RADIUS_PX = 1.0;

/**
 * Blends `Σ` toward σ²·I where σ² = λ_min(Σ) · varianceScale. Spark point
 * mode sets every scale axis to min(scale)·0.35; since λ_min(Σ) = min(scale)²,
 * that is exactly σ² = (min·0.35)².
 *
 * λ_min is estimated without `Σ⁻¹` (near-singular on flat Gaussians, which
 * made n·Σ·n blow up into large blobs): take the min of the three axis
 * Rayleigh quotients and the Rayleigh along the longest row-cross of Σ (a
 * stable thin-axis hint when Σ is rank-deficient). The `normal` argument is
 * kept for call-site compatibility and ignored.
 */
export function applyIsotropicCovarianceOverride(
  covariance: THREE.Node<'mat3'>,
  _normal: THREE.Node<'vec3'>,
  mixFactor: THREE.Node<'float'>,
  varianceScale: THREE.Node<'float'>,
): THREE.Node<'mat3'> {
  const e0 = vec3(1, 0, 0);
  const e1 = vec3(0, 1, 0);
  const e2 = vec3(0, 0, 1);
  const row0 = covariance.mul(e0);
  const row1 = covariance.mul(e1);
  const row2 = covariance.mul(e2);
  const r0 = asNode<'float'>(row0.x);
  const r1 = asNode<'float'>(row1.y);
  const r2 = asNode<'float'>(row2.z);
  const crossA = row0.cross(row1);
  const crossB = row1.cross(row2);
  const crossC = row2.cross(row0);
  const lenA = crossA.length();
  const lenB = crossB.length();
  const lenC = crossC.length();
  const useA = lenA.greaterThanEqual(lenB).and(lenA.greaterThanEqual(lenC));
  const useB = lenB.greaterThan(lenA).and(lenB.greaterThanEqual(lenC));
  const axis = useA.select(crossA, useB.select(crossB, crossC));
  const thin = axis.div(axis.length().max(1e-12));
  const rThin = asNode<'float'>(thin.dot(covariance.mul(thin)));
  const minVar = asNode<'float'>(r0.min(r1).min(r2).min(rThin).max(1e-12));
  const isoVar = minVar.mul(varianceScale);
  const isoCov = mat3(vec3(isoVar, 0, 0), vec3(0, isoVar, 0), vec3(0, 0, isoVar));
  return asNode<'mat3'>(covariance.mul(float(1).sub(mixFactor)).add(isoCov.mul(mixFactor)));
}

/** Sets both screen-space eigenvalues to min(λ1, λ2) for a circular footprint. */
export function equalizeProjectedEigenvalues(
  lambda1: THREE.Node<'float'>,
  lambda2: THREE.Node<'float'>,
  mixFactor: THREE.Node<'float'>,
): { lambda1: THREE.Node<'float'>; lambda2: THREE.Node<'float'> } {
  const circle = lambda1.min(lambda2);
  return {
    lambda1: asNode<'float'>(mix(lambda1, circle, mixFactor)),
    lambda2: asNode<'float'>(mix(lambda2, circle, mixFactor)),
  };
}

/**
 * Caps isotropic λ to a screen-space sigma radius while blending by mix.
 * `screenRadiusPx ≤ 0` is a no-op (opt-in only; 0 must not shrink λ toward zero).
 */
export function capProjectedEigenvaluesToScreenRadius(
  lambda1: THREE.Node<'float'>,
  lambda2: THREE.Node<'float'>,
  mixFactor: THREE.Node<'float'>,
  screenRadiusPx: THREE.Node<'float'>,
  maxStdDev: THREE.Node<'float'>,
): { lambda1: THREE.Node<'float'>; lambda2: THREE.Node<'float'> } {
  const targetVariance = screenRadiusPx.div(maxStdDev).pow(2);
  const circle = lambda1.min(lambda2).min(targetVariance);
  const capped1 = asNode<'float'>(mix(lambda1, circle, mixFactor));
  const capped2 = asNode<'float'>(mix(lambda2, circle, mixFactor));
  const enabled = screenRadiusPx.greaterThan(0);
  return {
    lambda1: asNode<'float'>(enabled.select(capped1, lambda1)),
    lambda2: asNode<'float'>(enabled.select(capped2, lambda2)),
  };
}
