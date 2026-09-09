import * as THREE from 'three/webgpu';
import type { SplatData } from '../core/splat-data';
import type { SplatPoolBacking } from '../core/splat-mesh-pool';

/** Whether a brush selects only the picked surface corridor or the whole swept volume. */
export type SelectionDepthMode = 'surface' | 'through';

/** Whether selection tests Gaussian means or their full rendered ±3σ ellipsoids. */
export type SelectionFootprintMode = 'center' | 'footprint';

/** One depth-picked sample in an immutable world-space brush path. */
export interface BrushStrokeSample {
  readonly point: THREE.Vector3;
  /** World-space brush radius at this sample. */
  readonly radius: number;
  /** Positive camera view depth captured with the stroke, when available. */
  readonly viewDepth?: number;
}

/** A stroke split into paths at misses and depth discontinuities. */
export interface BrushStroke {
  readonly paths: readonly (readonly BrushStrokeSample[])[];
  /** World → view matrix captured with the stroke, required by `surface` mode. */
  readonly viewMatrix?: THREE.Matrix4;
}

/** Controls for {@link selectBrushStrokeInData}. */
export interface BrushStrokeSelectionOptions {
  /** Default `surface`. */
  readonly depth?: SelectionDepthMode;
  /** Default `center`. */
  readonly footprint?: SelectionFootprintMode;
  /** Gaussian support extent. Default `3`, matching VLAM's rendered ±3σ support. */
  readonly footprintSigma?: number;
  /** Half-thickness of the visible depth corridor as a fraction of brush radius. Default `0.35`. */
  readonly surfaceDepthFraction?: number;
}

interface StrokeHit {
  readonly sample0: BrushStrokeSample;
  readonly sample1: BrushStrokeSample;
  readonly t: number;
}

interface LinearTransform {
  readonly m00: number;
  readonly m01: number;
  readonly m02: number;
  readonly m10: number;
  readonly m11: number;
  readonly m12: number;
  readonly m20: number;
  readonly m21: number;
  readonly m22: number;
}

interface PreparedBrushSelection {
  readonly stroke: BrushStroke;
  readonly matrix: THREE.Matrix4;
  readonly linear: LinearTransform;
  readonly footprint: SelectionFootprintMode;
  readonly sigma: number;
  readonly depthFraction: number;
  readonly surface: boolean;
  readonly bounds: THREE.Box3;
}

/**
 * Selects splats intersected by a world-space brush stroke.
 *
 * Center mode is an exact union of linearly tapered capsules. Footprint mode
 * expands the test by the covariance support in the approach direction, using
 * VLAM's rendered ±3σ extent by default. `worldMatrix` maps `data` into the
 * stroke's world frame and may include rotation or non-uniform scale.
 */
export function selectBrushStrokeInData(
  data: SplatData,
  stroke: BrushStroke,
  options: BrushStrokeSelectionOptions = {},
  worldMatrix?: THREE.Matrix4,
): Uint32Array {
  const prepared = prepareBrushSelection(stroke, options, worldMatrix);
  const hits = new Uint32Array(data.count);
  const point = new THREE.Vector3();
  let count = 0;

  for (let i = 0; i < data.count; i++) {
    point
      .set(
        data.positions[i * 3] as number,
        data.positions[i * 3 + 1] as number,
        data.positions[i * 3 + 2],
      )
      .applyMatrix4(prepared.matrix);
    if (brushSelectsPoint(point, data.covariances, i * 6, prepared)) hits[count++] = i;
  }
  return hits.slice(0, count);
}

/**
 * Internal page-table variant over the pool's existing strided CPU mirrors.
 * Returns indices relative to `[start, start + count)` without copying a slab.
 * @internal
 */
