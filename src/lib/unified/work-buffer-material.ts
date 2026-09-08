import * as THREE from 'three/webgpu';
import type { DisplayColorModifier, FloatUniform, Vec2Uniform } from '../core/splat-material-types';
import {
  capProjectedEigenvaluesToScreenRadius,
  equalizeProjectedEigenvalues,
  isSplatFootprintInFrustum,
  projectSplatCovariance,
  filterSplatCovariance,
  projectedSplatEigenvalues,
  projectedSplatEigenvector,
  projectedSplatAxes,
  radSplatStdDev,
  radSplatOpacity,
} from '../core/splat-render-math';
import { MAX_SPLAT_RADIUS_PX } from '../core/splat-frustum';
import {
  Discard,
  Fn,
  cameraProjectionMatrix,
  float,
  instanceIndex,
  mat3,
  modelViewMatrix,
  positionGeometry,
  screenUV,
  storage,
  varying,
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
    const raw = projectSplatCovariance(
      covariance,
      viewCenter,
      options.focal,
      modelViewMatrix.toMat3().transpose(),
    );
    const isoMix = isotropicMix.element(workIndex);
    const { a, b, d } = filterSplatCovariance(
      raw,
      {
        lowPassVariance: options.projectedLowPassVariance,
        compensate: options.antialias.max(options.compensateProjectedLowPass),
        isotropicMix: isoMix,
        viewZ: viewCenter.z,
        focalX: options.focal.x,
        focusDistance: options.dofFocusDistance,
        aperture: options.dofAperture,
      },
      opacityCompensation,
    );
    let { lambda1, lambda2 } = projectedSplatEigenvalues(a, b, d);
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
    const stdDev = radSplatStdDev(workColor.a, options.maxStdDev);
    adjustedStdDev.assign(stdDev);
    const eigenvector = projectedSplatEigenvector(a, b, lambda1);
    // Screen-space minimum on each axis: a splat below the floor grows to it so
    // its Gaussian tiles with neighbours instead of leaving dark gaps between
    // sparse zoomed-out splats; already-large splats are untouched. Mirrors
    // `applySplatMaterialGraph`. Both render paths share the 512 px axis cap.
    const minSplat = options.minSplatSizePx;
    const { major, minor } = projectedSplatAxes(
      eigenvector,
      lambda1,
      lambda2,
      stdDev,
      MAX_SPLAT_RADIUS_PX,
      minSplat,
    );
    const pixelOffset = major.mul(positionGeometry.x).add(minor.mul(positionGeometry.y));
    const ndcCenter = clipCenter.xy.div(clipCenter.w);
    const clipPosition = vec4(
      ndcCenter.add(pixelOffset.mul(2).div(options.viewport)),
      clipCenter.z.div(clipCenter.w),
      1,
    );
    // Match SplatMesh's conservative footprint-frustum rejection. Without the
    // near/behind and far-plane checks, extreme RAD outliers can project
    // mirrored or screen-filling quads into the unified main + marker draw.
    // Modifier-hidden / zero-opacity entries (displayOpacity=0) share the
    // clipped destination so they generate no fragments while keeping a stable sort slot.
    const inFrustum = isSplatFootprintInFrustum(clipCenter, options.viewport, major, minor);
    return inFrustum.and(drawable).select(clipPosition, vec4(0, 0, 2, 1));
  })();
  material.fragmentNode = Fn(() => {
    const squaredDistance = quadPosition.dot(quadPosition);
    Discard(squaredDistance.greaterThan(1));
    const opacity = radSplatOpacity(squaredDistance, adjustedStdDev, workColor.a);
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
