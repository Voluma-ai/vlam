import * as THREE from 'three/webgpu';
import type { SplatData } from '../core/splat-data';

/**
 * Robust local bounds of a frame: per axis, the 1st to the 99th percentile
 * of the splat centers, so stray floaters do not set the floor. For
 * placing a clip (feet on the ground, centered over a point).
 *
 * @experimental
 */
export function splatFrameBounds(data: SplatData): THREE.Box3 {
  const box = new THREE.Box3();
  if (data.count === 0) return box;
  const values = new Float32Array(data.count);
  for (let axis = 0; axis < 3; axis++) {
    for (let i = 0; i < data.count; i++) values[i] = data.positions[i * 3 + axis]!;
    values.sort();
    const low = values[Math.floor(data.count * 0.01)]!;
    const high = values[Math.min(data.count - 1, Math.floor(data.count * 0.99))]!;
    box.min.setComponent(axis, low);
    box.max.setComponent(axis, high);
  }
  return box;
}
