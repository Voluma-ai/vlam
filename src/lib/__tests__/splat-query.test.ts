import { describe, expect, it } from 'vitest';
import { UniformGrid } from '../core/splat-query';

/**
 * Tests for the pure uniform grid behind M9's CPU spatial queries. Correctness
 * is checked against brute-force nearest/within on random point clouds.
 */

/** A deterministic LCG so runs are reproducible without Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A pool-layout centers array (stride 4) of `count` random points in [0, span). */
function randomCloud(count: number, span: number, seed: number): Float32Array {
  const rand = lcg(seed);
  const centers = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    centers[i * 4] = rand() * span;
    centers[i * 4 + 1] = rand() * span;
    centers[i * 4 + 2] = rand() * span;
  }
  return centers;
}

function bruteNearest(
  centers: Float32Array,
  indices: Uint32Array,
  x: number,
  y: number,
  z: number,
  radius: number,
): { index: number; distSq: number } | null {
  let best = -1;
  let bestSq = radius * radius;
  for (const p of indices) {
    const b = p * 4;
    const dx = (centers[b] as number) - x;
    const dy = (centers[b + 1] as number) - y;
    const dz = (centers[b + 2] as number) - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 <= bestSq) {
      bestSq = d2;
      best = p;
    }
  }
  return best < 0 ? null : { index: best, distSq: bestSq };
}

describe('UniformGrid', () => {
  it('finds the same nearest splat as brute force across random queries', () => {
    const count = 2000;
    const centers = randomCloud(count, 100, 12345);
    const indices = Uint32Array.from({ length: count }, (_, i) => i);
    const grid = new UniformGrid(centers, indices, count);
    const rand = lcg(999);

    for (let q = 0; q < 200; q++) {
      const x = rand() * 100;
      const y = rand() * 100;
      const z = rand() * 100;
      const radius = 5 + rand() * 40;
      const brute = bruteNearest(centers, indices, x, y, z, radius);
      const hit = grid.nearest(x, y, z, radius);
      if (brute === null) {
        expect(hit).toBeNull();
      } else {
        // Ties are possible; compare distance, not index identity.
        expect(hit).not.toBeNull();
        expect(hit!.distSq).toBeCloseTo(brute.distSq, 6);
      }
    }
  });

  it('indexes only the pool indices it is given (resident subset)', () => {
    const centers = randomCloud(500, 50, 7);
    // Index only the even splats; an odd splat must never be returned.
    const indices = Uint32Array.from({ length: 250 }, (_, i) => i * 2);
    const grid = new UniformGrid(centers, indices, indices.length);
    const seen = new Set<number>();
    grid.forEachWithin(25, 25, 25, 1000, (p) => seen.add(p));
    expect(seen.size).toBe(250);
    for (const p of seen) expect(p % 2).toBe(0);
  });

  it('returns null on an empty set and for a negative radius', () => {
    const grid = new UniformGrid(new Float32Array(0), new Uint32Array(0), 0);
    expect(grid.nearest(0, 0, 0, 10)).toBeNull();
    const grid2 = new UniformGrid(
      randomCloud(10, 10, 1),
      Uint32Array.from({ length: 10 }, (_, i) => i),
      10,
    );
    expect(grid2.nearest(0, 0, 0, -1)).toBeNull();
  });

  it('resolves a planar cloud (one degenerate axis) correctly', () => {
    const count = 800;
    const centers = randomCloud(count, 100, 42);
    for (let i = 0; i < count; i++) centers[i * 4 + 1] = 0; // flatten Y
    const indices = Uint32Array.from({ length: count }, (_, i) => i);
    const grid = new UniformGrid(centers, indices, count);
    const rand = lcg(3);
    for (let q = 0; q < 100; q++) {
      const x = rand() * 100;
      const z = rand() * 100;
      const radius = 10 + rand() * 30;
      const brute = bruteNearest(centers, indices, x, 0, z, radius);
      const hit = grid.nearest(x, 0, z, radius);
      if (brute === null) expect(hit).toBeNull();
      else expect(hit!.distSq).toBeCloseTo(brute.distSq, 6);
    }
  });
});
