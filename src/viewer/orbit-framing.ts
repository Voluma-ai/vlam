import * as THREE from 'three/webgpu';
import type { OrbitFraming } from './orbital-camera-path';

/**
 * Demo-only classification of a capture for the cinematic camera path.
 *
 * Object captures (the goose, a statue, a vehicle) are compact: the bounding
 * box is a fair stand-in for the thing, so orbiting *around* it from outside
 * is the right move. Landscapes are the opposite. Photogrammetry of ground
 * produces a wide disk of splats, sometimes with a cloud/sky dome above, and
 * the AABB center then sits in empty air. Fitting that box puts the camera
 * outside the capture looking at the sky. The path wants to sit *in* the
 * disk at eye height and orbit a ground point.
 *
 * This is a heuristic, not a semantic label. It looks at the world-space AABB
 * (always available, including streamed manifests) and, when decoded centers
 * or LOD leaf heights exist, at occupancy along height and around the box
 * center. A sky dome makes the box roughly hemispherical, so AABB aspect
 * alone is not enough, and the box min is often underground floaters rather
 * than the terrain.
 */

/** Horizontal / vertical ratio that, on *both* ground axes, means a disk. */
const FOOTPRINT_WIDE = 1.9;
const FOOTPRINT_NARROW = 1.35;

/** Occupancy: mass in the lowest 32% of AABB height. */
const BOTTOM_BAND = 0.32;
const BOTTOM_MASS = 0.48;

/** Occupancy: mass inside 22% of the bounding-sphere radius around the AABB center. */
const CENTER_RADIUS = 0.22;
const CENTER_MASS_MAX = 0.14;

/** Landscapes still need a wider-than-tall footprint so tall interiors stay objects. */
const OCCUPANCY_WIDE = 1.15;

/** Horizontal / vertical ratio that means the AABB *is* the splat slab. */
const SLAB_WIDE = 4;

/** In-scene orbit radius as a fraction of the wider ground axis. */
const LANDSCAPE_DISTANCE = 0.18;

const MAX_SAMPLES = 8192;
const MIN_SAMPLES = 24;
const ALPHA_FLOOR = 24;
const HEIGHT_BINS = 24;

export interface OrbitFramingInput {
  /** Splat centers in the mesh-local frame. Streamed loads omit these. */
  positions?: Float32Array | null;
  /** RGBA bytes; low-alpha floaters are ignored when present. */
  colors?: Uint8Array | null;
  /** Upper-triangle covariance matrices, six floats per splat. */
  covariances?: Float32Array | null;
  /** Local → world. Positions are transformed when this is set. */
  worldMatrix?: THREE.Matrix4 | null;
  /**
   * World-space Y samples when splat centers are not decoded yet. Streamed
   * SOG/LCC leaf centers are enough to find the terrain band so the camera
   * does not sit in AABB-min outlier space underground.
   */
  heightSamples?: ArrayLike<number> | null;
}

export interface OrbitFramingResult {
  framing: OrbitFraming;
  /** Orbit pivot: AABB center for objects, a ground point for landscapes. */
  center: THREE.Vector3;
  /**
   * Suggested cinematic radius. Landscape values are in-scene; object values
   * are a conservative outside estimate the caller typically replaces with
   * the `fitToBox` camera distance.
   */
  distance: number;
  /** AABB height in world units. Object orbits use it for camera/target height. */
  verticalSpan: number;
  /**
   * Landscape whose AABB is a wide-thin splat slab. The in-scene eye-height
   * path would sit inside the gaussians; the caller should raise the camera
   * with the object span fractions above the ground pivot.
   */
  spanHeights: boolean;
  /** Detail-derived subject bounds when a coarse environment surrounds it. */
  focusBounds: THREE.Box3 | null;
}

/**
 * Picks object vs landscape framing from world-space bounds and optional
 * splat centers. Safe to call with only an AABB (streamed scenes before any
 * chunk has decoded).
 */
