import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  countInData,
  createSelectionVolume,
  selectInData,
  type SelectionVolume,
} from '../selection-volume';
import type { SplatData } from '../splat-data';

/**
 * Containment tests for the built-in selection volumes: analytic points for the
 * shapes themselves, plus a seeded property test against an independent
 * `applyMatrix4` reference for the placement math (the unrolled matrix indices
 * in `createSelectionVolume` are exactly where a transposition hides).
 */

/** A deterministic LCG so runs are reproducible without Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function dataFromPoints(points: readonly (readonly [number, number, number])[]): SplatData {
  const positions = new Float32Array(points.length * 3);
  points.forEach(([x, y, z], i) => {
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
  });
  return {
    count: points.length,
    positions,
    colors: new Uint8Array(points.length * 4),
    covariances: new Float32Array(points.length * 6),
  };
}

describe('createSelectionVolume', () => {
  it('tests an axis-aligned box', () => {
    const box = createSelectionVolume({ kind: 'box', halfExtents: [1, 2, 3] });
    expect(box.containsPoint(0, 0, 0)).toBe(true);
    expect(box.containsPoint(1, 2, 3)).toBe(true); // faces are inclusive
    expect(box.containsPoint(1.01, 0, 0)).toBe(false);
    expect(box.containsPoint(0, -2.01, 0)).toBe(false);
    expect(box.containsPoint(0, 0, 3.01)).toBe(false);
  });

  it('tests a sphere', () => {
    const sphere = createSelectionVolume({ kind: 'sphere', radius: 2 });
    expect(sphere.containsPoint(0, 0, 0)).toBe(true);
    expect(sphere.containsPoint(2, 0, 0)).toBe(true);
    expect(sphere.containsPoint(1.2, 1.2, 1.2)).toBe(false); // |p| ≈ 2.08
    expect(sphere.containsPoint(1.1, 1.1, 1.1)).toBe(true); // |p| ≈ 1.91
  });

  it('tests a y-axis cylinder', () => {
    const cyl = createSelectionVolume({ kind: 'cylinder', radius: 1, height: 4 });
    expect(cyl.containsPoint(0, 2, 0)).toBe(true); // on the cap
    expect(cyl.containsPoint(0, 2.01, 0)).toBe(false); // past the cap
    expect(cyl.containsPoint(0.7, -1.9, 0.7)).toBe(true); // r ≈ 0.99
    expect(cyl.containsPoint(0.8, 0, 0.8)).toBe(false); // r ≈ 1.13
  });

  it('honors a placed (rotated + translated) volume', () => {
    // Box rotated 90° about Z and moved to (10, 0, 0): its local X half-extent
    // (3) now spans world Y.
    const transform = new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(10, 0, 0);
    const box = createSelectionVolume({ kind: 'box', halfExtents: [3, 1, 1], transform });
    expect(box.containsPoint(10, 2.9, 0)).toBe(true);
    expect(box.containsPoint(10, -2.9, 0)).toBe(true);
    expect(box.containsPoint(12.9, 0, 0)).toBe(false); // world X is now the short axis
    expect(box.containsPoint(10.9, 0, 0)).toBe(true);
  });

  it('supports non-uniform volume scale', () => {
    // A unit sphere scaled to an ellipsoid (4, 1, 1).
    const transform = new THREE.Matrix4().makeScale(4, 1, 1);
    const ellipsoid = createSelectionVolume({ kind: 'sphere', radius: 1, transform });
    expect(ellipsoid.containsPoint(3.9, 0, 0)).toBe(true);
    expect(ellipsoid.containsPoint(0, 1.1, 0)).toBe(false);
  });

  it('applies the splats world matrix', () => {
    // Splats live under a mesh moved +5 X; a sphere placed at world (5, 0, 0)
    // must catch the splat whose local position is the origin.
    const world = new THREE.Matrix4().setPosition(5, 0, 0);
    const sphere = createSelectionVolume(
      { kind: 'sphere', radius: 1, transform: new THREE.Matrix4().setPosition(5, 0, 0) },
      world,
    );
    expect(sphere.containsPoint(0, 0, 0)).toBe(true);
    expect(sphere.containsPoint(2, 0, 0)).toBe(false);
  });

  it('rejects missing or non-positive dimensions and singular transforms', () => {
    expect(() => createSelectionVolume({ kind: 'box' })).toThrow(/halfExtents/);
    expect(() => createSelectionVolume({ kind: 'sphere', radius: 0 })).toThrow(/radius/);
    expect(() => createSelectionVolume({ kind: 'cylinder', radius: 1 })).toThrow(/height/);
    expect(() =>
      createSelectionVolume({
        kind: 'sphere',
        radius: 1,
        transform: new THREE.Matrix4().makeScale(0, 1, 1),
      }),
    ).toThrow(/invertible/);
  });
});

describe('createSelectionVolume placement (property-based)', () => {
  /**
   * An independent containment reference: map the point into the shape's frame
   * with THREE's own matrix math, then test the unit shape. Deliberately naive
   * - it exists to disagree with the unrolled fast path if that path is wrong.
   */
  function referenceContains(
    options: Parameters<typeof createSelectionVolume>[0],
    worldMatrix: THREE.Matrix4,
    point: THREE.Vector3,
  ): boolean {
    const toVolume = new THREE.Matrix4()
      .copy(options.transform ?? new THREE.Matrix4())
      .invert()
      .multiply(worldMatrix);
    const p = point.clone().applyMatrix4(toVolume);
    if (options.kind === 'box') {
      const [hx, hy, hz] = options.halfExtents as readonly [number, number, number];
      return Math.abs(p.x) <= hx && Math.abs(p.y) <= hy && Math.abs(p.z) <= hz;
    }
    const r = options.radius as number;
    if (options.kind === 'sphere') return p.length() <= r;
    return Math.abs(p.y) <= (options.height as number) / 2 && Math.hypot(p.x, p.z) <= r;
  }

  it('matches an applyMatrix4 reference under random rotation, scale and translation', () => {
    const rand = lcg(20260725);
    const kinds = ['box', 'sphere', 'cylinder'] as const;
    let insideSeen = 0;
    for (let round = 0; round < 200; round++) {
      // A volume placed with rotation + non-uniform scale + translation, and a
      // mesh world matrix that is itself rotated and translated.
      const transform = new THREE.Matrix4().compose(
        new THREE.Vector3((rand() - 0.5) * 6, (rand() - 0.5) * 6, (rand() - 0.5) * 6),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI),
        ),
        new THREE.Vector3(0.4 + rand() * 2, 0.4 + rand() * 2, 0.4 + rand() * 2),
      );
      const worldMatrix = new THREE.Matrix4().compose(
        new THREE.Vector3((rand() - 0.5) * 4, (rand() - 0.5) * 4, (rand() - 0.5) * 4),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * Math.PI, 0, rand() * Math.PI)),
        new THREE.Vector3(1, 1, 1),
      );
      const kind = kinds[round % kinds.length] as (typeof kinds)[number];
      const options = {
        kind,
        transform,
        ...(kind === 'box'
          ? { halfExtents: [0.5 + rand(), 0.5 + rand(), 0.5 + rand()] as [number, number, number] }
          : kind === 'sphere'
            ? { radius: 0.5 + rand() }
            : { radius: 0.5 + rand(), height: 0.5 + rand() * 3 }),
      };
      const volume = createSelectionVolume(options, worldMatrix);

      for (let i = 0; i < 25; i++) {
        const point = new THREE.Vector3(
          (rand() - 0.5) * 12,
          (rand() - 0.5) * 12,
          (rand() - 0.5) * 12,
        );
        const expected = referenceContains(options, worldMatrix, point);
        expect(volume.containsPoint(point.x, point.y, point.z)).toBe(expected);
        if (expected) insideSeen++;
      }
    }
    // Guard against a vacuous pass where nothing ever landed inside.
    expect(insideSeen).toBeGreaterThan(20);
  });

  it('composes transform and worldMatrix in the documented order', () => {
    // Volume at world x=+4; splats under a mesh translated by +4 as well, so a
    // splat at local origin sits exactly at the volume's center. Reversing the
    // composition order would put it 8 units away.
    const transform = new THREE.Matrix4().setPosition(4, 0, 0);
    const world = new THREE.Matrix4().setPosition(4, 0, 0);
    const volume = createSelectionVolume({ kind: 'sphere', radius: 0.5, transform }, world);
    expect(volume.containsPoint(0, 0, 0)).toBe(true);
    expect(volume.containsPoint(-4, 0, 0)).toBe(false);
  });

  it('rejects a singular or non-finite worldMatrix, not just transform', () => {
    const collapsed = new THREE.Matrix4().makeScale(1, 0, 1);
    expect(() => createSelectionVolume({ kind: 'sphere', radius: 1 }, collapsed)).toThrow(
      /worldMatrix.*invertible/s,
    );
    const nonFinite = new THREE.Matrix4();
    nonFinite.elements[0] = Number.NaN;
    expect(() => createSelectionVolume({ kind: 'sphere', radius: 1 }, nonFinite)).toThrow(
      /non-finite/,
    );
  });
});

