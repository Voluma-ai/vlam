import { describe, expect, it } from 'vitest';
import {
  packPaletteSh,
  packShCoefficients,
  packedRangesEqual,
  requantizeShWord,
  shCoefficientCount,
  type ShRange,
} from '../sh-pack';
import type { SplatShData } from '../splat-data';

/**
 * Tests for the palette→packed SH conversion and range requantization that let
 * streamed SOG scenes keep view-dependent color through the shared pool (M11).
 */

/** Decodes one packed 11/10/11 word to its three channel floats under `range`. */
function decodeWord(word: number, range: ShRange): [number, number, number] {
  const channel = (code: number, maxCode: number, ch: number): number => {
    const lo = range.min[ch] as number;
    const hi = range.max[ch] as number;
    return lo + (hi - lo) * (code / maxCode);
  };
  return [
    channel(word & 0x7ff, 2047, 0),
    channel((word >>> 11) & 0x3ff, 1023, 1),
    channel((word >>> 21) & 0x7ff, 2047, 2),
  ];
}

/**
 * A palette source: `entries` is one RGB triple per (entry, coefficient),
 * entry-major then coefficient-major. `labels` picks an entry per splat.
 */
function paletteSource(bands: 1 | 2 | 3, entries: number[][][], labels: number[]): SplatShData {
  const coeffs = shCoefficientCount(bands);
  const width = 64 * coeffs; // SOG packs 64 entries per row
  const palette = new Float32Array(width * 4);
  entries.forEach((entry, n) => {
    entry.forEach(([r, g, b], c) => {
      const texel = ((n % 64) * coeffs + c) * 4;
      palette[texel] = r as number;
      palette[texel + 1] = g as number;
      palette[texel + 2] = b as number;
    });
  });
  return {
    bands,
    labels: Uint32Array.from(labels),
    palette,
    paletteWidth: width,
    paletteHeight: 1,
  };
}

describe('packPaletteSh', () => {
  it('round-trips palette coefficients through the packed form within quant error', () => {
    const entries = [
      [
        [0.5, -0.5, 1.0],
        [-1.0, 0.25, -0.75],
        [0.1, -0.2, 0.3],
      ],
      [
        [-2.0, 1.5, 0.0],
        [0.0, -1.25, 2.0],
        [1.0, 1.0, -1.0],
      ],
    ];
    const sh = paletteSource(1, entries, [0, 1, 0]);
    const packed = packPaletteSh(sh, 3, 1);

    expect(packed.bands).toBe(1);
    expect(packed.packed.length).toBe(3 * 3); // 3 splats × 3 coefficients
    // Symmetric range measured from the chunk's own extent (max abs = 2.0).
    expect(packed.range.max[0]).toBeCloseTo(2.0, 6);
    expect(packed.range.min[0]).toBeCloseTo(-2.0, 6);

    // One quantization step of the coarsest (10-bit green) channel.
    const step = (4.0 / 1023) * 1.01;
    for (let splat = 0; splat < 3; splat++) {
      const entry = entries[[0, 1, 0][splat] as number] as number[][];
      for (let c = 0; c < 3; c++) {
        const decoded = decodeWord(packed.packed[splat * 3 + c] as number, packed.range);
        const expected = entry[c] as number[];
        for (let ch = 0; ch < 3; ch++) {
          expect(decoded[ch]).toBeCloseTo(expected[ch] as number, 1);
          expect(Math.abs((decoded[ch] as number) - (expected[ch] as number))).toBeLessThan(step);
        }
      }
    }
  });

  it('throws on a label outside the palette instead of NaN-poisoning the range', () => {
    // Labels are 16-bit and the parser validates only the labels image, not
    // the values. Reading past the palette yields NaN coefficients, and a NaN
    // measured range - locked scene-wide if this were the first SH chunk.
    const sh = paletteSource(1, [[[1.0, -1.0, 0.5]]], [0, 700]);
    expect(() => packPaletteSh(sh, 2, 1)).toThrow(/label 700/);
  });

  it('zero-pads bands the palette lacks so the packed band count matches the pool', () => {
    // Palette carries 1 band; request 2. The extra 5 coefficients must be
    // neutral (~0), not read past the entry into garbage.
    const sh = paletteSource(1, [[[1.0, -1.0, 0.5]]], [0]);
    const packed = packPaletteSh(sh, 1, 2);

    expect(packed.bands).toBe(2);
    expect(packed.packed.length).toBe(8); // 1 splat × 8 coefficients
    // Exact 0 is not representable, but the neutral code sits within one
    // quantization step of it (range extent 1.0 → step ≈ 2/1023).
    for (let c = 3; c < 8; c++) {
      const decoded = decodeWord(packed.packed[c] as number, packed.range);
      for (const value of decoded) expect(Math.abs(value)).toBeLessThan(2 / 1023);
    }
  });
});

describe('requantizeShWord', () => {
  it('re-encodes a word so it decodes to the same value under the new range', () => {
    const from: ShRange = { min: [0, 0, 0], max: [1, 1, 1] };
    const to: ShRange = { min: [-2, -2, -2], max: [2, 2, 2] };
    // Pack the value 0.6 (all channels) under `from`.
    const packed = packShCoefficients(Float32Array.of(0.6, 0.6, 0.6), 1, 1, 1);
    const original = decodeWord(packed.packed[0] as number, from);

    const requantized = requantizeShWord(packed.packed[0] as number, from, to);
    const decoded = decodeWord(requantized, to);
    for (let ch = 0; ch < 3; ch++) {
      expect(decoded[ch]).toBeCloseTo(original[ch] as number, 2);
    }
  });

  it('clips a value outside the target range to its endpoint', () => {
    const from: ShRange = { min: [0, 0, 0], max: [10, 10, 10] };
    const to: ShRange = { min: [-1, -1, -1], max: [1, 1, 1] };
    const packed = packShCoefficients(Float32Array.of(8, 8, 8), 1, 1, 10);
    const decoded = decodeWord(requantizeShWord(packed.packed[0] as number, from, to), to);
    for (const value of decoded) expect(value).toBeCloseTo(1, 3); // clamped to to.max
  });
});

describe('packedRangesEqual', () => {
  it('compares ranges component-wise', () => {
    const a: ShRange = { min: [-1, -2, -3], max: [1, 2, 3] };
    expect(packedRangesEqual(a, { min: [-1, -2, -3], max: [1, 2, 3] })).toBe(true);
    expect(packedRangesEqual(a, { min: [-1, -2, -3], max: [1, 2, 3.5] })).toBe(false);
  });
});
