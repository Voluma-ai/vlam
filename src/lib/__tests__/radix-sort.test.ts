import { describe, expect, it } from 'vitest';
import {
  RADIAL_RADIX_KEY_MAX,
  RADIX_EXACT_KEY_BITS,
  RADIX_KEY_MAX,
  quantizeDepthKey,
  quantizeRadialKey,
  radixPassCount,
  RADIAL_RADIX_KEY_BITS,
  sortableFloat32Bits,
  stableRadixSortReference,
} from '../core/radix-sort';

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

describe('16-bit warped radial key', () => {
  // Radial depth is the negated distance, so the range runs [-far, -near].
  const near = 0;
  const far = 300;
  const key = (distance: number) => quantizeRadialKey(-distance, -far, -near);

  it('needs four passes and spans the full key range', () => {
    expect(radixPassCount(RADIAL_RADIX_KEY_BITS)).toBe(4);
    expect(key(far)).toBe(0);
    expect(key(near)).toBe(RADIAL_RADIX_KEY_MAX);
    expect(key(far * 10)).toBe(0);
    expect(quantizeRadialKey(1, 1, 1)).toBe(0);
  });

  it('keeps farther splats on lower keys, so ascending order draws back to front', () => {
    let previous = -1;
    for (let distance = far; distance >= near; distance -= 0.25) {
      const next = key(distance);
      expect(next).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
  });

  it('keeps sub-millimetre steps near the camera where a linear 16-bit key cannot', () => {
    // Smallest distance change that moves the key, measured around 1 m.
    const step = (at: number) => {
      const base = key(at);
      let delta = 1e-5;
      while (key(at - delta) === base) delta += 1e-5;
      return delta;
    };
    expect(step(1)).toBeLessThan(0.001);
    expect(step(10)).toBeLessThan(0.002);
    expect(far / RADIAL_RADIX_KEY_MAX).toBeGreaterThan(0.004);
    expect(step(far - 1)).toBeLessThan(0.01);
  });
});
