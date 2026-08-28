/** Typed-array column decoders used by the RAD container parser. */
import { halfToFloat } from '../../core/half-float';
import type { RadChunkProperty } from './parse-rad';

function shEncodingBytes(prop: RadChunkProperty): number {
  if (prop.encoding === 'f32') return 4;
  if (prop.encoding === 'f16') return 2;
  return 1;
}

function requireRange(prop: RadChunkProperty): { min: number; max: number } {
  if (prop.min === undefined || prop.max === undefined) {
    throw new Error(`RAD "${prop.property}" (${prop.encoding}) is missing its min/max range.`);
  }
  return { min: prop.min, max: prop.max };
}

function requireMax(prop: RadChunkProperty): number {
  if (prop.max === undefined) {
    throw new Error(`RAD "${prop.property}" (${prop.encoding}) is missing its max range.`);
  }
  return prop.max;
}

/**
 * Asserts a (possibly decompressed) column physically holds one value per
 * splat per dimension before its `count`-sized output is allocated - the
 * cross-check between the untrusted chunk `count` and the actual bytes.
 */
export function assertColumnHoldsCount(
  data: Uint8Array,
  prop: RadChunkProperty,
  dims: number,
  count: number,
  bytesPerValue: number,
): void {
  if (data.byteLength < count * dims * bytesPerValue) {
    throw new Error(
      `RAD "${prop.property}" column holds ${data.byteLength} bytes, fewer than the ` +
        `${count * dims * bytesPerValue} its declared ${count} splats need.`,
    );
  }
}

export function decodeFloatColumn(
  data: Uint8Array,
  prop: RadChunkProperty,
  dims: number,
  count: number,
): Float32Array {
  assertColumnHoldsCount(data, prop, dims, count, shEncodingBytes(prop));
  switch (prop.encoding) {
    case 'f32':
      return decodeF32(data, dims, count);
    case 'f16':
      return decodeF16(data, dims, count);
    case 'f32_lebytes':
      return decodeF32LeBytes(data, dims, count);
    case 'f16_lebytes':
      return decodeF16LeBytes(data, dims, count);
    case 'r8': {
      const { min, max } = requireRange(prop);
      return decodeR8(data, dims, count, min, max);
    }
    case 'r8_delta': {
      const { min, max } = requireRange(prop);
      return decodeR8Delta(data, dims, count, min, max);
    }
    case 's8':
      return decodeS8(data, dims, count, requireMax(prop));
    case 's8_delta':
      return decodeS8Delta(data, dims, count, requireMax(prop));
    case 'ln_0r8': {
      const { min, max } = requireRange(prop);
      return decodeLn0R8(data, dims, count, min, max);
    }
    case 'ln_f16':
      return decodeLnF16(data, dims, count);
    default:
      throw new Error(`Unsupported RAD "${prop.property}" encoding "${prop.encoding}".`);
  }
}

export function decodeOrientation(
  data: Uint8Array,
  prop: RadChunkProperty,
  count: number,
): Float32Array {
  if (prop.encoding === 'oct88r8') {
    assertColumnHoldsCount(data, prop, 3, count, 1);
    return decodeQuatOct88R8(data, count);
  }
  if (prop.encoding === 'f32' || prop.encoding === 'f16') {
    assertColumnHoldsCount(data, prop, 3, count, prop.encoding === 'f32' ? 4 : 2);
  }
  const xyz =
    prop.encoding === 'f32'
      ? decodeF32(data, 3, count)
      : prop.encoding === 'f16'
        ? decodeF16(data, 3, count)
        : undefined;
  if (!xyz) throw new Error(`Unsupported RAD orientation encoding "${prop.encoding}".`);
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const x = xyz[i * 3 + 0] as number;
    const y = xyz[i * 3 + 1] as number;
    const z = xyz[i * 3 + 2] as number;
    out[i * 4 + 0] = x;
    out[i * 4 + 1] = y;
    out[i * 4 + 2] = z;
    out[i * 4 + 3] = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
  }
  return out;
}

export function decodeChildCount(
  data: Uint8Array,
  prop: RadChunkProperty,
  count: number,
): Uint16Array {
  if (prop.encoding !== 'u16') {
    throw new Error(`Unsupported RAD child_count encoding "${prop.encoding}".`);
  }
  assertColumnHoldsCount(data, prop, 1, count, 2);
  return decodeU16(data, count);
}

export function decodeChildStart(
  data: Uint8Array,
  prop: RadChunkProperty,
  count: number,
): Uint32Array {
  if (prop.encoding !== 'u32') {
    throw new Error(`Unsupported RAD child_start encoding "${prop.encoding}".`);
  }
  assertColumnHoldsCount(data, prop, 1, count, 4);
  return decodeU32(data, count);
}

const scratch = new DataView(new ArrayBuffer(4));

function bitsToFloat32(bits: number): number {
  scratch.setUint32(0, bits, true);
  return scratch.getFloat32(0, true);
}

/** Planar (column-per-dimension) little-endian f32, splat-major output. */
function decodeF32(data: Uint8Array, dims: number, count: number): Float32Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Float32Array(count * dims);
  for (let i = 0; i < count; i++) {
    let index = i * 4;
    for (let d = 0; d < dims; d++) {
      out[i * dims + d] = view.getFloat32(index, true);
      index += count * 4;
    }
  }
  return out;
}

function decodeF16(data: Uint8Array, dims: number, count: number): Float32Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Float32Array(count * dims);
  for (let i = 0; i < count; i++) {
    let index = i * 2;
    for (let d = 0; d < dims; d++) {
      out[i * dims + d] = halfToFloat(view.getUint16(index, true));
      index += count * 2;
    }
  }
  return out;
}