export function selectBrushStrokeInPoolBacking(
  backing: SplatPoolBacking,
  start: number,
  count: number,
  stroke: BrushStroke,
  options: BrushStrokeSelectionOptions = {},
  worldMatrix?: THREE.Matrix4,
): Uint32Array {
  const prepared = prepareBrushSelection(stroke, options, worldMatrix);
  const hits = new Uint32Array(count);
  const covariance = new Float32Array(6);
  const point = new THREE.Vector3();
  let selected = 0;
  for (let i = 0; i < count; i++) {
    const p = (start + i) * 4;
    point
      .set(backing.centers[p] as number, backing.centers[p + 1] as number, backing.centers[p + 2])
      .applyMatrix4(prepared.matrix);
    covariance[0] = backing.covarianceA[p] as number;
    covariance[1] = backing.covarianceA[p + 1] as number;
    covariance[2] = backing.covarianceA[p + 2] as number;
    covariance[3] = backing.covarianceA[p + 3] as number;
    covariance[4] = backing.covarianceB[p] as number;
    covariance[5] = backing.covarianceB[p + 1] as number;
    if (brushSelectsPoint(point, covariance, 0, prepared)) hits[selected++] = i;
  }
  return hits.slice(0, selected);
}

function prepareBrushSelection(
  stroke: BrushStroke,
  options: BrushStrokeSelectionOptions,
  worldMatrix?: THREE.Matrix4,
): PreparedBrushSelection {
  const depth = options.depth ?? 'surface';
  if (depth === 'surface' && stroke.viewMatrix === undefined) {
    throw new Error('selectBrushStrokeInData: surface mode requires stroke.viewMatrix.');
  }
  for (const path of stroke.paths) {
    for (const sample of path) {
      finiteNonNegative(sample.radius, 'sample radius');
      if (
        !Number.isFinite(sample.point.x) ||
        !Number.isFinite(sample.point.y) ||
        !Number.isFinite(sample.point.z) ||
        (sample.viewDepth !== undefined && !Number.isFinite(sample.viewDepth))
      ) {
        throw new Error('selectBrushStrokeInData: stroke samples must be finite.');
      }
    }
  }
  const matrix = worldMatrix ?? new THREE.Matrix4();
  const linear = linearTransform(matrix);
  const footprint = options.footprint ?? 'center';
  const sigma = finiteNonNegative(options.footprintSigma ?? 3, 'footprintSigma');
  const depthFraction = finiteNonNegative(
    options.surfaceDepthFraction ?? 0.35,
    'surfaceDepthFraction',
  );
  const surface = depth === 'surface';
  const bounds = strokeBounds(stroke.paths);
  return { stroke, matrix, linear, footprint, sigma, depthFraction, surface, bounds };
}

function brushSelectsPoint(
  point: THREE.Vector3,
  covariance: Float32Array,
  covarianceOffset: number,
  prepared: PreparedBrushSelection,
): boolean {
  const maxSupport =
    prepared.footprint === 'footprint'
      ? prepared.sigma * covarianceTraceBound(covariance, covarianceOffset, prepared.linear)
      : 0;
  if (!insideExpandedBounds(point, prepared.bounds, maxSupport)) return false;
  return (
    findStrokeHit(
      point,
      prepared.stroke.paths,
      maxSupport,
      covariance,
      covarianceOffset,
      prepared.linear,
      prepared.footprint === 'footprint' ? prepared.sigma : 0,
      prepared.surface ? prepared.stroke.viewMatrix : undefined,
      prepared.depthFraction,
    ) !== null
  );
}

function strokeBounds(paths: readonly (readonly BrushStrokeSample[])[]): THREE.Box3 {
  const bounds = new THREE.Box3().makeEmpty();
  for (const path of paths) {
    for (const sample of path) {
      bounds.expandByPoint(
        new THREE.Vector3(
          sample.point.x - sample.radius,
          sample.point.y - sample.radius,
          sample.point.z - sample.radius,
        ),
      );
      bounds.expandByPoint(
        new THREE.Vector3(
          sample.point.x + sample.radius,
          sample.point.y + sample.radius,
          sample.point.z + sample.radius,
        ),
      );
    }
  }
  return bounds;
}

