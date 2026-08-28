import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  denormalizeViewDepth,
  normalizeViewDepth,
  packNormalizedDepth,
  unpackNormalizedDepth,
  unprojectViewDepth,
} from '../core/splat-depth-pack';

describe('packNormalizedDepth / unpackNormalizedDepth', () => {
  it('round-trips near, middle, and far normalized depths', () => {
    for (const t of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
      const { r, g, b } = packNormalizedDepth(t);
      const recovered = unpackNormalizedDepth(r, g, b);
      // 24-bit quantization over [0, 1] → error ≤ 0.5 / (2²⁴−1).
      expect(Math.abs(recovered - t)).toBeLessThan(1 / (1 << 24));
    }
  });

  it('clamps out-of-range inputs', () => {
    expect(packNormalizedDepth(-1)).toEqual(packNormalizedDepth(0));
    expect(packNormalizedDepth(2)).toEqual(packNormalizedDepth(1));
  });
});

describe('normalizeViewDepth / denormalizeViewDepth', () => {
  it('maps near/mid/far view depths through the camera range', () => {
    const near = 0.1;
    const far = 100;
    expect(normalizeViewDepth(near, near, far)).toBeCloseTo(0, 10);
    expect(normalizeViewDepth(far, near, far)).toBeCloseTo(1, 10);
    expect(normalizeViewDepth((near + far) / 2, near, far)).toBeCloseTo(0.5, 10);

    const mid = denormalizeViewDepth(0.5, near, far);
    expect(mid).toBeCloseTo((near + far) / 2, 10);
  });

  it('survives pack/unpack at near, middle, and far distances', () => {
    const near = 0.01;
    const far = 500;
    for (const viewDepth of [near, 1, 10, 50, 250, far]) {
      const normalized = normalizeViewDepth(viewDepth, near, far);
      const { r, g, b } = packNormalizedDepth(normalized);
      const recovered = denormalizeViewDepth(unpackNormalizedDepth(r, g, b), near, far);
      // Absolute error scales with (far − near) / 2²⁴.
      const maxError = ((far - near) / ((1 << 24) - 1)) * 0.6;
      expect(Math.abs(recovered - viewDepth)).toBeLessThan(maxError);
    }
  });
});

describe('unprojectViewDepth', () => {
  it('reconstructs a point on the camera forward axis', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);

    const viewDepth = 5;
    const out = new THREE.Vector3();
    const { point, distance } = unprojectViewDepth(0, 0, viewDepth, camera, out);

    expect(point.x).toBeCloseTo(0, 5);
    expect(point.y).toBeCloseTo(0, 5);
    expect(point.z).toBeCloseTo(0, 5);
    expect(distance).toBeCloseTo(5, 5);
  });

  it('measures distance from the world-space camera origin when parented', () => {
    const rig = new THREE.Group();
    rig.position.set(10, 2, 0);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(1, 0, 5);
    rig.add(camera);
    rig.updateMatrixWorld(true);

    const out = new THREE.Vector3();
    const { point, distance } = unprojectViewDepth(0, 0, 5, camera, out);

    expect(point.toArray()).toEqual([11, 2, 0]);
    expect(distance).toBeCloseTo(5, 5);
  });
});
