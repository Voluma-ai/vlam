import * as THREE from 'three/webgpu';
import type { SplatPickResult } from '../lib/core';
import type { BrushStroke, BrushStrokeSample } from '../lib/selection';

/** Keeps the first/last pointer positions and removes samples closer than `spacingPx`. */
export function decimatePointerSamples(
  samples: readonly THREE.Vector2[],
  spacingPx: number,
): THREE.Vector2[] {
  if (samples.length <= 1) return samples.map((sample) => sample.clone());
  const spacing2 = Math.max(0, spacingPx) ** 2;
  const result = [(samples[0] as THREE.Vector2).clone()];
  for (let i = 1; i < samples.length - 1; i++) {
    const sample = samples[i] as THREE.Vector2;
    if (sample.distanceToSquared(result[result.length - 1] as THREE.Vector2) >= spacing2) {
      result.push(sample.clone());
    }
  }
  const last = samples[samples.length - 1] as THREE.Vector2;
  if (!last.equals(result[result.length - 1] as THREE.Vector2)) result.push(last.clone());
  return result;
}

/** World-space height represented by one framebuffer pixel at positive view depth. */
export function worldSizePerPixel(camera: THREE.Camera, viewDepth: number, height: number): number {
  const projectionY = Math.abs(camera.projectionMatrix.elements[5]);
  if (!(projectionY > 0) || !(height > 0)) return 0;
  return (2 * (camera instanceof THREE.PerspectiveCamera ? viewDepth : 1)) / (projectionY * height);
}

/**
 * Converts ordered batched-pick results into a world-space stroke. Misses and
 * jumps larger than the local brush diameter start a new path, so a foreground
 * edge never grows an accidental capsule bridge to the background.
 */
export function buildDepthPickedBrushStroke(
  hits: readonly (SplatPickResult | null)[],
  camera: THREE.Camera,
  viewportHeight: number,
  radiusPx: number,
  depthJumpFactor = 2,
): BrushStroke {
  camera.updateMatrixWorld(true);
  const viewMatrix = camera.matrixWorldInverse.clone();
  const paths: BrushStrokeSample[][] = [];
  let path: BrushStrokeSample[] = [];

  for (const hit of hits) {
    if (!hit) {
      if (path.length > 0) paths.push(path);
      path = [];
      continue;
    }
    const viewPoint = hit.point.clone().applyMatrix4(viewMatrix);
    const viewDepth = -viewPoint.z;
    if (!(viewDepth > 0)) continue;
    const sample: BrushStrokeSample = {
      point: hit.point.clone(),
      radius: Math.max(0, radiusPx) * worldSizePerPixel(camera, viewDepth, viewportHeight),
      viewDepth,
    };
    const previous = path[path.length - 1];
    if (previous) {
      const scale = Math.max(previous.radius, sample.radius, Number.EPSILON);
      const depthJump =
        Math.abs((previous.viewDepth as number) - viewDepth) > scale * depthJumpFactor;
      const spatialJump = previous.point.distanceTo(sample.point) > scale * depthJumpFactor;
      if (depthJump || spatialJump) {
        paths.push(path);
        path = [];
      }
    }
    path.push(sample);
  }
  if (path.length > 0) paths.push(path);
  return { paths, viewMatrix };
}