describe('selectInData', () => {
  it('returns ascending indices of the splats inside the volume', () => {
    const data = dataFromPoints([
      [0, 0, 0],
      [5, 0, 0],
      [0.5, 0.5, 0],
      [-3, 0, 0],
      [0, 0, 0.9],
    ]);
    const sphere = createSelectionVolume({ kind: 'sphere', radius: 1 });
    expect(Array.from(selectInData(data, sphere))).toEqual([0, 2, 4]);
  });

  it('accepts a custom volume implementation', () => {
    const halfSpace: SelectionVolume = { containsPoint: (x) => x >= 0 };
    const data = dataFromPoints([
      [-1, 0, 0],
      [0, 0, 0],
      [1, 0, 0],
    ]);
    expect(Array.from(selectInData(data, halfSpace))).toEqual([1, 2]);
  });

  it('handles empty and all-inclusive selections', () => {
    const data = dataFromPoints([
      [10, 0, 0],
      [11, 0, 0],
    ]);
    const none = createSelectionVolume({ kind: 'sphere', radius: 1 });
    const all = createSelectionVolume({ kind: 'sphere', radius: 100 });
    expect(selectInData(data, none).length).toBe(0);
    expect(Array.from(selectInData(data, all))).toEqual([0, 1]);
  });
});

describe('countInData', () => {
  it('agrees with selectInData without materializing the indices', () => {
    const rand = lcg(7);
    const points: [number, number, number][] = [];
    for (let i = 0; i < 500; i++) {
      points.push([(rand() - 0.5) * 8, (rand() - 0.5) * 8, (rand() - 0.5) * 8]);
    }
    const data = dataFromPoints(points);
    for (const radius of [0.5, 2, 3.5, 50]) {
      const volume = createSelectionVolume({ kind: 'sphere', radius });
      expect(countInData(data, volume)).toBe(selectInData(data, volume).length);
    }
  });
});
