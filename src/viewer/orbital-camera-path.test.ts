import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  baseDistanceForOrbitalCameraPath,
  CINEMATIC_ORBIT_IDLE_DELAY,
  CINEMATIC_ORBIT_RAMP_DURATION,
  cinematicOrbitBlend,
  evaluateOrbitalCameraPath,
} from './orbital-camera-path';

describe('evaluateOrbitalCameraPath', () => {
  it('loops seamlessly after one revolution', () => {
    const center = new THREE.Vector3(2, 3, 4);
    const startPosition = new THREE.Vector3();
    const startTarget = new THREE.Vector3();
    const endPosition = new THREE.Vector3();
    const endTarget = new THREE.Vector3();

    evaluateOrbitalCameraPath(0, center, 10, startPosition, startTarget);
    evaluateOrbitalCameraPath(1, center, 10, endPosition, endTarget);

    expect(endPosition.distanceTo(startPosition)).toBeLessThan(1e-10);
    expect(endTarget.distanceTo(startTarget)).toBeLessThan(1e-10);
  });

  it('varies both camera height and distance', () => {
    const center = new THREE.Vector3();
    const position = new THREE.Vector3();
    const target = new THREE.Vector3();
    const samples = [0, 0.125, 0.25, 0.375].map((phase) => {
      evaluateOrbitalCameraPath(phase, center, 10, position, target);
      return { height: position.y, distance: position.distanceTo(center) };
    });

    expect(new Set(samples.map(({ height }) => height.toFixed(4))).size).toBeGreaterThan(1);
    expect(new Set(samples.map(({ distance }) => distance.toFixed(4))).size).toBeGreaterThan(1);
  });

  it('zooms in and out by about thirty percent around the base distance', () => {
    const center = new THREE.Vector3();
    const position = new THREE.Vector3();
    const target = new THREE.Vector3();
    const radii: number[] = [];
    for (let i = 0; i <= 40; i++) {
      evaluateOrbitalCameraPath(i / 40, center, 10, position, target);
      radii.push(Math.hypot(position.x, position.z));
    }
    const min = Math.min(...radii);
    const max = Math.max(...radii);
    expect(min).toBeCloseTo(7, 1);
    expect(max).toBeCloseTo(13, 1);
    expect(max / min).toBeGreaterThan(1.7);
  });

  it('matches a manually changed orbit distance at every path phase', () => {
    const center = new THREE.Vector3(2, 3, 4);
    const position = new THREE.Vector3();
    const target = new THREE.Vector3();

    for (const phase of [0, 0.125, 0.4, 0.75, 1.2]) {
      const baseDistance = baseDistanceForOrbitalCameraPath(phase, 7.5);
      evaluateOrbitalCameraPath(phase, center, baseDistance, position, target);
      expect(position.distanceTo(target)).toBeCloseTo(7.5, 10);
    }
  });

  it('places object cameras from splat height, not orbit radius', () => {
    const center = new THREE.Vector3(1, 0, -2);
    const position = new THREE.Vector3();
    const target = new THREE.Vector3();
    const options = { framing: 'object' as const, verticalSpan: 18 };

    evaluateOrbitalCameraPath(0, center, 40, position, target, options);
    expect(position.y).toBeCloseTo(8, 10);
    expect(target.y).toBeCloseTo(3, 10);

    const heights = [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85].map((phase) => {
      evaluateOrbitalCameraPath(phase, center, 40, position, target, options);
      expect(position.y).toBeGreaterThanOrEqual(2 - 1e-10);
      expect(target.y).toBeCloseTo(3, 10);
      return position.y;
    });
    expect(new Set(heights.map((y) => y.toFixed(4))).size).toBeGreaterThan(1);
  });

  it('climbs above the start height without dropping the floor', () => {
    const center = new THREE.Vector3(1, 0, -2);
    const position = new THREE.Vector3();
    const target = new THREE.Vector3();
    const options = { framing: 'object' as const, verticalSpan: 18 };

    const heights: number[] = [];
    for (let i = 0; i <= 40; i++) {
      evaluateOrbitalCameraPath(i / 40, center, 40, position, target, options);
      expect(position.y).toBeGreaterThanOrEqual(2 - 1e-10);
      heights.push(position.y);
    }
    expect(Math.max(...heights)).toBeCloseTo(12, 5);
    expect(Math.min(...heights)).toBeCloseTo(2, 5);
  });

  it('scales those object heights with the splat', () => {
    const center = new THREE.Vector3(0, 4, 0);
    const position = new THREE.Vector3();
    const target = new THREE.Vector3();
    const options = { framing: 'object' as const, verticalSpan: 36 };

    evaluateOrbitalCameraPath(0, center, 80, position, target, options);
    expect(position.y).toBeCloseTo(4 + 16, 10);
    expect(target.y).toBeCloseTo(4 + 6, 10);

    for (const phase of [0, 0.2, 0.5, 0.8]) {
      evaluateOrbitalCameraPath(phase, center, 80, position, target, options);
      expect(position.y).toBeGreaterThanOrEqual(4 + 4 - 1e-10);
    }
  });

  it('matches a changed orbit distance when object height comes from the splat', () => {
    const center = new THREE.Vector3(2, 3, 4);
    const position = new THREE.Vector3();
    const target = new THREE.Vector3();
    const options = { framing: 'object' as const, verticalSpan: 18 };

    for (const phase of [0, 0.125, 0.4, 0.75, 1.2]) {
      const baseDistance = baseDistanceForOrbitalCameraPath(phase, 15, options);
      evaluateOrbitalCameraPath(phase, center, baseDistance, position, target, options);
      expect(position.distanceTo(target)).toBeCloseTo(15, 10);
    }
  });

  it('keeps a landscape camera above a raised ground plane', () => {
    const center = new THREE.Vector3(0, 14, 0);
    const position = new THREE.Vector3();
    const target = new THREE.Vector3();
    const options = { framing: 'landscape' as const, verticalSpan: 119 };

    for (const phase of [0, 0.2, 0.5, 0.8]) {
      evaluateOrbitalCameraPath(phase, center, 58, position, target, options);
      expect(position.y).toBeGreaterThan(center.y);
      expect(target.y).toBeGreaterThan(center.y - 1e-6);
      expect(target.y).toBeLessThan(position.y);
    }
  });

  it('raises a flat landscape camera above the splat slab', () => {
    // Andre-shaped: ground pivot at y ≈ -11.5, AABB height ≈ 29.25.
    const center = new THREE.Vector3(-21, -11.46, 48);
    const position = new THREE.Vector3();
    const target = new THREE.Vector3();
    const options = {
      framing: 'landscape' as const,
      verticalSpan: 29.25,
      spanHeights: true,
    };

    evaluateOrbitalCameraPath(0, center, 36, position, target, options);
    expect(position.y).toBeCloseTo(center.y + 29.25 * (8 / 18), 5);
    expect(target.y).toBeCloseTo(center.y + 29.25 * (3 / 18), 5);

    for (const phase of [0, 0.2, 0.5, 0.8]) {
      evaluateOrbitalCameraPath(phase, center, 36, position, target, options);
      expect(position.y).toBeGreaterThanOrEqual(center.y + 29.25 * (2 / 18) - 1e-10);
    }
  });

  it('matches a changed orbit distance when a flat landscape uses span heights', () => {
    const center = new THREE.Vector3(-21, -11.46, 48);
    const position = new THREE.Vector3();
    const target = new THREE.Vector3();
    const options = {
      framing: 'landscape' as const,
      verticalSpan: 29.25,
      spanHeights: true,
    };

    for (const phase of [0, 0.125, 0.4, 0.75]) {
      const baseDistance = baseDistanceForOrbitalCameraPath(phase, 22, options);
      evaluateOrbitalCameraPath(phase, center, baseDistance, position, target, options);
      expect(position.distanceTo(target)).toBeCloseTo(22, 10);
    }
  });
});

describe('cinematicOrbitBlend', () => {
  it('waits five seconds before smoothly reaching full speed', () => {
    expect(cinematicOrbitBlend(CINEMATIC_ORBIT_IDLE_DELAY)).toBe(0);
    expect(
      cinematicOrbitBlend(CINEMATIC_ORBIT_IDLE_DELAY + CINEMATIC_ORBIT_RAMP_DURATION / 2),
    ).toBe(0.5);
    expect(cinematicOrbitBlend(CINEMATIC_ORBIT_IDLE_DELAY + CINEMATIC_ORBIT_RAMP_DURATION)).toBe(1);
  });
});
