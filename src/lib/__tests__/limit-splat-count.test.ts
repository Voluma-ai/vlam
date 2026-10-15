import { describe, expect, it } from 'vitest';
import type { SplatData } from '../core/splat-data';
import { importanceScore, limitSplatCount } from '../loaders/limit-splat-count';

/** Splat i sits at x = i with the given opacity byte and isotropic variance. */
function makeData(
  splats: readonly { alpha: number; variance: number }[],
  extra: Partial<SplatData> = {},
): SplatData {
  const count = splats.length;
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  splats.forEach(({ alpha, variance }, i) => {
    positions[i * 3] = i;
    colors.set([i % 256, 0, 0, alpha], i * 4);
    covariances.set([variance, 0, 0, variance, 0, variance], i * 6);
  });
  return { count, positions, colors, covariances, ...extra };
}

const xs = (data: SplatData): number[] =>
  Array.from({ length: data.count }, (_, i) => data.positions[i * 3] as number);

describe('limitSplatCount', () => {
  it('returns data that already fits unchanged', () => {
    const data = makeData([{ alpha: 255, variance: 1 }]);
    expect(limitSplatCount(data, 1)).toBe(data);
  });

  it('keeps the most visible splats in file order', () => {
    const data = makeData([
      { alpha: 255, variance: 1 }, // 3
      { alpha: 10, variance: 1 }, // faint
      { alpha: 255, variance: 4 }, // 12
      { alpha: 0, variance: 9 }, // invisible
      { alpha: 255, variance: 0.01 }, // tiny
      { alpha: 128, variance: 2 }, // ≈3
    ]);
    const out = limitSplatCount(data, 3);
    expect(out.count).toBe(3);
    expect(out.sourceCount).toBe(6);
    expect(xs(out)).toEqual([0, 2, 5]);
    expect(Array.from(out.colors)).toEqual([0, 0, 0, 255, 2, 0, 0, 255, 5, 0, 0, 128]);
    expect(Array.from(out.covariances.subarray(6, 12))).toEqual([4, 0, 0, 4, 0, 4]);
    // Shrunk, so the dropped tail is not transferred.
    expect(out.positions.buffer.byteLength).toBe(3 * 3 * 4);
    expect(out.covariances.buffer.byteLength).toBe(3 * 6 * 4);
  });

  it('thins equally important splats evenly across the file', () => {
    const data = makeData(Array.from({ length: 100 }, () => ({ alpha: 200, variance: 1 })));
    const kept = xs(limitSplatCount(data, 25));
    expect(kept).toHaveLength(25);
    // Every quarter of the file keeps its share, rather than the first 25.
    for (let quarter = 0; quarter < 4; quarter++) {
      const inQuarter = kept.filter((x) => x >= quarter * 25 && x < (quarter + 1) * 25);
      expect(inQuarter.length).toBeGreaterThanOrEqual(6);
      expect(inQuarter.length).toBeLessThanOrEqual(7);
    }
  });

  it('compacts palette SH labels and packed SH alongside the base arrays', () => {
    const splats = [
      { alpha: 1, variance: 1 },
      { alpha: 255, variance: 1 },
      { alpha: 2, variance: 1 },
      { alpha: 255, variance: 2 },
    ];
    const palette = new Float32Array(4);
    const data = makeData(splats, {
      sh: {
        bands: 1,
        labels: Uint32Array.from([10, 11, 12, 13]),
        palette,
        paletteWidth: 1,
        paletteHeight: 1,
      },
      shPacked: {
        bands: 1,
        packed: Uint32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]),
        range: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    });
    const out = limitSplatCount(data, 2);
    expect(xs(out)).toEqual([1, 3]);
    expect(Array.from(out.sh?.labels ?? [])).toEqual([11, 13]);
    expect(out.sh?.palette).toBe(palette);
    expect(Array.from(out.shPacked?.packed ?? [])).toEqual([1, 1, 1, 3, 3, 3]);
  });

  it('keeps the original source count across repeated thinning', () => {
    const data = makeData(
      Array.from({ length: 8 }, (_, i) => ({ alpha: 255, variance: i + 1 })),
      { sourceCount: 80 },
    );
    expect(limitSplatCount(data, 4).sourceCount).toBe(80);
  });

  it('refuses to thin a streamed RAD chunk, whose tree links would break', () => {
    const data = makeData(
      [
        { alpha: 255, variance: 1 },
        { alpha: 255, variance: 1 },
      ],
      {
        radTree: {
          childCount: new Uint16Array(2),
          childStart: new Uint32Array(2),
          size: new Float32Array(2),
        },
      },
    );
    expect(() => limitSplatCount(data, 1)).toThrow(/drawable maximum/);
  });

  it('ranks a thinned scene most visible first, file order within a bucket', () => {
    const data = makeData([
      { alpha: 255, variance: 1 }, // 3
      { alpha: 10, variance: 1 }, // dropped
      { alpha: 255, variance: 4 }, // 12
      { alpha: 255, variance: 1 }, // 3, ties splat 0
      { alpha: 0, variance: 9 }, // dropped
      { alpha: 255, variance: 2 }, // 6
    ]);
    const out = limitSplatCount(data, 4, { drawOrder: true });
    expect(xs(out)).toEqual([0, 2, 3, 5]);
    // Kept rows: 0→x0, 1→x2, 2→x3, 3→x5. By importance: x2, x5, then the
    // tied x0 and x3 in file order.
    expect(Array.from(out.drawOrder ?? [])).toEqual([1, 3, 0, 2]);
  });

  it('emits a draw order without thinning when asked, and none otherwise', () => {
    const splats = Array.from({ length: 50 }, (_, i) => ({
      alpha: (i * 37) % 256,
      variance: 1 + ((i * 13) % 7),
    }));
    const ordered = limitSplatCount(makeData(splats), 100, { drawOrder: true });
    expect(ordered.sourceCount).toBeUndefined();
    expect(ordered.count).toBe(50);
    const order = Array.from(ordered.drawOrder ?? []);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    const importance = (row: number) =>
      ((ordered.colors[row * 4 + 3] as number) / 255) *
      3 *
      (ordered.covariances[row * 6] as number);
    for (let i = 1; i < order.length; i++) {
      const previous = importance(order[i - 1] as number);
      const current = importance(order[i] as number);
      expect(current).toBeLessThanOrEqual(previous * (1 + 1e-3));
      // Equal importance keeps file order.
      if (current === previous) expect(order[i]).toBeGreaterThan(order[i - 1] as number);
    }

    const plain = makeData(splats);
    expect(limitSplatCount(plain, 100)).toBe(plain);
    expect(limitSplatCount(makeData(splats), 10).drawOrder).toBeUndefined();
  });

  it('ranks so a prefix keeps the same splats as thinning (no tie at the cut)', () => {
    const splats = Array.from({ length: 200 }, (_, i) => ({
      alpha: 1 + ((i * 89) % 255),
      variance: 0.5 + ((i * 31) % 11),
    }));
    const order = limitSplatCount(makeData(splats), 200, { drawOrder: true }).drawOrder;
    const prefix = new Set(Array.from(order ?? []).slice(0, 60));
    const thinned = xs(limitSplatCount(makeData(splats), 60));
    expect([...prefix].sort((a, b) => a - b)).toEqual(thinned);
  });

  it('thins to nothing when the budget share is zero', () => {
    const out = limitSplatCount(makeData([{ alpha: 255, variance: 1 }]), 0, { drawOrder: true });
    expect(out.count).toBe(0);
    expect(out.positions.length).toBe(0);
    expect(out.drawOrder?.length).toBe(0);
    expect(out.sourceCount).toBe(1);
  });
});

describe('importanceScore', () => {
  it('drops non-finite importance below every real score', () => {
    expect(importanceScore(1, Infinity)).toBe(-Infinity);
    expect(importanceScore(1, Number.NaN)).toBe(-Infinity);
    expect(importanceScore(0, 1)).toBe(-Infinity);
    expect(importanceScore(1, 8)).toBe(3);
  });

  it('keeps ranking the finite splats when one covariance is infinite', () => {
    // One corrupt splat must not squash every finite score into one bin.
    const variances = [1, Infinity, 4, 9, 0.01, 16];
    const data = makeData(variances.map((variance) => ({ alpha: 255, variance })));
    expect(xs(limitSplatCount(data, 3))).toEqual([2, 3, 5]);
  });
});