function insideExpandedBounds(point: THREE.Vector3, bounds: THREE.Box3, expand: number): boolean {
  return (
    point.x >= bounds.min.x - expand &&
    point.x <= bounds.max.x + expand &&
    point.y >= bounds.min.y - expand &&
    point.y <= bounds.max.y + expand &&
    point.z >= bounds.min.z - expand &&
    point.z <= bounds.max.z + expand
  );
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`selectBrushStrokeInData: ${name} must be finite and non-negative.`);
  }
  return value;
}

function linearTransform(matrix: THREE.Matrix4): LinearTransform {
  const e = matrix.elements;
  return {
    m00: e[0],
    m01: e[4],
    m02: e[8],
    m10: e[1],
    m11: e[5],
    m12: e[9],
    m20: e[2],
    m21: e[6],
    m22: e[10],
  };
}

function findStrokeHit(
  point: THREE.Vector3,
  paths: readonly (readonly BrushStrokeSample[])[],
  inflate: number,
  covariance: Float32Array,
  covarianceOffset: number,
  linear: LinearTransform,
  footprintSigma: number,
  viewMatrix: THREE.Matrix4 | undefined,
  depthFraction: number,
): StrokeHit | null {
  let best: StrokeHit | null = null;
  let bestGap = Infinity;
  for (const path of paths) {
    if (path.length === 1) {
      const sample = path[0] as BrushStrokeSample;
      const gap = point.distanceTo(sample.point) - sample.radius - inflate;
      const candidate = { sample0: sample, sample1: sample, t: 0 };
      if (
        gap <= 0 &&
        gap < bestGap &&
        acceptsStrokeHit(
          point,
          candidate,
          covariance,
          covarianceOffset,
          linear,
          footprintSigma,
          viewMatrix,
          depthFraction,
        )
      ) {
        best = candidate;
        bestGap = gap;
      }
      continue;
    }
    for (let i = 1; i < path.length; i++) {
      const sample0 = path[i - 1] as BrushStrokeSample;
      const sample1 = path[i] as BrushStrokeSample;
      const candidate = taperedCapsuleClosest(point, sample0, sample1, inflate);
      const hit = { sample0, sample1, t: candidate.t };
      if (
        candidate.gap <= 0 &&
        candidate.gap < bestGap &&
        acceptsStrokeHit(
          point,
          hit,
          covariance,
          covarianceOffset,
          linear,
          footprintSigma,
          viewMatrix,
          depthFraction,
        )
      ) {
        best = hit;
        bestGap = candidate.gap;
      }
    }
  }
  return best;
}

function acceptsStrokeHit(
  point: THREE.Vector3,
  hit: StrokeHit,
  covariance: Float32Array,
  offset: number,
  linear: LinearTransform,
  footprintSigma: number,
  viewMatrix: THREE.Matrix4 | undefined,
  depthFraction: number,
): boolean {
  if (
    footprintSigma > 0 &&
    !footprintIntersects(point, hit, covariance, offset, linear, footprintSigma)
  ) {
    return false;
  }
  return (
    viewMatrix === undefined ||
    insideSurfaceCorridor(
      point,
      hit,
      viewMatrix,
      covariance,
      offset,
      linear,
      footprintSigma,
      depthFraction,
    )
  );
}

/** Exact center test for the union of spheres whose radius varies linearly along a segment. */
function taperedCapsuleClosest(
  point: THREE.Vector3,
  a: BrushStrokeSample,
  b: BrushStrokeSample,
  inflate: number,
): { t: number; gap: number } {
  const dx = b.point.x - a.point.x;
  const dy = b.point.y - a.point.y;
  const dz = b.point.z - a.point.z;
  const wx = point.x - a.point.x;
  const wy = point.y - a.point.y;
  const wz = point.z - a.point.z;
  const dr = b.radius - a.radius;
  const r0 = a.radius + inflate;
  const aa = dx * dx + dy * dy + dz * dz - dr * dr;
  const bb = -2 * (wx * dx + wy * dy + wz * dz + r0 * dr);
  const candidates = [0, 1];
  if (aa > 1e-12) candidates.push(THREE.MathUtils.clamp(-bb / (2 * aa), 0, 1));
  let bestT = 0;
  let best = Infinity;
  for (const t of candidates) {
    const qx = wx - dx * t;
    const qy = wy - dy * t;
    const qz = wz - dz * t;
    const radius = r0 + dr * t;
    const value = qx * qx + qy * qy + qz * qz - radius * radius;
    if (value < best) {
      best = value;
      bestT = t;
    }
  }
  const qx = wx - dx * bestT;
  const qy = wy - dy * bestT;
  const qz = wz - dz * bestT;
  return { t: bestT, gap: Math.hypot(qx, qy, qz) - (r0 + dr * bestT) };
}

