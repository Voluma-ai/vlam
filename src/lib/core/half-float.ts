/** Decodes an IEEE 754 half-precision (binary16) value to a JS number. */
export function halfToFloat(value: number): number {
  const sign = value & 0x8000 ? -1 : 1;
  const exponent = (value >>> 10) & 0x1f;
  const fraction = value & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/**
 * Encodes a JS number as IEEE 754 half-precision (binary16) bits.
 *
 * Finite values outside ±65504 clamp to the half max; NaN → quiet NaN;
 * ±Infinity stay infinite. Used when packing float32 pool backing into
 * `rgba16float` GPU textures.
 */
export function floatToHalf(value: number): number {
  if (Number.isNaN(value)) return 0x7e00;
  if (!Number.isFinite(value)) return value > 0 ? 0x7c00 : 0xfc00;

  // Reinterpret as float32 bits without a DataView allocation on the hot path.
  _f32[0] = value;
  const bits = _u32[0] as number;
  const sign = (bits >>> 16) & 0x8000;
  let exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;

  // Too small for a normalized half → flush to signed zero (or denormal).
  if (exponent < 113) {
    if (exponent < 103) return sign;
    // Denormal: shift the implicit 1 into the mantissa.
    mantissa |= 0x800000;
    const shift = 113 - exponent;
    const denorm = (mantissa >>> (shift + 13)) + ((mantissa >>> (shift + 12)) & 1);
    return sign | denorm;
  }

  // Overflow → clamp to ±65504 (max finite half), not infinity: pool centers
  // and covariances that blow the half range should stay finite for sampling.
  if (exponent > 142) return sign | 0x7bff;

  // Round-to-nearest-even on the 10-bit mantissa.
  const rounded = mantissa + 0x0fff + ((mantissa >>> 13) & 1);
  if (rounded & 0x800000) {
    // Mantissa overflow into the exponent.
    exponent += 1;
    if (exponent > 142) return sign | 0x7bff;
    return sign | ((exponent - 112) << 10);
  }
  return sign | ((exponent - 112) << 10) | (rounded >>> 13);
}

/**
 * Packs `src[srcOffset..srcOffset+count)` into half bits at `dst[dstOffset..]`.
 * Lengths are in elements (floats / halfs), not bytes.
 */
export function encodeFloat32ToHalf(
  src: Float32Array,
  dst: Uint16Array,
  srcOffset = 0,
  count = src.length - srcOffset,
  dstOffset = 0,
): void {
  for (let i = 0; i < count; i++) {
    dst[dstOffset + i] = floatToHalf(src[srcOffset + i] as number);
  }
}

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