export function classifyOrbitFraming(
  bounds: THREE.Box3,
  input: OrbitFramingInput = {},
): OrbitFramingResult {
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const sx = size.x;
  const sy = size.y;
  const sz = size.z;
  const verticalSpan = Number.isFinite(sy) ? Math.max(sy, 0) : 0;
  const wide = Math.max(sx, sz);
  const narrow = Math.min(sx, sz);
  const sphereRadius = bounds.getBoundingSphere(new THREE.Sphere()).radius || 0;

  if (!(wide > 0) || !Number.isFinite(wide) || !Number.isFinite(sy)) {
    return {
      framing: 'object',
      center,
      distance: 1e-4,
      verticalSpan: 0,
      spanHeights: false,
      focusBounds: null,
    };
  }

  const focusBounds = detailedSubjectBounds(bounds, input);
  if (focusBounds) {
    const focusCenter = focusBounds.getCenter(new THREE.Vector3());
    const focusSpan = focusBounds.max.y - focusBounds.min.y;
    return {
      framing: 'object',
      center: focusCenter,
      distance: Math.max(focusBounds.getBoundingSphere(new THREE.Sphere()).radius * 1.35, 1e-4),
      verticalSpan: Math.max(focusSpan, 0),
      spanHeights: false,
      focusBounds,
    };
  }

  const occupancy = sampleOccupancy(bounds, center, sphereRadius, input);
  const footprintLandscape =
    wide >= FOOTPRINT_WIDE * Math.max(sy, 1e-8) && narrow >= FOOTPRINT_NARROW * Math.max(sy, 1e-8);
  const occupancyLandscape =
    occupancy !== null &&
    occupancy.bottomMass >= BOTTOM_MASS &&
    occupancy.centerMass <= CENTER_MASS_MAX &&
    wide >= OCCUPANCY_WIDE * Math.max(sy, 1e-8);

  const framing: OrbitFraming = footprintLandscape || occupancyLandscape ? 'landscape' : 'object';
  const groundY =
    occupancy?.groundY ??
    groundYFromHeightSamples(bounds.min.y, verticalSpan, input.heightSamples) ??
    bounds.min.y + Math.min(sy * 0.06, wide * 0.02);
  const spanHeights = framing === 'landscape' && wide >= SLAB_WIDE * Math.max(sy, 1e-8);

  if (framing === 'landscape') {
    return {
      framing,
      center: new THREE.Vector3(center.x, groundY, center.z),
      distance: Math.max(wide * LANDSCAPE_DISTANCE, 1e-4),
      verticalSpan,
      spanHeights,
      focusBounds: null,
    };
  }

  return {
    framing,
    center,
    distance: Math.max(sphereRadius * 1.35, 1e-4),
    verticalSpan,
    spanHeights: false,
    focusBounds: null,
  };
}

/**
 * Finds a compact, finely reconstructed subject inside a coarse capture shell.
 * Scaniverse-style object scans often contain many small Gaussians on the
 * subject and a sparse sphere of Gaussians whose covariance is orders of
 * magnitude larger. The full AABB describes that sphere, not useful content.
 */
function detailedSubjectBounds(bounds: THREE.Box3, input: OrbitFramingInput): THREE.Box3 | null {
  const positions = input.positions;
  const covariances = input.covariances;
  if (!positions || !covariances) return null;
  const count = Math.min(Math.floor(positions.length / 3), Math.floor(covariances.length / 6));
  if (count < MIN_SAMPLES) return null;

  const target = Math.min(MAX_SAMPLES, count);
  const stride = Math.max(1, Math.floor(count / target));
  const samples: { index: number; trace: number }[] = [];
  for (let i = 0; i < count; i += stride) {
    if (input.colors && (input.colors[i * 4 + 3] as number) < ALPHA_FLOOR) continue;
    const trace =
      (covariances[i * 6] as number) +
      (covariances[i * 6 + 3] as number) +
      (covariances[i * 6 + 5] as number);
    if (Number.isFinite(trace) && trace > 0) samples.push({ index: i, trace });
  }
  if (samples.length < MIN_SAMPLES) return null;
  samples.sort((a, b) => a.trace - b.trace);
  const q25 = samples[Math.floor(samples.length * 0.25)]?.trace ?? 0;
  const q90 = samples[Math.floor(samples.length * 0.9)]?.trace ?? 0;
  // A genuine two-scale capture has a decisive covariance gap. Avoid changing
  // ordinary scenes whose foreground and background merely vary naturally.
  if (!(q25 > 0) || q90 / q25 < 16) return null;

  const detailLimit = samples[Math.floor(samples.length * 0.4)]?.trace ?? q25;
  const local = new THREE.Box3();
  let detailed = 0;
  for (const sample of samples) {
    if (sample.trace > detailLimit) break;
    const i = sample.index;
    const point = new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z))
      continue;
    local.expandByPoint(point);
    detailed++;
  }
  if (detailed < MIN_SAMPLES || local.isEmpty()) return null;

  const world = input.worldMatrix ? local.applyMatrix4(input.worldMatrix) : local;
  const fullDiagonal = bounds.getSize(new THREE.Vector3()).length();
  const focusDiagonal = world.getSize(new THREE.Vector3()).length();
  if (!(fullDiagonal > 0) || focusDiagonal >= fullDiagonal * 0.55) return null;

  // Give the cinematic path breathing room around the fine-center envelope.
  world.expandByScalar(Math.max(focusDiagonal * 0.04, 1e-6));
  return world;
}