function footprintIntersects(
  point: THREE.Vector3,
  hit: StrokeHit,
  covariance: Float32Array,
  offset: number,
  linear: LinearTransform,
  sigma: number,
): boolean {
  const center = interpolatedPoint(hit);
  const radius = THREE.MathUtils.lerp(hit.sample0.radius, hit.sample1.radius, hit.t);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const dz = point.z - center.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance <= radius || distance === 0) return true;
  const support = covarianceSupport(
    covariance,
    offset,
    linear,
    dx / distance,
    dy / distance,
    dz / distance,
    sigma,
  );
  return distance <= radius + support;
}

function insideSurfaceCorridor(
  point: THREE.Vector3,
  hit: StrokeHit,
  viewMatrix: THREE.Matrix4,
  covariance: Float32Array,
  offset: number,
  linear: LinearTransform,
  sigma: number,
  depthFraction: number,
): boolean {
  const d0 = hit.sample0.viewDepth;
  const d1 = hit.sample1.viewDepth;
  if (d0 === undefined || d1 === undefined) return true;
  const expected = THREE.MathUtils.lerp(d0, d1, hit.t);
  const e = viewMatrix.elements;
  const depth = -(e[2] * point.x + e[6] * point.y + e[10] * point.z + e[14]);
  const radius = THREE.MathUtils.lerp(hit.sample0.radius, hit.sample1.radius, hit.t);
  const support =
    sigma === 0 ? 0 : covarianceSupport(covariance, offset, linear, -e[2], -e[6], -e[10], sigma);
  return Math.abs(depth - expected) <= radius * depthFraction + support;
}

function interpolatedPoint(hit: StrokeHit): THREE.Vector3 {
  return new THREE.Vector3().lerpVectors(hit.sample0.point, hit.sample1.point, hit.t);
}

function covarianceTraceBound(
  covariance: Float32Array,
  offset: number,
  linear: LinearTransform,
): number {
  const x = covarianceSupport(covariance, offset, linear, 1, 0, 0, 1);
  const y = covarianceSupport(covariance, offset, linear, 0, 1, 0, 1);
  const z = covarianceSupport(covariance, offset, linear, 0, 0, 1, 1);
  return Math.hypot(x, y, z);
}

function covarianceSupport(
  covariance: Float32Array,
  offset: number,
  linear: LinearTransform,
  nx: number,
  ny: number,
  nz: number,
  sigma: number,
): number {
  const lx = linear.m00 * nx + linear.m10 * ny + linear.m20 * nz;
  const ly = linear.m01 * nx + linear.m11 * ny + linear.m21 * nz;
  const lz = linear.m02 * nx + linear.m12 * ny + linear.m22 * nz;
  const c00 = covariance[offset] as number;
  const c01 = covariance[offset + 1] as number;
  const c02 = covariance[offset + 2] as number;
  const c11 = covariance[offset + 3] as number;
  const c12 = covariance[offset + 4] as number;
  const c22 = covariance[offset + 5] as number;
  const variance =
    lx * (c00 * lx + c01 * ly + c02 * lz) +
    ly * (c01 * lx + c11 * ly + c12 * lz) +
    lz * (c02 * lx + c12 * ly + c22 * lz);
  return sigma * Math.sqrt(Math.max(0, variance));
}
