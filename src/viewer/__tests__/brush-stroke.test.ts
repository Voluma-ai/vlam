import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  buildDepthPickedBrushStroke,
  decimatePointerSamples,
  worldSizePerPixel,
} from '../brush-stroke';

describe('brush stroke construction', () => {
  it('decimates intermediate points but retains both endpoints', () => {
    const points = [0, 1, 2, 9].map((x) => new THREE.Vector2(x, 0));
    expect(decimatePointerSamples(points, 4).map(({ x }) => x)).toEqual([0, 9]);
  });

  it('converts a perspective pixel radius at the picked depth', () => {
    const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
    camera.updateProjectionMatrix();
    expect(worldSizePerPixel(camera, 10, 100)).toBeCloseTo(0.2);
  });

  it('keeps orthographic pixel size independent of depth', () => {
    const camera = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 100);
    camera.updateProjectionMatrix();
    expect(worldSizePerPixel(camera, 1, 100)).toBeCloseTo(0.02);
    expect(worldSizePerPixel(camera, 50, 100)).toBeCloseTo(0.02);
  });

  it('splits paths at misses and depth discontinuities', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const point = (z: number) => ({ point: new THREE.Vector3(0, 0, z), distance: -z });
    const stroke = buildDepthPickedBrushStroke(
      [point(-2), point(-2.01), null, point(-8), point(-20)],
      camera,
      100,
      10,
    );
    expect(stroke.paths.map((path) => path.length)).toEqual([2, 1, 1]);
  });
});
