import { describe, expect, it } from 'vitest';
import {
  RADIX_EXACT_KEY_BITS,
  RADIX_KEY_MAX,
  quantizeDepthKey,
  sortableFloat32Bits,
  stableRadixSortReference,
} from '../radix-sort';

const floatBits = (value: number) => new Uint32Array(new Float32Array([value]).buffer)[0] as number;

describe('24-bit radix reference', () => {
  it('quantizes the complete range and clamps outliers', () => {
    expect(quantizeDepthKey(-2, -2, 2)).toBe(0);
    expect(quantizeDepthKey(2, -2, 2)).toBe(RADIX_KEY_MAX);
    expect(quantizeDepthKey(-10, -2, 2)).toBe(0);
    expect(quantizeDepthKey(10, -2, 2)).toBe(RADIX_KEY_MAX);
  });

  it('returns an exact stable permutation across all six passes', () => {
    const keys = Uint32Array.from([0xffffff, 7, 0x123456, 7, 0, 0x123456, 0x10000, 15, 7]);
    const values = Uint32Array.from(keys.keys());
    const order = stableRadixSortReference(keys, values);
    expect([...order]).toEqual([4, 1, 3, 8, 7, 6, 2, 5, 0]);
    expect(new Set(order).size).toBe(keys.length);
    for (let i = 1; i < order.length; i++) {
      expect(keys[order[i - 1] as number] as number).toBeLessThanOrEqual(
        keys[order[i] as number] as number,
      );
    }
  });

  it('handles empty and non-workgroup-aligned inputs', () => {
    expect(stableRadixSortReference(new Uint32Array())).toHaveLength(0);
    const keys = Uint32Array.from({ length: 259 }, (_, i) => (i * 7919) & RADIX_KEY_MAX);
    const order = stableRadixSortReference(keys);
    expect(order).toHaveLength(keys.length);
    expect(new Set(order).size).toBe(keys.length);
  });

  it('maps Float32 bits into numeric depth order without range quantization', () => {
    const depths = [-1000, -2, -0, 0, 0.25, 1000];
    const keys = depths.map((depth) => sortableFloat32Bits(floatBits(depth)));
    expect([...keys]).toEqual([...keys].sort((a, b) => a - b));
  });

  it('keeps all 32 key bits and preserves ties in the exact reference path', () => {
    const keys = Uint32Array.from([0x81234567, 0x7fffffff, 0x81234567, 0xffffffff, 0]);
    const order = stableRadixSortReference(keys, undefined, RADIX_EXACT_KEY_BITS);
    expect([...order]).toEqual([4, 1, 0, 2, 3]);
  });
});
