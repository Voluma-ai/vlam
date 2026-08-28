import { describe, expect, it } from 'vitest';
import { createSelectionVolume, selectInData } from '../selection-volume';
import { partitionSplatData } from '../splat-partition';
import type { SplatData } from '../splat-data';

/**
 * Partition correctness: the halves must sum to the source, gather the right
 * per-splat records, and carry SH (palette and packed forms) with them.
 */

/** A deterministic LCG so runs are reproducible without Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomData(count: number, seed: number, span = 10): SplatData {
  const rand = lcg(seed);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) positions[i * 3 + a] = (rand() - 0.5) * span;
    for (let a = 0; a < 4; a++) colors[i * 4 + a] = Math.floor(rand() * 256);
    for (let a = 0; a < 6; a++) covariances[i * 6 + a] = rand();
  }
  return { count, positions, colors, covariances };
}

/** The full record of splat `i`, for comparing across a gather. */
function record(data: SplatData, i: number): number[] {
  return [
    ...Array.from(data.positions.subarray(i * 3, i * 3 + 3)),
    ...Array.from(data.colors.subarray(i * 4, i * 4 + 4)),
    ...Array.from(data.covariances.subarray(i * 6, i * 6 + 6)),
  ];
}

describe('partitionSplatData', () => {
  it('splits by a volume with both halves summing to the source', () => {
    const data = randomData(500, 1);
    const sphere = createSelectionVolume({ kind: 'sphere', radius: 3 });
    const { inside, outside, insideIndices } = partitionSplatData(data, sphere);

    expect(inside.count + outside.count).toBe(data.count);
    expect(inside.count).toBe(insideIndices.length);
    expect(inside.count).toBeGreaterThan(0); // radius 3 of a span-10 cloud
    expect(outside.count).toBeGreaterThan(0);

    // Every inside splat is a faithful copy of its source record, in order.
    insideIndices.forEach((src, k) => {
      expect(record(inside, k)).toEqual(record(data, src));
    });
    // Outside gets everything else, preserving source order.
    const insideSet = new Set(insideIndices);
    let k = 0;
    for (let i = 0; i < data.count; i++) {
      if (insideSet.has(i)) continue;
      expect(record(outside, k)).toEqual(record(data, i));
      k++;
    }
  });

  it('accepts a precomputed index list and validates it', () => {
    const data = randomData(10, 2);
    const picked = new Uint32Array([1, 4, 7]);
    const { inside, outside, insideIndices } = partitionSplatData(data, picked);
    // A private copy, so a caller reusing its scratch buffer cannot mutate the
    // published partition after the fact.
    expect(Array.from(insideIndices)).toEqual([1, 4, 7]);
    expect(insideIndices).not.toBe(picked);
    picked.fill(0);
    expect(Array.from(insideIndices)).toEqual([1, 4, 7]);
    expect(inside.count).toBe(3);
    expect(outside.count).toBe(7);
    expect(record(inside, 1)).toEqual(record(data, 4));

    expect(() => partitionSplatData(data, new Uint32Array([3, 3]))).toThrow(/ascending/);
    expect(() => partitionSplatData(data, new Uint32Array([11]))).toThrow(/out of range/);
  });

  it('handles empty and full selections', () => {
    const data = randomData(20, 3);
    const none = partitionSplatData(data, new Uint32Array(0));
    expect(none.inside.count).toBe(0);
    expect(none.outside.count).toBe(20);
    const all = partitionSplatData(data, new Uint32Array(Array.from({ length: 20 }, (_, i) => i)));
    expect(all.inside.count).toBe(20);
    expect(all.outside.count).toBe(0);
    expect(all.inside.positions).toEqual(data.positions);
  });

  it('carries palette SH: shared palette, gathered labels', () => {
    const base = randomData(6, 4);
    const sh = {
      bands: 2,
      labels: new Uint32Array([5, 4, 3, 2, 1, 0]),
      palette: new Float32Array(64 * 8 * 4),
      paletteWidth: 64 * 8,
      paletteHeight: 1,
    };
    const data: SplatData = { ...base, sh };
    const { inside, outside } = partitionSplatData(data, new Uint32Array([0, 2, 5]));
    expect(inside.sh?.palette).toBe(sh.palette); // shared, not copied
    expect(Array.from(inside.sh?.labels ?? [])).toEqual([5, 3, 0]);
    expect(Array.from(outside.sh?.labels ?? [])).toEqual([4, 2, 1]);
  });

  it('carries packed SH by gathering each splat words', () => {
    const base = randomData(4, 5);
    const bands = 1; // 3 words per splat
    const packed = new Uint32Array(4 * 3);
    for (let i = 0; i < packed.length; i++) packed[i] = i + 100;
    const data: SplatData = {
      ...base,
      shPacked: { bands, packed, range: { min: [0, 0, 0], max: [1, 1, 1] } },
    };
    const { inside, outside } = partitionSplatData(data, new Uint32Array([1, 3]));
    expect(Array.from(inside.shPacked?.packed ?? [])).toEqual([103, 104, 105, 109, 110, 111]);
    expect(Array.from(outside.shPacked?.packed ?? [])).toEqual([100, 101, 102, 106, 107, 108]);
    expect(inside.shPacked?.range).toBe(data.shPacked?.range);
  });

  it('preserves flags and drops streamed-only fields', () => {
    const base = randomData(3, 6);
    const data: SplatData = {
      ...base,
      antialias: true,
      format: 'sog',
      frontierParent: new Float32Array(3),
      radTree: {
        childCount: new Uint16Array(3),
        childStart: new Uint32Array(3),
        size: new Float32Array(3),
      },
      radShCodebook: { bands: 1, coefficients: new Float32Array(9), count: 1 },
    };
    const { inside, outside } = partitionSplatData(data, new Uint32Array([0]));
    expect(inside.antialias).toBe(true);
    expect(inside.format).toBe('sog');
    // Index topology over the whole cloud is meaningless on a subset, so the
    // streamed-only fields must not travel with either half.
    for (const half of [inside, outside]) {
      expect(half.frontierParent).toBeUndefined();
      expect(half.radTree).toBeUndefined();
      expect(half.radShCodebook).toBeUndefined();
    }
  });

  it('round-trips: the two halves together are a permutation of the source', () => {
    const base = randomData(400, 11);
    const data: SplatData = {
      ...base,
      sh: {
        bands: 1,
        labels: Uint32Array.from({ length: 400 }, (_, i) => i % 17),
        palette: new Float32Array(64 * 3 * 4),
        paletteWidth: 64 * 3,
        paletteHeight: 1,
      },
    };
    const volume = createSelectionVolume({ kind: 'box', halfExtents: [2, 2, 2] });
    const { inside, outside } = partitionSplatData(data, volume);
    expect(inside.count).toBeGreaterThan(0);
    expect(outside.count).toBeGreaterThan(0);

    // Every source splat appears exactly once across the halves, carrying its
    // own position, color, covariance and SH label - this is what makes the
    // pair render identically to the original before anything is animated.
    const seen = new Map<string, number>();
    for (const half of [inside, outside]) {
      for (let i = 0; i < half.count; i++) {
        seen.set(record(half, i).join(',') + `|${half.sh?.labels[i] as number}`, 1);
      }
    }
    for (let i = 0; i < data.count; i++) {
      const key = record(data, i).join(',') + `|${data.sh?.labels[i] as number}`;
      expect(seen.has(key)).toBe(true);
    }
    expect(inside.count + outside.count).toBe(data.count);
  });

  it('matches gathering the volume selection by hand', () => {
    const data = randomData(300, 12);
    const volume = createSelectionVolume({ kind: 'cylinder', radius: 2, height: 4 });
    const byVolume = partitionSplatData(data, volume);
    const byIndices = partitionSplatData(data, selectInData(data, volume));
    expect(Array.from(byVolume.insideIndices)).toEqual(Array.from(byIndices.insideIndices));
    expect(byVolume.inside.positions).toEqual(byIndices.inside.positions);
    expect(byVolume.outside.positions).toEqual(byIndices.outside.positions);
  });
});