interface OccupancyStats {
  bottomMass: number;
  centerMass: number;
  groundY: number;
}

function sampleOccupancy(
  bounds: THREE.Box3,
  center: THREE.Vector3,
  sphereRadius: number,
  input: OrbitFramingInput,
): OccupancyStats | null {
  const positions = input.positions;
  if (!positions || positions.length < MIN_SAMPLES * 3) return null;

  const count = Math.floor(positions.length / 3);
  const target = Math.min(MAX_SAMPLES, count);
  const stride = Math.max(1, Math.floor(count / target));
  const colors = input.colors;
  const matrix = input.worldMatrix?.elements;
  const minY = bounds.min.y;
  const sy = bounds.max.y - bounds.min.y;
  const bottomMax = minY + sy * BOTTOM_BAND;
  const centerR2 = (sphereRadius * CENTER_RADIUS) ** 2;
  const bins = new Uint32Array(HEIGHT_BINS);

  let sampled = 0;
  let bottomCount = 0;
  let centerCount = 0;

  for (let i = 0; i < count; i += stride) {
    if (colors && (colors[i * 4 + 3] as number) < ALPHA_FLOOR) continue;
    const lx = positions[i * 3] as number;
    const ly = positions[i * 3 + 1] as number;
    const lz = positions[i * 3 + 2] as number;
    if (!Number.isFinite(lx) || !Number.isFinite(ly) || !Number.isFinite(lz)) continue;

    let x = lx;
    let y = ly;
    let z = lz;
    if (matrix) {
      x = matrix[0] * lx + matrix[4] * ly + matrix[8] * lz + matrix[12];
      y = matrix[1] * lx + matrix[5] * ly + matrix[9] * lz + matrix[13];
      z = matrix[2] * lx + matrix[6] * ly + matrix[10] * lz + matrix[14];
    }

    sampled++;
    if (y <= bottomMax) bottomCount++;
    const dx = x - center.x;
    const dy = y - center.y;
    const dz = z - center.z;
    if (dx * dx + dy * dy + dz * dz <= centerR2) centerCount++;
    if (sy > 0) {
      const t = (y - minY) / sy;
      const bin = Math.min(HEIGHT_BINS - 1, Math.max(0, Math.floor(t * HEIGHT_BINS)));
      bins[bin] = (bins[bin] as number) + 1;
    }
  }

  if (sampled < MIN_SAMPLES) return null;

  return {
    bottomMass: bottomCount / sampled,
    centerMass: centerCount / sampled,
    groundY: groundYFromHeightBins(minY, sy, bins, sampled) ?? minY + sy * 0.05,
  };
}

/**
 * World-space Y samples from a streamed mesh, before later chunks decode.
 *
 * Prefers LOD leaf centers (Streamed SOG / classic LCC). Falls back to a
 * `.rad` chunk-0 overview subsample, which is copied onto the scene because
 * page-table mode transfers those buffers to a worker.
 */
export function heightSamplesFromStreamedMesh(
  mesh: object,
  worldMatrix?: THREE.Matrix4 | null,
): Float32Array | null {
  const scene = (
    mesh as {
      scene?: {
        source?: { leaves?: readonly { bounds: THREE.Box3 }[] };
        overviewPositions?: Float32Array;
      };
    }
  ).scene;
  const fromLeaves = heightSamplesFromLeaves(scene?.source?.leaves, worldMatrix);
  if (fromLeaves) return fromLeaves;
  return heightSamplesFromOverview(scene?.overviewPositions, worldMatrix);
}

