import { describe, expect, it } from 'vitest';
import type { SplatData } from '../core/splat-data';
import { limitSplatCount } from '../loaders/limit-splat-count';

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
});