/** Byte-plane-transposed f32: byte `b` of every value's LE encoding is
 * grouped together (compresses better when values are similar). */
function decodeF32LeBytes(data: Uint8Array, dims: number, count: number): Float32Array {
  const stride = count * dims;
  const out = new Float32Array(count * dims);
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < dims; d++) {
      const index = count * d + i;
      const bits =
        ((data[index] as number) |
          ((data[index + stride] as number) << 8) |
          ((data[index + stride * 2] as number) << 16) |
          ((data[index + stride * 3] as number) << 24)) >>>
        0;
      out[i * dims + d] = bitsToFloat32(bits);
    }
  }
  return out;
}

function decodeF16LeBytes(data: Uint8Array, dims: number, count: number): Float32Array {
  const stride = count * dims;
  const out = new Float32Array(count * dims);
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < dims; d++) {
      const index = count * d + i;
      const bits = (data[index] as number) | ((data[index + stride] as number) << 8);
      out[i * dims + d] = halfToFloat(bits);
    }
  }
  return out;
}

/** Planar unsigned-byte, linearly dequantized across `[min, max]`. */
function decodeR8(
  data: Uint8Array,
  dims: number,
  count: number,
  min: number,
  max: number,
): Float32Array {
  const out = new Float32Array(count * dims);
  const range = max - min;
  for (let i = 0; i < count; i++) {
    let index = i;
    for (let d = 0; d < dims; d++) {
      out[i * dims + d] = ((data[index] as number) / 255) * range + min;
      index += count;
    }
  }
  return out;
}

/** Like {@link decodeR8}, but each column is a running byte-wise delta. */
function decodeR8Delta(
  data: Uint8Array,
  dims: number,
  count: number,
  min: number,
  max: number,
): Float32Array {
  const out = new Float32Array(count * dims);
  const range = max - min;
  const last = new Uint8Array(dims);
  for (let i = 0; i < count; i++) {
    let index = i;
    for (let d = 0; d < dims; d++) {
      const value = ((last[d] as number) + (data[index] as number)) & 0xff;
      last[d] = value;
      out[i * dims + d] = (value / 255) * range + min;
      index += count;
    }
  }
  return out;
}

/** Planar signed-byte, scaled by `max / 127`. */
function decodeS8(data: Uint8Array, dims: number, count: number, max: number): Float32Array {
  const out = new Float32Array(count * dims);
  for (let i = 0; i < count; i++) {
    let index = i;
    for (let d = 0; d < dims; d++) {
      const byte = data[index] as number;
      const signed = byte >= 128 ? byte - 256 : byte;
      out[i * dims + d] = (signed / 127) * max;
      index += count;
    }
  }
  return out;
}

function decodeS8Delta(data: Uint8Array, dims: number, count: number, max: number): Float32Array {
  const out = new Float32Array(count * dims);
  const last = new Uint8Array(dims);
  for (let i = 0; i < count; i++) {
    let index = i;
    for (let d = 0; d < dims; d++) {
      const value = ((last[d] as number) + (data[index] as number)) & 0xff;
      last[d] = value;
      const signed = value >= 128 ? value - 256 : value;
      out[i * dims + d] = (signed / 127) * max;
      index += count;
    }
  }
  return out;
}

/** Log-space scale: byte 0 means "zero scale", bytes 1-255 map linearly
 * across `[min, max]` in natural-log space before exponentiating back. */
function decodeLn0R8(
  data: Uint8Array,
  dims: number,
  count: number,
  min: number,
  max: number,
): Float32Array {
  const out = new Float32Array(count * dims);
  const step = (max - min) / 254;
  for (let i = 0; i < count; i++) {
    let index = i;
    for (let d = 0; d < dims; d++) {
      const byte = data[index] as number;
      out[i * dims + d] = byte === 0 ? 0 : Math.exp(min + (byte - 1) * step);
      index += count;
    }
  }
  return out;
}

function decodeLnF16(data: Uint8Array, dims: number, count: number): Float32Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Float32Array(count * dims);
  for (let i = 0; i < count; i++) {
    let index = i * 2;
    for (let d = 0; d < dims; d++) {
      out[i * dims + d] = Math.exp(halfToFloat(view.getUint16(index, true)));
      index += count * 2;
    }
  }
  return out;
}

/** Octahedral-mapped quaternion: 2 bytes for the rotation axis, 1 for the
 * half-angle. Splat-major output, 4 floats (x, y, z, w) per splat. */
function decodeQuatOct88R8(data: Uint8Array, count: number): Float32Array {
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const index = i * 3;
    const u = data[index] as number;
    const v = data[index + 1] as number;
    const r = data[index + 2] as number;
    let x = (u / 255) * 2 - 1;
    let y = (v / 255) * 2 - 1;
    const z = 1 - Math.abs(x) - Math.abs(y);
    const t = Math.max(-z, 0);
    x = x >= 0 ? x - t : x + t;
    y = y >= 0 ? y - t : y + t;
    const length = Math.hypot(x, y, z) || 1;
    const halfTheta = (r / 255) * 0.5 * Math.PI;
    const s = Math.sin(halfTheta);
    const w = Math.cos(halfTheta);
    out[i * 4 + 0] = (x / length) * s;
    out[i * 4 + 1] = (y / length) * s;
    out[i * 4 + 2] = (z / length) * s;
    out[i * 4 + 3] = w;
  }
  return out;
}

/** Planar little-endian u16. */
export function decodeU16(data: Uint8Array, count: number): Uint16Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getUint16(i * 2, true);
  return out;
}

/** Planar little-endian u32. */
export function decodeU32(data: Uint8Array, count: number): Uint32Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}