/** Source-local xyz overview from a `.rad`, when present. */
export function overviewPositionsFromStreamedMesh(mesh: object): Float32Array | null {
  const positions = (mesh as { scene?: { overviewPositions?: Float32Array } }).scene
    ?.overviewPositions;
  return positions && positions.length >= MIN_SAMPLES * 3 ? positions : null;
}

function heightSamplesFromLeaves(
  leaves: readonly { bounds: THREE.Box3 }[] | undefined,
  worldMatrix?: THREE.Matrix4 | null,
): Float32Array | null {
  if (!leaves || leaves.length < MIN_SAMPLES) return null;

  const matrix = worldMatrix?.elements;
  const out = new Float32Array(leaves.length);
  let n = 0;
  for (const leaf of leaves) {
    const box = leaf.bounds;
    const lx = (box.min.x + box.max.x) * 0.5;
    const ly = (box.min.y + box.max.y) * 0.5;
    const lz = (box.min.z + box.max.z) * 0.5;
    if (!Number.isFinite(lx) || !Number.isFinite(ly) || !Number.isFinite(lz)) continue;
    let y = ly;
    if (matrix) {
      y = matrix[1] * lx + matrix[5] * ly + matrix[9] * lz + matrix[13];
    }
    if (!Number.isFinite(y)) continue;
    out[n++] = y;
  }
  return n >= MIN_SAMPLES ? (n === out.length ? out : out.subarray(0, n)) : null;
}

function heightSamplesFromOverview(
  positions: Float32Array | undefined,
  worldMatrix?: THREE.Matrix4 | null,
): Float32Array | null {
  if (!positions || positions.length < MIN_SAMPLES * 3) return null;
  const matrix = worldMatrix?.elements;
  const count = Math.floor(positions.length / 3);
  const out = new Float32Array(count);
  let n = 0;
  for (let i = 0; i < count; i++) {
    const lx = positions[i * 3] as number;
    const ly = positions[i * 3 + 1] as number;
    const lz = positions[i * 3 + 2] as number;
    if (!Number.isFinite(lx) || !Number.isFinite(ly) || !Number.isFinite(lz)) continue;
    const y = matrix ? matrix[1] * lx + matrix[5] * ly + matrix[9] * lz + matrix[13] : ly;
    if (!Number.isFinite(y)) continue;
    out[n++] = y;
  }
  return n >= MIN_SAMPLES ? (n === out.length ? out : out.subarray(0, n)) : null;
}

function groundYFromHeightSamples(
  minY: number,
  sy: number,
  samples: ArrayLike<number> | null | undefined,
): number | null {
  if (!samples || samples.length < MIN_SAMPLES || !(sy > 0)) return null;
  const count = samples.length;
  const target = Math.min(MAX_SAMPLES, count);
  const stride = Math.max(1, Math.floor(count / target));
  const bins = new Uint32Array(HEIGHT_BINS);
  let sampled = 0;
  for (let i = 0; i < count; i += stride) {
    const y = samples[i] as number;
    if (!Number.isFinite(y)) continue;
    sampled++;
    const t = (y - minY) / sy;
    const bin = Math.min(HEIGHT_BINS - 1, Math.max(0, Math.floor(t * HEIGHT_BINS)));
    bins[bin] = (bins[bin] as number) + 1;
  }
  if (sampled < MIN_SAMPLES) return null;
  return groundYFromHeightBins(minY, sy, bins, sampled);
}

/**
 * 15th percentile of occupied height. That sits on the terrain for a ground
 * capture (underground floaters are a thin tail; trees and sky sit above)
 * without using the AABB min, which is often metres below the ground plane.
 */
function groundYFromHeightBins(
  minY: number,
  sy: number,
  bins: Uint32Array,
  sampled: number,
): number | null {
  if (!(sy > 0) || sampled < MIN_SAMPLES) return null;
  const target = sampled * 0.15;
  let acc = 0;
  for (let b = 0; b < HEIGHT_BINS; b++) {
    acc += bins[b] as number;
    if (acc >= target) return minY + ((b + 0.5) / HEIGHT_BINS) * sy;
  }
  return null;
}
