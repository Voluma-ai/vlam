import * as THREE from 'three/webgpu';

/** Object captures orbit from outside; landscapes sit inside at eye height. */
export type OrbitFraming = 'object' | 'landscape';

export interface OrbitalCameraPathOptions {
  framing?: OrbitFraming;
  /**
   * World-space AABB height. Objects use it to place the camera and look-at
   * relative to the splat; landscapes use it to clamp eye height under a sky
   * dome. Flat landscape slabs (`spanHeights`) reuse the object fractions
   * above the ground pivot so the camera is not buried in the gaussians.
   */
  verticalSpan?: number;
  /**
   * Landscape AABB is a wide-thin splat slab. Eye-height plus the 24% span
   * ceiling sits inside the surface; use the object span fractions instead.
   */
  spanHeights?: boolean;
}

/** One complete cinematic camera orbit, in seconds of full-speed motion. */
export const CINEMATIC_ORBIT_DURATION = 30;

/** Idle time before automatic camera motion resumes. */
export const CINEMATIC_ORBIT_IDLE_DELAY = 5;

/** Time spent easing from the user's camera pose back onto the path. */
export const CINEMATIC_ORBIT_RAMP_DURATION = 3;

/**
 * Object-orbit heights as fractions of AABB height, measured above the box
 * center. A splat from y = -9 to 9 (span 18) starts the camera at 8, aims at
 * 3, climbs to 12, and never drops the eye below 2.
 */
const OBJECT_CAMERA_START_SPAN = 8 / 18;
const OBJECT_TARGET_SPAN = 3 / 18;
const OBJECT_CAMERA_FLOOR_SPAN = 2 / 18;
const OBJECT_CAMERA_CEILING_SPAN = 12 / 18;

/** Radial zoom swing around the path's base distance. */
const OBJECT_RADIAL_SWING = 0.3;
const LANDSCAPE_RADIAL_SWING = 0.2;

const HEIGHT_WAVE_PHASE = Math.PI * 0.2;

/** Smoothly ramps from stopped to full speed after the interaction idle delay. */
export function cinematicOrbitBlend(idleSeconds: number): number {
  const progress = THREE.MathUtils.clamp(
    (idleSeconds - CINEMATIC_ORBIT_IDLE_DELAY) / CINEMATIC_ORBIT_RAMP_DURATION,
    0,
    1,
  );
  return progress * progress * progress * (progress * (progress * 6 - 15) + 10);
}

function wrapPhase(phase: number): number {
  return ((phase % 1) + 1) % 1;
}

function radialScale(loop: number, landscape: boolean): number {
  const swing = landscape ? LANDSCAPE_RADIAL_SWING : OBJECT_RADIAL_SWING;
  return 1 + swing * Math.sin(loop * Math.PI * 2 - Math.PI * 0.3);
}

function heightWave(loop: number): number {
  return Math.sin(loop * Math.PI * 4 + HEIGHT_WAVE_PHASE);
}

function usesSpanHeights(options?: OrbitalCameraPathOptions): boolean {
  const verticalSpan = options?.verticalSpan ?? 0;
  if (!(verticalSpan > 0)) return false;
  return options?.framing !== 'landscape' || options.spanHeights === true;
}

/**
 * Maps the height sine so phase 0 stays at `mid`, the trough hits `lo`, and
 * the peak hits `hi`. Down and up amplitudes are independent, which is how
 * the path climbs higher without dropping the floor.
 */
function remapWave(wave: number, wave0: number, lo: number, mid: number, hi: number): number {
  if (wave >= wave0) {
    const span = 1 - wave0;
    const t = span > 0 ? (wave - wave0) / span : 0;
    return mid + (hi - mid) * t;
  }
  const span = wave0 + 1;
  const t = span > 0 ? (wave0 - wave) / span : 0;
  return mid - (mid - lo) * t;
}

/**
 * Camera and look-at heights above the orbit center for a compact object,
 * keyed off AABB height rather than orbit radius.
 */
