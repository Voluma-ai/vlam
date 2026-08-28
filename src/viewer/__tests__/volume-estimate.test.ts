import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import type { SplatData } from '../../lib/core';
import type { TriangleMeshData } from '../../lib/formats/lcc';
import { analyticSelectionVolume, estimateSelectionVolume } from '../volume-estimate';

/**
 * Quantitative checks of the volume estimator against shapes of known volume.
 * The estimator is a voxel discretization, so assertions are bracketing
 * (`massLower ≤ truth ≤ massUpper`) with tolerances derived from the voxel
 * size.
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
  const colors = new Uint8Array(points.length * 4);
  points.forEach(([x, y, z], i) => {
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    colors[i * 4 + 3] = 255; // fully opaque by default
  });
  return {
    count: points.length,
    positions,
    colors,
    covariances: new Float32Array(points.length * 6),
  };
}

/** A dense shell of points on a sphere of radius `r` (Fibonacci lattice). */
function sphereShell(r: number, count: number): [number, number, number][] {
  const points: [number, number, number][] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const radius = Math.sqrt(1 - y * y);
    const theta = golden * i;
    points.push([r * radius * Math.cos(theta), r * y, r * radius * Math.sin(theta)]);
  }
  return points;
}

/** Points sampled densely on the six faces of a box with half-extents h. */
function boxShell(h: number, perAxis: number): [number, number, number][] {
  const points: [number, number, number][] = [];
  for (let i = 0; i <= perAxis; i++) {
    for (let j = 0; j <= perAxis; j++) {
      const u = -h + (2 * h * i) / perAxis;
      const v = -h + (2 * h * j) / perAxis;
      points.push([u, v, h], [u, v, -h], [u, h, v], [u, -h, v], [h, u, v], [-h, u, v]);
    }
  }
  return points;
}

/** A closed unit-ish cube collision mesh (12 triangles), scaled by `h`. */
function cubeMesh(h: number): TriangleMeshData {
  const p = [
    [-h, -h, -h],
    [h, -h, -h],
    [h, h, -h],
    [-h, h, -h],
    [-h, -h, h],
    [h, -h, h],
    [h, h, h],
    [-h, h, h],
  ];
  const positions = new Float32Array(p.flat());
  // prettier-ignore
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // -z
    4, 5, 6, 4, 6, 7, // +z
    0, 1, 5, 0, 5, 4, // -y
    3, 6, 2, 3, 7, 6, // +y
    0, 4, 7, 0, 7, 3, // -x
    1, 2, 6, 1, 6, 5, // +x
  ]);
  return { vertexCount: 8, triangleCount: 12, positions, indices };
}

describe('analyticSelectionVolume', () => {
  it('is exact for the unit shapes', () => {
    expect(analyticSelectionVolume({ kind: 'box', halfExtents: [1, 2, 3] })).toBeCloseTo(48);
    expect(analyticSelectionVolume({ kind: 'sphere', radius: 2 })).toBeCloseTo(
      (4 / 3) * Math.PI * 8,
    );
    expect(analyticSelectionVolume({ kind: 'cylinder', radius: 2, height: 3 })).toBeCloseTo(
      Math.PI * 4 * 3,
    );
  });

  it('scales by the placement determinant, rotation-invariant', () => {
    const transform = new THREE.Matrix4()
      .makeRotationFromEuler(new THREE.Euler(0.3, 1.1, -0.7))
      .scale(new THREE.Vector3(2, 0.5, 3))
      .setPosition(5, -2, 9);
    expect(analyticSelectionVolume({ kind: 'sphere', radius: 1, transform })).toBeCloseTo(
      (4 / 3) * Math.PI * (2 * 0.5 * 3),
    );
  });
});

