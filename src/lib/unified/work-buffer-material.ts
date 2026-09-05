import * as THREE from 'three/webgpu';
import type {
  DisplayColorModifier,
  FloatUniform,
  Vec2Uniform,
} from '../core/splat-mesh-material';
import {
  capProjectedEigenvaluesToScreenRadius,
  equalizeProjectedEigenvalues,
} from '../core/splat-mesh-material';
import { MAX_DOF_VARIANCE } from '../core/depth-of-field';

/** Reject corrupt covariance outliers before they become screen-filling quads. */
const MAX_UNIFIED_SPLAT_RADIUS_PX = 256;
import {
  Discard,
  Fn,
  If,
  cameraProjectionMatrix,
  float,
  instanceIndex,
  mat3,
  mix,
  modelViewMatrix,
  positionGeometry,
  screenUV,
  storage,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

/**
 * Creates the unified EWA draw material for gathered world-space splats.
 *
 * Its vertex stage reads both the sorter-written order and the gather-written
 * centers, covariance, and resolved color from storage buffers. It keeps the
 * verified ±3σ / exp(-4.5·|q|²) convention used by {@link SplatMesh}.
 */
export function createWorkBufferMaterial(options: {
  capacity: number;
  centers: THREE.StorageBufferAttribute;
  colors: THREE.StorageBufferAttribute;
  covarianceA: THREE.StorageBufferAttribute;
  covarianceB: THREE.StorageBufferAttribute;
  isotropicMix: THREE.StorageBufferAttribute;
  isotropicScreenRadius: THREE.StorageBufferAttribute;
  order: THREE.StorageInstancedBufferAttribute;
  focal: Vec2Uniform;
  viewport: Vec2Uniform;
  maxStdDev: FloatUniform;
  /** Screen-space minimum splat radius in px; `0` disables. */
  minSplatSizePx: FloatUniform;
  antialias: FloatUniform;
  /** Format-selected projected low-pass variance, in px². */
  projectedLowPassVariance: FloatUniform;
  /** LCC always preserves the low-pass integral; standard follows antialias. */
  compensateProjectedLowPass: FloatUniform;
  /** Core projected-2D DoF focus plane. Live; `0` aperture disables. */
  dofFocusDistance: FloatUniform;
  dofAperture: FloatUniform;
  /** Optional display-only RGB transform; omitted adds no fragment work. */
  displayColorModifier?: DisplayColorModifier | null;
}): THREE.NodeMaterial {
  const material = new THREE.NodeMaterial();
  const centers = storage(options.centers, 'vec4', options.capacity);
  const order = storage(options.order, 'float', options.capacity);
  const colors = storage(options.colors, 'vec4', options.capacity);
  const covarianceA = storage(options.covarianceA, 'vec4', options.capacity);
  const covarianceB = storage(options.covarianceB, 'vec4', options.capacity);
  const isotropicMix = storage(options.isotropicMix, 'float', options.capacity);
  const isotropicScreenRadius = storage(options.isotropicScreenRadius, 'float', options.capacity);
  const workColor = varying(vec4(1, 1, 1, 1), 'vWorkColor');
  const quadPosition = varying(positionGeometry.xy, 'vWorkQuadPosition');
  const opacityCompensation = varying(float(1), 'vWorkOpacityCompensation');
  const displayOpacity = varying(float(1), 'vWorkDisplayOpacity');
  // Spark LOD alpha, matching `SplatMesh`'s display graph. The gather has
  // already recovered `alpha ∈ [0,2]` for `.rad` sources, so `alpha > 1`
  // identifies a merged node here without a per-source shader variant: a
  // non-`.rad` source can only reach `alpha ≤ 1`, for which the branches below
  // collapse to the plain Gaussian this material has always drawn.
  const adjustedStdDev = varying(float(0), 'vWorkAdjustedStdDev');
  material.vertexNode = Fn(() => {
    const workIndex = order.element(instanceIndex).toInt();
    const centerSample = centers.element(workIndex);
    const center = centerSample.xyz;
    // Gather stamps display opacity into center.w. `w <= 0` is non-drawable
    // (hidden, fully faded, or a zero source). Fractional fades still draw.
    const drawable = centerSample.w.greaterThan(0);
    displayOpacity.assign(centerSample.w);
    workColor.assign(colors.element(workIndex));
    const viewCenter = modelViewMatrix.mul(vec4(center, 1.0)).toVar();
    const clipCenter = cameraProjectionMatrix.mul(viewCenter).toVar();
    const covA = covarianceA.element(workIndex);
    const covB = covarianceB.element(workIndex);
    const covariance = mat3(
      vec3(covA.x, covA.y, covA.z),
      vec3(covA.y, covA.w, covB.x),
      vec3(covA.z, covB.x, covB.y),
    );
    const invZ = float(1).div(viewCenter.z);
    const invZ2 = invZ.mul(invZ);
    const j1 = vec3(
      options.focal.x.mul(invZ),
      0,
      options.focal.x.negate().mul(viewCenter.x).mul(invZ2),
    );
    const j2 = vec3(
      0,
      options.focal.y.mul(invZ),
      options.focal.y.negate().mul(viewCenter.y).mul(invZ2),
    );
    const viewRotationT = modelViewMatrix.toMat3().transpose();
    const u1 = viewRotationT.mul(j1);
    const u2 = viewRotationT.mul(j2);
    const aRaw = u1.dot(covariance.mul(u1));
    const dRaw = u2.dot(covariance.mul(u2));
    const bRaw = u1.dot(covariance.mul(u2));

    const a = aRaw.add(options.projectedLowPassVariance).toVar();
    const d = dRaw.add(options.projectedLowPassVariance).toVar();
    const b = bRaw;
    const isoMix = isotropicMix.element(workIndex);
    const detBlur = a.mul(d).sub(b.mul(b)).max(1e-9).toVar();
    // Classic LCC always compensates its 0.1 px² low-pass. Standard sources
    // retain their antialias-controlled 0.3 px² compatibility behavior.
    const detRaw = aRaw.mul(dRaw).sub(bRaw.mul(bRaw)).max(0);
    const detBase = aRaw
      .add(options.projectedLowPassVariance)
      .mul(dRaw.add(options.projectedLowPassVariance))
      .sub(bRaw.mul(bRaw))
      .max(1e-9);
    const compensate = options.antialias.max(options.compensateProjectedLowPass);
    // With both compensation controls at zero this result is identically one;
    // keep that default path free of determinant/square-root work.
    opacityCompensation.assign(float(1));
    If(compensate.greaterThan(0), () => {
      const mipFade = detRaw.div(detBlur).sqrt();
      const fade = mix(float(1), mipFade, compensate);
      opacityCompensation.assign(mix(fade, float(1), isoMix));
    });
    // Aperture is live, so this shader branch preserves animated setters while
    // keeping the default zero-aperture path free of depth/atan/CoC math.
    If(options.dofAperture.greaterThan(0), () => {
      const depth = viewCenter.z.negate().max(1e-4);
      const focus = options.dofFocusDistance.max(1e-4);
      // Aperture maps through the live focus plane (Spark host-helper parity).
      const halfApertureAngle = options.dofAperture.mul(0.5).div(focus).atan();
      const focusBlur = depth.sub(focus).abs().div(depth);
      const apertureRadius = options.focal.x.mul(halfApertureAngle.tan());
      const cocRadiusPx = focusBlur.mul(apertureRadius);
      const cocVar = cocRadiusPx.mul(cocRadiusPx).min(float(MAX_DOF_VARIANCE));
      a.assign(aRaw.add(options.projectedLowPassVariance).add(cocVar));
      d.assign(dRaw.add(options.projectedLowPassVariance).add(cocVar));
      detBlur.assign(a.mul(d).sub(b.mul(b)).max(1e-9));
      const dofOnlyFade = detBase.div(detBlur).sqrt();
      const mipFade = detRaw.div(detBlur).sqrt();
      const fade = mix(dofOnlyFade, mipFade, compensate);
      opacityCompensation.assign(mix(fade, float(1), isoMix));
    });
    const mid = a.add(d).mul(0.5);
    const radius = vec2(a.sub(d).mul(0.5), b).length();
    let lambda1 = mid.add(radius);
    let lambda2 = mid.sub(radius).max(0);
    const equalized = equalizeProjectedEigenvalues(lambda1, lambda2, isoMix);
    lambda1 = equalized.lambda1;
    lambda2 = equalized.lambda2;
    const capped = capProjectedEigenvaluesToScreenRadius(
      lambda1,
      lambda2,
      isoMix,
      isotropicScreenRadius.element(workIndex),
      options.maxStdDev,
    );
    lambda1 = capped.lambda1;
    lambda2 = capped.lambda2;
    // A merged node (`alpha > 1`) grows the σ-cutoff `maxStdDev + 0.7·(remap−1)`
    // so one coarse splat covers the subtree it stands in for; the covariance is
    // untouched. A leaf keeps the base cutoff. `SplatMesh` does the same at
    // `applySplatMaterialGraph`'s `lodAlpha` branch.
    const remap = workColor.a.mul(4).sub(3).min(5);
    const stdDev = workColor.a
      .greaterThan(1)
      .select(options.maxStdDev.add(remap.sub(1).mul(0.7)), options.maxStdDev);
    adjustedStdDev.assign(stdDev);
    const eigenvector = vec2(b, lambda1.sub(a)).add(vec2(1e-6, 0)).normalize();
    const projectedRadius = lambda1.sqrt().mul(stdDev);
    // Screen-space minimum on each axis: a splat below the floor grows to it so
    // its Gaussian tiles with neighbours instead of leaving dark gaps between
    // sparse zoomed-out splats; already-large splats are untouched. Mirrors
    // `applySplatMaterialGraph`. `.max` after `.min(1024)` keeps the order valid.
    const minSplat = options.minSplatSizePx;
    const major = eigenvector.mul(projectedRadius.min(1024).max(minSplat));
    const minor = vec2(eigenvector.y, eigenvector.x.negate()).mul(
      lambda2.sqrt().mul(stdDev).min(1024).max(minSplat),
    );
    const pixelOffset = major.mul(positionGeometry.x).add(minor.mul(positionGeometry.y));
    const ndcCenter = clipCenter.xy.div(clipCenter.w);
    const clipPosition = vec4(
      ndcCenter.add(pixelOffset.mul(2).div(options.viewport)),
      clipCenter.z.div(clipCenter.w),
      1,
    );
    // Match SplatMesh's conservative center-frustum rejection. Without the
    // near/behind and far-plane checks, extreme RAD outliers can project
    // mirrored or screen-filling quads into the unified main + marker draw.
    // Modifier-hidden / zero-opacity entries (displayOpacity=0) share the
    // clipped destination so they generate no fragments while keeping a stable sort slot.
    const margin = clipCenter.w.mul(1.2);
    const inFrustum = clipCenter.z
      .greaterThan(margin.negate())
      .and(clipCenter.z.lessThan(clipCenter.w))
      .and(clipCenter.x.abs().lessThan(margin))
      .and(clipCenter.y.abs().lessThan(margin));
    const isReasonablySized = projectedRadius.lessThanEqual(MAX_UNIFIED_SPLAT_RADIUS_PX);
    return inFrustum
      .and(drawable)
      .and(isReasonablySized)
      .select(clipPosition, vec4(0, 0, 2, 1));
  })();
  material.fragmentNode = Fn(() => {
    const squaredDistance = quadPosition.dot(quadPosition);
    Discard(squaredDistance.greaterThan(1));
    // Spark's LOD falloff, mirroring `SplatMesh`'s display fragment.
    // `g = exp(-½·adjustedStdDev²·|q|²)` is the Gaussian at this fragment. A leaf
    // (`alpha ≤ 1`, and every non-`.rad` source) composites `g · alpha`. A merged
    // node uses the super-Gaussian plateau `1 − (1 − g)^a`, `a = exp((remap²−1)/e)`,
    // so a coarse splat fills its subtree's footprint without inflating Σ.
    const g = squaredDistance.mul(adjustedStdDev.mul(adjustedStdDev).mul(-0.5)).exp();
    const remap = workColor.a.mul(4).sub(3).min(5);
    const aExp = remap
      .mul(remap)
      .sub(1)
      .mul(1 / Math.E)
      .exp();
    const merged = g.oneMinus().pow(aExp).oneMinus();
    const opacity = workColor.a.greaterThan(1).select(merged, g.mul(workColor.a));
    const alpha = opacity.mul(opacityCompensation).mul(displayOpacity);
    const rgb = (
      options.displayColorModifier?.(workColor.rgb, screenUV, options.viewport) ?? workColor.rgb
    ).toVar();
    return vec4(rgb.mul(alpha), alpha);
  })();
  material.transparent = true;
  material.depthTest = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  // The billboard is symmetric; avoid three.js's default two-pass DoubleSide
  // submission for transparent materials.
  material.forceSinglePass = true;
  material.toneMapped = false;
  return material;
}
