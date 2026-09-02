import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { cameraVisibleSortRange, intersectSortRange } from '../core/splat-sort-bounds';

describe('cameraVisibleSortRange', () => {
  it('uses the far plane through the camera plane for depth keys', () => {
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 250);
    expect(cameraVisibleSortRange(camera, 'depth')).toEqual({ min: -250, max: 0 });
  });

  it('covers padded far-frustum corners for radial keys', () => {
    const camera = new THREE.PerspectiveCamera(90, 2, 0.1, 100);
    const range = cameraVisibleSortRange(camera, 'radial');
    expect(range).not.toBeNull();
    // The unpadded horizontal far corner is already farther than `far`; the
    // display path's 1.2 NDC margin makes this conservative bound larger still.
    expect(-(range?.min as number)).toBeGreaterThan(100 * Math.sqrt(5));
    expect(range?.max).toBe(0);
  });

  it('falls back to scene bounds when far is infinite or invalid', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.far = Infinity;
    expect(cameraVisibleSortRange(camera, 'depth')).toBeNull();
    camera.far = 0;
    expect(cameraVisibleSortRange(camera, 'radial')).toBeNull();
  });
});

describe('intersectSortRange', () => {
  it('retains the scene range when no visible interval overlaps it', () => {
    const scene = { min: -1_000_000, max: -500_000 };
    expect(intersectSortRange(scene, { min: -100, max: 0 })).toBe(scene);
  });
});
