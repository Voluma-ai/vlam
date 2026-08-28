import { describe, expect, it } from 'vitest';
import { encodeFloat32ToHalf, floatToHalf, halfToFloat } from '../core/half-float';

describe('floatToHalf / halfToFloat', () => {
  it('round-trips common finite values within half precision', () => {
    for (const value of [0, -0, 1, -1, 0.5, -0.5, 42, -42, 0.001, 1000, 65504, -65504]) {
      const recovered = halfToFloat(floatToHalf(value));
      // Half has ~3.3 decimal digits; allow a relative slop for larger magnitudes.
      const tol = Math.max(1e-3, Math.abs(value) * 1e-3);
      expect(Math.abs(recovered - value)).toBeLessThanOrEqual(tol);
    }
  });

  it('clamps magnitudes above the half max to ±65504', () => {
    expect(halfToFloat(floatToHalf(1e10))).toBe(65504);
    expect(halfToFloat(floatToHalf(-1e10))).toBe(-65504);
  });

  it('preserves ±Infinity and encodes NaN as a quiet NaN', () => {
    expect(halfToFloat(floatToHalf(Infinity))).toBe(Infinity);
    expect(halfToFloat(floatToHalf(-Infinity))).toBe(-Infinity);
    expect(Number.isNaN(halfToFloat(floatToHalf(Number.NaN)))).toBe(true);
  });

  it('rounds ties to nearest even', () => {
    // 1 + 2⁻¹¹ is exactly halfway between half 1.0 (mantissa 0, even) and
    // 1.0009765625 (mantissa 1, odd) - round-to-nearest-even keeps 1.0.
    expect(floatToHalf(1.00048828125)).toBe(0x3c00);
    expect(halfToFloat(floatToHalf(1.00048828125))).toBe(1);
    // 1 + 3·2⁻¹¹ is halfway between mantissas 1 and 2 - even picks 2.
    expect(floatToHalf(1.00146484375)).toBe(0x3c02);
    // Above the halfway point still rounds up.
    expect(floatToHalf(1.0005)).toBe(0x3c01);
  });

  it('encodes signed zero', () => {
    expect(floatToHalf(0)).toBe(0);
    // -0 keeps the sign bit in half.
    expect(floatToHalf(-0)).toBe(0x8000);
    expect(Object.is(halfToFloat(0x8000), -0)).toBe(true);
  });
});

describe('encodeFloat32ToHalf', () => {
  it('packs a float32 span into half bits', () => {
    const src = new Float32Array([1, 2, 3, 4]);
    const dst = new Uint16Array(4);
    encodeFloat32ToHalf(src, dst);
    expect(halfToFloat(dst[0] as number)).toBeCloseTo(1, 2);
    expect(halfToFloat(dst[3] as number)).toBeCloseTo(4, 2);
  });

  it('honors src/dst offsets and count', () => {
    const src = new Float32Array([0, 10, 20, 30]);
    const dst = new Uint16Array(6);
    encodeFloat32ToHalf(src, dst, 1, 2, 2);
    expect(dst[0]).toBe(0);
    expect(dst[1]).toBe(0);
    expect(halfToFloat(dst[2] as number)).toBeCloseTo(10, 2);
    expect(halfToFloat(dst[3] as number)).toBeCloseTo(20, 2);
  });
});