function objectSpanHeights(
  loop: number,
  verticalSpan: number,
): { height: number; targetHeight: number } {
  const startHeight = verticalSpan * OBJECT_CAMERA_START_SPAN;
  const targetHeight = verticalSpan * OBJECT_TARGET_SPAN;
  const floorHeight = verticalSpan * OBJECT_CAMERA_FLOOR_SPAN;
  const ceilingHeight = verticalSpan * OBJECT_CAMERA_CEILING_SPAN;
  return {
    height: remapWave(heightWave(loop), heightWave(0), floorHeight, startHeight, ceilingHeight),
    targetHeight,
  };
}

/**
 * Converts a camera-controls orbit distance into the path's base-distance
 * parameter at a given phase. The path varies its height and radius, so using
 * the controls distance directly would subtly change the zoom level.
 */
export function baseDistanceForOrbitalCameraPath(
  phase: number,
  orbitDistance: number,
  options?: OrbitalCameraPathOptions,
): number {
  const loop = wrapPhase(phase);
  const landscape = options?.framing === 'landscape';
  const scale = radialScale(loop, landscape);
  const verticalSpan = options?.verticalSpan ?? 0;

  if (usesSpanHeights(options)) {
    const { height, targetHeight } = objectSpanHeights(loop, verticalSpan);
    const dy = height - targetHeight;
    const horizontal = Math.sqrt(Math.max(orbitDistance * orbitDistance - dy * dy, 0));
    return Math.max(horizontal, 1e-4) / scale;
  }

  const wave = heightWave(loop);
  const positionHeightScale = landscape ? 0.14 + 0.12 * wave : 0.18 + 0.24 * wave;
  const targetHeightScale = landscape
    ? positionHeightScale * 0.22
    : 0.035 * Math.sin(loop * Math.PI * 2 + Math.PI * 0.5);
  const pathDistanceScale = Math.hypot(scale, positionHeightScale - targetHeightScale);
  return orbitDistance / Math.max(pathDistanceScale, 1e-8);
}

/**
 * Evaluates the demo's looping camera path without allocating temporary vectors.
 * The angular warp stays monotonic but creates alternating slow and fast arcs,
 * while independent distance and height curves keep the move from feeling
 * like a mechanical turntable.
 *
 * Object framing places the camera and look-at from the capture's vertical
 * span when that is known. Landscape framing keeps the same yaw rhythm but a
 * much lower eye height, clamped so a sky dome stays above the camera. A
 * flat splat slab (`spanHeights`) is the exception: it uses the object
 * fractions above the ground pivot so the camera starts above the surface.
 */
export function evaluateOrbitalCameraPath(
  phase: number,
  center: THREE.Vector3,
  baseDistance: number,
  position: THREE.Vector3,
  target: THREE.Vector3,
  options?: OrbitalCameraPathOptions,
): void {
  const loop = wrapPhase(phase);
  const landscape = options?.framing === 'landscape';
  const distance = baseDistance * radialScale(loop, landscape);
  const verticalSpan = options?.verticalSpan ?? 0;
  const wave = heightWave(loop);

  let height: number;
  let targetHeight: number;
  if (usesSpanHeights(options)) {
    ({ height, targetHeight } = objectSpanHeights(loop, verticalSpan));
  } else if (landscape) {
    height = baseDistance * (0.14 + 0.12 * wave);
    if (verticalSpan > 0) {
      const ceiling = verticalSpan * 0.24;
      const floor = Math.min(verticalSpan * 0.025, ceiling * 0.5);
      height = THREE.MathUtils.clamp(height, floor, ceiling);
    }
    targetHeight = height * 0.22;
  } else {
    height = baseDistance * (0.18 + 0.24 * wave);
    targetHeight = baseDistance * 0.035 * Math.sin(loop * Math.PI * 2 + Math.PI * 0.5);
  }

  const angle = loop * Math.PI * 2 - Math.sin(loop * Math.PI * 4) * 0.35;
  position.set(
    center.x + Math.sin(angle) * distance,
    center.y + height,
    center.z + Math.cos(angle) * distance,
  );
  target.set(center.x, center.y + targetHeight, center.z);
}