describe('estimateSelectionVolume', () => {
  it('brackets the volume of a closed sphere shell', () => {
    const r = 1;
    const data = dataFromPoints(sphereShell(r, 6000));
    const truth = (4 / 3) * Math.PI * r ** 3;
    const est = estimateSelectionVolume(data, { kind: 'sphere', radius: 1.5 }, undefined, {
      // 6000 points on 4π of surface → ~0.046 spacing; h must exceed it.
      resolution: 40,
    });
    expect(est.leaked).toBe(false);
    expect(est.massLower).toBeLessThanOrEqual(truth);
    expect(est.massUpper).toBeGreaterThanOrEqual(truth);
    // The bracket should be tight-ish at this resolution: shell bias is one
    // voxel each way over the sphere's surface (~4πr²·h per side).
    expect(est.massLower).toBeGreaterThan(truth * 0.6);
    expect(est.massUpper).toBeLessThan(truth * 1.6);
  });

  it('brackets the volume of a closed box shell', () => {
    const h = 1;
    const data = dataFromPoints(boxShell(h, 80));
    const truth = 8 * h ** 3;
    const est = estimateSelectionVolume(
      data,
      { kind: 'box', halfExtents: [1.5, 1.5, 1.5] },
      undefined,
      { resolution: 48 },
    );
    expect(est.leaked).toBe(false);
    expect(est.massLower).toBeLessThanOrEqual(truth);
    expect(est.massUpper).toBeGreaterThanOrEqual(truth);
    expect(est.massLower).toBeGreaterThan(truth * 0.6);
  });

  it('reports an open shell as leaked - the honesty case', () => {
    // Only the upper hemisphere: the flood fill walks in through the open
    // bottom, so (almost) nothing is enclosed.
    const points = sphereShell(1, 6000).filter(([, y]) => y > 0.05);
    const est = estimateSelectionVolume(
      dataFromPoints(points),
      { kind: 'sphere', radius: 1.5 },
      undefined,
      { resolution: 64, closingRadius: 0 },
    );
    expect(est.leaked).toBe(true);
    expect(est.interiorVolume).toBeLessThan((4 / 3) * Math.PI * 0.1);
  });

  it('claims no phantom interior for a solid-filled cloud', () => {
    const rand = lcg(9);
    const points: [number, number, number][] = [];
    for (let i = 0; i < 20000; i++) {
      let x: number, y: number, z: number;
      do {
        x = rand() * 2 - 1;
        y = rand() * 2 - 1;
        z = rand() * 2 - 1;
      } while (x * x + y * y + z * z > 1);
      points.push([x, y, z]);
    }
    const truth = (4 / 3) * Math.PI;
    const est = estimateSelectionVolume(
      dataFromPoints(points),
      { kind: 'sphere', radius: 1.4 },
      undefined,
      // 20k points in 4.19 volume → ~0.06 spacing; a coarse grid sees a solid.
      { resolution: 24 },
    );
    // A solid fill is all shell (+ small enclosed gaps); the upper bound still
    // brackets the truth and the lower bound stays below it.
    expect(est.massUpper).toBeGreaterThan(truth * 0.8);
    expect(est.massLower).toBeLessThanOrEqual(truth);
  });

  it('estimates from collision triangles alone (closed cube, zero splats)', () => {
    const h = 1;
    const truth = 8 * h ** 3;
    const est = estimateSelectionVolume(
      dataFromPoints([]),
      { kind: 'box', halfExtents: [1.5, 1.5, 1.5] },
      undefined,
      { resolution: 64, collision: [cubeMesh(h)] },
    );
    expect(est.leaked).toBe(false);
    expect(est.massLower).toBeLessThanOrEqual(truth);
    expect(est.massUpper).toBeGreaterThanOrEqual(truth);
    expect(est.massLower).toBeGreaterThan(truth * 0.6);
  });

  it('collision seals a splat shell hole (the hybrid case)', () => {
    // Hemisphere of splats (open bottom) + a collision floor disc closing it:
    // the combination encloses roughly a hemisphere.
    const points = sphereShell(1, 6000).filter(([, y]) => y > 0);
    const floor: TriangleMeshData = (() => {
      const n = 24;
      const positions: number[] = [0, 0, 0];
      const indices: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        positions.push(Math.cos(a), 0, Math.sin(a));
        indices.push(0, i + 1, ((i + 1) % n) + 1);
      }
      return {
        vertexCount: n + 1,
        triangleCount: n,
        positions: new Float32Array(positions),
        indices: new Uint32Array(indices),
      };
    })();
    const truth = (2 / 3) * Math.PI; // hemisphere of r=1
    const est = estimateSelectionVolume(
      dataFromPoints(points),
      { kind: 'sphere', radius: 1.5 },
      undefined,
      { resolution: 36, collision: [floor] },
    );
    expect(est.leaked).toBe(false);
    expect(est.massUpper).toBeGreaterThanOrEqual(truth * 0.9);
    expect(est.massLower).toBeLessThanOrEqual(truth);
  });

  it('ignores splats below the opacity threshold (floaters)', () => {
    const shell = dataFromPoints(sphereShell(1, 4000));
    // A cloud of transparent floaters far from the shell.
    const rand = lcg(4);
    const floaters = dataFromPoints(
      Array.from({ length: 500 }, () => [
        1.2 + rand() * 0.2,
        1.2 + rand() * 0.2,
        1.2 + rand() * 0.2,
      ]),
    );
    for (let i = 0; i < floaters.count; i++) floaters.colors[i * 4 + 3] = 20; // ~8% alpha
    const combined: SplatData = {
      count: shell.count + floaters.count,
      positions: Float32Array.of(...shell.positions, ...floaters.positions),
      colors: Uint8Array.of(...shell.colors, ...floaters.colors),
      covariances: new Float32Array((shell.count + floaters.count) * 6),
    };
    const withFloaters = estimateSelectionVolume(
      combined,
      { kind: 'sphere', radius: 2.5 },
      undefined,
      { resolution: 48 },
    );
    const clean = estimateSelectionVolume(shell, { kind: 'sphere', radius: 2.5 }, undefined, {
      resolution: 48,
    });
    expect(withFloaters.shellVolume).toBeCloseTo(clean.shellVolume, 5);
  });

  it('honors the mesh worldMatrix when mapping the selection', () => {
    // Shell at local origin, mesh translated +10 in world; a world-placed
    // selection at x=10 must find it.
    const data = dataFromPoints(sphereShell(1, 4000));
    const world = new THREE.Matrix4().setPosition(10, 0, 0);
    const est = estimateSelectionVolume(
      data,
      { kind: 'sphere', radius: 1.5, transform: new THREE.Matrix4().setPosition(10, 0, 0) },
      world,
      { resolution: 28 },
    );
    expect(est.shellVolume).toBeGreaterThan(0);
    expect(est.leaked).toBe(false);
  });

  it('converts voxel volumes through a uniformly scaled mesh worldMatrix', () => {
    const data = dataFromPoints(sphereShell(1, 4000));
    const local = estimateSelectionVolume(data, { kind: 'sphere', radius: 1.5 }, undefined, {
      resolution: 28,
    });
    const world = new THREE.Matrix4().makeScale(2, 2, 2);
    const scaled = estimateSelectionVolume(data, { kind: 'sphere', radius: 3 }, world, {
      resolution: 28,
    });

    expect(scaled.shapeVolume).toBeCloseTo(local.shapeVolume * 8);
    expect(scaled.shellVolume).toBeCloseTo(local.shellVolume * 8);
    expect(scaled.interiorVolume).toBeCloseTo(local.interiorVolume * 8);
    expect(scaled.massLower).toBeCloseTo(local.massLower * 8);
    expect(scaled.massUpper).toBeCloseTo(local.massUpper * 8);
    expect(scaled.voxelSize).toBeCloseTo(local.voxelSize * 2);
  });

  it('uses the determinant for a non-uniform mesh worldMatrix', () => {
    const data = dataFromPoints(sphereShell(1, 4000));
    const local = estimateSelectionVolume(data, { kind: 'sphere', radius: 1.5 }, undefined, {
      resolution: 28,
    });
    const world = new THREE.Matrix4().makeScale(2, 3, 0.5);
    const placed = estimateSelectionVolume(
      data,
      { kind: 'sphere', radius: 1.5, transform: world },
      world,
      { resolution: 28 },
    );

    expect(placed.shapeVolume).toBeCloseTo(local.shapeVolume * 3);
    expect(placed.shellVolume).toBeCloseTo(local.shellVolume * 3);
    expect(placed.interiorVolume).toBeCloseTo(local.interiorVolume * 3);
    expect(placed.voxelSize).toBeCloseTo(local.voxelSize * Math.cbrt(3));
  });

  it('returns zeros for an empty selection', () => {
    const est = estimateSelectionVolume(
      dataFromPoints([]),
      { kind: 'sphere', radius: 1 },
      undefined,
    );
    expect(est.shellVolume).toBe(0);
    expect(est.interiorVolume).toBe(0);
    expect(est.leaked).toBe(false);
    expect(est.shapeVolume).toBeCloseTo((4 / 3) * Math.PI);
  });
});
