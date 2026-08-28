import { describe, expect, it } from 'vitest';
import { frontierView, traverseFrontier } from '../formats/rad/rad-frontier';
import type { SplatData } from '../core/splat-data';
import { buildStaticLod } from '../static-lod/static-lod';

const source = (xs: readonly number[]): SplatData => ({
  count: xs.length,
  positions: Float32Array.from(xs.flatMap((x) => [x, 0, 0])),
  colors: Uint8Array.from(xs.flatMap((_, index) => [10 + index * 10, 20, 30, 255])),
  covariances: Float32Array.from(xs.flatMap(() => [1, 0, 0, 1, 0, 1])),
});

const leafCoverage = (data: SplatData, node: number, visits: Uint8Array): void => {
  const tree = data.radTree;
  if (!tree) throw new Error('Expected hierarchy.');
  const count = tree.childCount[node] as number;
  if (count === 0) {
    visits[node] = (visits[node] as number) + 1;
    return;
  }
  const start = tree.childStart[node] as number;
  for (let child = 0; child < count; child++) leafCoverage(data, start + child, visits);
};

describe('buildStaticLod', () => {
  it('builds a non-overlapping hierarchy that covers every retained source region', () => {
    const result = buildStaticLod(source([0, 1, 2, 3, 4]), 3);
    expect(result.contentSplatCount).toBe(5);
    expect(result.finestSplatCount).toBe(3);
    expect(result.data.count).toBe(6);

    const visits = new Uint8Array(result.finestSplatCount);
    leafCoverage(result.data, result.roots[0] as number, visits);
    expect([...visits]).toEqual([1, 1, 1]);
  });

  it('moment-matches position, color and covariance for merged Gaussians', () => {
    const result = buildStaticLod(source([-1, 1]), 1);
    expect(result.data.positions[0]).toBeCloseTo(0);
    expect([...result.data.colors.slice(0, 3)]).toEqual([15, 20, 30]);
    expect(result.data.covariances[0]).toBeCloseTo(2);
    expect(result.data.covariances[3]).toBeCloseTo(1);
    expect(result.data.covariances[5]).toBeCloseTo(1);
  });

  it('preserves metadata and uses the mass-dominant child for SH data', () => {
    const input = source([-1, 1]);
    input.colors[7] = 64;
    const result = buildStaticLod(
      {
        ...input,
        antialias: true,
        format: 'sog',
        sh: {
          bands: 1,
          labels: Uint32Array.of(4, 9),
          palette: new Float32Array(16),
          paletteWidth: 2,
          paletteHeight: 2,
        },
        shPacked: {
          bands: 1,
          packed: Uint32Array.of(1, 2, 3, 7, 8, 9),
          range: { min: [0, 0, 0], max: [1, 1, 1] },
        },
      },
      1,
    );

    expect(result.data.antialias).toBe(true);
    expect(result.data.format).toBe('sog');
    expect(result.data.sh?.labels[0]).toBe(4);
    expect([...(result.data.shPacked?.packed ?? new Uint32Array())]).toEqual([1, 2, 3]);
    expect(result.data.colors[3]).toBeGreaterThan(0);
  });

  it('returns complete camera-aware cuts that never exceed the budget', () => {
    const result = buildStaticLod(source([0, 1, 2, 3, 4, 5, 6, 7]), 8);
    const view = frontierView({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: -1 });
    const chunks = new Map([[0, result.data]]);
    for (const budget of [1, 2, 3, 5, 8]) {
      const cut = traverseFrontier(chunks, [...result.roots], result.data.count, view, 0, budget);
      expect(cut.count).toBeLessThanOrEqual(budget);
      expect(cut.count).toBeGreaterThan(0);
      expect(cut.touched.size).toBe(0);
    }
  });
});
