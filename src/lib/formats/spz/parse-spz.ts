import { ZSTDDecoder } from 'three/examples/jsm/libs/zstddec.module.js';
import { halfToFloat } from '../../half-float';
import { packShCoefficients, shCoefficientCount } from '../../sh-pack';
import { SH_C0, writeCovariance, type SplatData } from '../../splat-data';

const SPZ_MAGIC = 0x5053474e;
const LEGACY_HEADER_BYTES = 16;
const VERSION_4_HEADER_BYTES = 32;
const COLOR_SCALE = 0.15;
const SQRT_HALF = Math.SQRT1_2;
/**
 * Upper bound on the declared point count (mirrors `parse-sog.ts`
 * MAX_SPLAT_COUNT): the renderer cannot draw more than 2²⁴ splats, so a
 * hostile header is rejected before it sizes any allocation.
 */
const MAX_SAFE_POINTS = 1 << 24;
/**
 * Expansion ceiling for the legacy gzip path: header plus the largest legal
 * payload (positions 9 + alpha 1 + color 3 + scales 3 + rotation 4 + degree-3
 * SH 72 = 92 bytes per point at the maximum count), so a gzip bomb cannot
 * expand unbounded before the size checks run.
 */
const MAX_LEGACY_DECOMPRESSED_BYTES = LEGACY_HEADER_BYTES + 92 * MAX_SAFE_POINTS;
const MAX_RENDER_SH_BANDS = 3;

interface PackedSpz {
  version: number;
  count: number;
  shDegree: number;
  fractionalBits: number;
  positions: Uint8Array;
  alphas: Uint8Array;
  colors: Uint8Array;
  scales: Uint8Array;
  rotations: Uint8Array;
  sh: Uint8Array | null;
}

/**
 * Decompresses and parses an SPZ file into flat, GPU-friendly arrays.
 * Legacy gzip versions 1–3 and the current Zstandard-streamed version 4 are
 * supported. Vendor extensions are skipped, except a coordinate-system
 * extension is validated as Three.js-compatible RUB to prevent a wrong frame.
 *
 * @throws {Error} if the file is malformed, unsupported or cannot be decompressed.
 */
export async function parseSpz(buffer: ArrayBuffer): Promise<SplatData> {
  const bytes = new Uint8Array(buffer);
  const packed =
    bytes[0] === 0x1f && bytes[1] === 0x8b
      ? parseLegacySpz(await decompressGzip(bytes))
      : await parseVersion4Spz(bytes);
  return unpackSpz(packed);
}

async function parseVersion4Spz(bytes: Uint8Array): Promise<PackedSpz> {
  if (bytes.byteLength < VERSION_4_HEADER_BYTES) throw new Error('Truncated SPZ v4 header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SPZ_MAGIC) throw new Error('Not an SPZ file.');
  const version = view.getUint32(4, true);
  if (version !== 4) throw new Error(`Unsupported SPZ version ${version}.`);
  const count = view.getUint32(8, true);
  const shDegree = view.getUint8(12);
  const fractionalBits = view.getUint8(13);
  const flags = view.getUint8(14);
  const streamCount = view.getUint8(15);
  const tocOffset = view.getUint32(16, true);
  validateSpzHeader(count, shDegree, fractionalBits);
  if ((flags & 0x02) !== 0) validateExtensions(view, VERSION_4_HEADER_BYTES, tocOffset);

  const rotationBytes = count * 4;
  const expectedSizes = [count * 9, count, count * 3, count * 3, rotationBytes];
  if (shDegree > 0) expectedSizes.push(count * shDimension(shDegree) * 3);
  if (streamCount !== expectedSizes.length) {
    throw new Error(`Invalid SPZ stream count ${streamCount}; expected ${expectedSizes.length}.`);
  }
  const tocEnd = tocOffset + streamCount * 16;
  if (tocOffset < VERSION_4_HEADER_BYTES || tocEnd > bytes.byteLength) {
    throw new Error('Invalid SPZ table of contents.');
  }

  const decoder = new ZSTDDecoder();
  await decoder.init();
  const streams: Uint8Array[] = [];
  let compressedOffset = tocEnd;
  for (let i = 0; i < streamCount; i++) {
    const entry = tocOffset + i * 16;
    const compressedSize = safeUint64(view, entry);
    const uncompressedSize = safeUint64(view, entry + 8);
    if (uncompressedSize !== expectedSizes[i]) {
      throw new Error(
        `Invalid SPZ stream ${i} size ${uncompressedSize}; expected ${expectedSizes[i]}.`,
      );
    }
    if (compressedOffset + compressedSize > bytes.byteLength) {
      throw new Error(`Truncated SPZ stream ${i}.`);
    }
    const compressed = bytes.subarray(compressedOffset, compressedOffset + compressedSize);
    const decoded = decoder.decode(compressed, uncompressedSize);
    if (decoded.byteLength !== uncompressedSize) {
      throw new Error(`SPZ stream ${i} decompressed to an unexpected size.`);
    }
    streams.push(decoded);
    compressedOffset += compressedSize;
  }
  if (compressedOffset !== bytes.byteLength) throw new Error('Unexpected trailing SPZ data.');

  return {
    version,
    count,
    shDegree,
    fractionalBits,
    positions: streams[0] as Uint8Array,
    alphas: streams[1] as Uint8Array,
    colors: streams[2] as Uint8Array,
    scales: streams[3] as Uint8Array,
    rotations: streams[4] as Uint8Array,
    sh: shDegree > 0 ? (streams[5] as Uint8Array) : null,
  };
}

function parseLegacySpz(bytes: Uint8Array): PackedSpz {
  if (bytes.byteLength < LEGACY_HEADER_BYTES) throw new Error('Truncated SPZ header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SPZ_MAGIC) throw new Error('Not an SPZ file.');
  const version = view.getUint32(4, true);
  if (version < 1 || version > 3) throw new Error(`Unsupported SPZ version ${version}.`);
  const count = view.getUint32(8, true);
  const shDegree = view.getUint8(12);
  const fractionalBits = view.getUint8(13);
  const flags = view.getUint8(14);
  validateSpzHeader(count, shDegree, fractionalBits);

  const positionBytes = count * 3 * (version === 1 ? 2 : 3);
  const rotationBytes = count * (version >= 3 ? 4 : 3);
  const shBytes = count * shDimension(shDegree) * 3;
  const expectedBytes =
    LEGACY_HEADER_BYTES + positionBytes + count + count * 3 + count * 3 + rotationBytes + shBytes;
  if (
    bytes.byteLength < expectedBytes ||
    ((flags & 0x02) === 0 && bytes.byteLength !== expectedBytes)
  ) {
    throw new Error(`Invalid SPZ payload size ${bytes.byteLength}; expected ${expectedBytes}.`);
  }
  if ((flags & 0x02) !== 0) validateExtensions(view, expectedBytes, bytes.byteLength);

  let offset = LEGACY_HEADER_BYTES;
  const take = (length: number): Uint8Array => {
    const result = bytes.subarray(offset, offset + length);
    offset += length;
    return result;
  };
  return {
    version,
    count,
    shDegree,
    fractionalBits,
    positions: take(positionBytes),
    alphas: take(count),
    colors: take(count * 3),
    scales: take(count * 3),
    rotations: take(rotationBytes),
    sh: shDegree > 0 ? take(shBytes) : null,
  };
}

function unpackSpz(packed: PackedSpz): SplatData {
  const positions = new Float32Array(packed.count * 3);
  const colors = new Uint8Array(packed.count * 4);
  const covariances = new Float32Array(packed.count * 6);
  const positionView = new DataView(
    packed.positions.buffer,
    packed.positions.byteOffset,
    packed.positions.byteLength,
  );
  const rotationStride = packed.version >= 3 ? 4 : 3;

  for (let i = 0; i < packed.count; i++) {
    for (let axis = 0; axis < 3; axis++) {
      positions[i * 3 + axis] =
        packed.version === 1
          ? halfToFloat(positionView.getUint16((i * 3 + axis) * 2, true))
          : readSigned24(packed.positions, (i * 3 + axis) * 3) / 2 ** packed.fractionalBits;
    }

    for (let channel = 0; channel < 3; channel++) {
      const encoded = packed.colors[i * 3 + channel] as number;
      const linear = ((encoded / 255 - 0.5) / COLOR_SCALE) * SH_C0 + 0.5;
      colors[i * 4 + channel] = clampByte(Math.round(linear * 255));
    }
    colors[i * 4 + 3] = packed.alphas[i] as number;

    const quaternion =
      packed.version >= 3
        ? decodeSmallestThree(packed.rotations, i * rotationStride)
        : decodeFirstThree(packed.rotations, i * rotationStride);
    writeCovariance(
      covariances,
      i,
      Math.exp((packed.scales[i * 3 + 0] as number) / 16 - 10),
      Math.exp((packed.scales[i * 3 + 1] as number) / 16 - 10),
      Math.exp((packed.scales[i * 3 + 2] as number) / 16 - 10),
      quaternion[3],
      quaternion[0],
      quaternion[1],
      quaternion[2],
    );
  }

  const shPacked = decodeSpzSh(packed);
  return {
    count: packed.count,
    positions,
    colors,
    covariances,
    ...(shPacked ? { shPacked } : {}),
  };
}

/** Dequantizes SPZ SH bytes into per-splat packed form (coefficient-major RGB). */
function decodeSpzSh(packed: PackedSpz): SplatData['shPacked'] {
  if (!packed.sh || packed.shDegree === 0) return undefined;
  const bands = Math.min(packed.shDegree, MAX_RENDER_SH_BANDS) as 1 | 2 | 3;
  const coeffs = shCoefficientCount(bands);
  const components = coeffs * 3;
  const coefficients = new Float32Array(packed.count * components);
  for (let i = 0; i < packed.count; i++) {
    const source = i * shDimension(packed.shDegree) * 3;
    const dest = i * components;
    for (let c = 0; c < components; c++) {
      const encoded = packed.sh[source + c] as number;
      coefficients[dest + c] = (encoded - 128) / 128;
    }
  }
  return packShCoefficients(coefficients, packed.count, bands);
}

async function decompressGzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'This runtime does not provide gzip decompression required for legacy SPZ files.',
    );
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  // Read incrementally with an expansion cap, so a gzip bomb fails fast
  // instead of expanding unbounded before the payload size checks run.
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_LEGACY_DECOMPRESSED_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('SPZ gzip payload expands past the supported maximum size.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function validateSpzHeader(count: number, shDegree: number, fractionalBits: number): void {
  if (count === 0 || count > MAX_SAFE_POINTS) throw new Error(`Invalid SPZ point count ${count}.`);
  if (shDegree < 0 || shDegree > 4) throw new Error(`Unsupported SPZ SH degree ${shDegree}.`);
  if (fractionalBits > 24) throw new Error(`Invalid SPZ fractional bit count ${fractionalBits}.`);
}

function shDimension(degree: number): number {
  return degree === 0 ? 0 : degree === 1 ? 3 : degree === 2 ? 8 : degree === 3 ? 15 : 24;
}

function safeUint64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('SPZ stream size exceeds JavaScript limits.');
  return Number(value);
}

function validateExtensions(view: DataView, start: number, end: number): void {
  if (start > end || end > view.byteLength) throw new Error('Invalid SPZ extension block.');
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) throw new Error('Truncated SPZ extension header.');
    const type = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + length > end) throw new Error('Truncated SPZ extension payload.');
    if (type === 0xadbe0003) {
      if (length !== 4) throw new Error('Invalid SPZ coordinate-system extension.');
      const coordinateSystem = view.getUint32(offset, true);
      if (coordinateSystem !== 4) {
        throw new Error(
          `SPZ coordinate system ${coordinateSystem} is not supported; expected RUB (4).`,
        );
      }
    }
    offset += length;
  }
}

function readSigned24(bytes: Uint8Array, offset: number): number {
  const value =
    (bytes[offset] as number) |
    ((bytes[offset + 1] as number) << 8) |
    ((bytes[offset + 2] as number) << 16);
  return value & 0x800000 ? value | 0xff000000 : value;
}

function decodeFirstThree(
  bytes: Uint8Array,
  offset: number,
): readonly [number, number, number, number] {
  const x = (bytes[offset] as number) / 127.5 - 1;
  const y = (bytes[offset + 1] as number) / 127.5 - 1;
  const z = (bytes[offset + 2] as number) / 127.5 - 1;
  return [x, y, z, Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z))];
}

function decodeSmallestThree(
  bytes: Uint8Array,
  offset: number,
): readonly [number, number, number, number] {
  let packed =
    ((bytes[offset] as number) |
      ((bytes[offset + 1] as number) << 8) |
      ((bytes[offset + 2] as number) << 16) |
      ((bytes[offset + 3] as number) << 24)) >>>
    0;
  const largest = packed >>> 30;
  const quaternion = [0, 0, 0, 0];
  let sumSquares = 0;
  for (let component = 3; component >= 0; component--) {
    if (component === largest) continue;
    const magnitude = packed & 0x1ff;
    const sign = (packed >>> 9) & 1 ? -1 : 1;
    const value = sign * SQRT_HALF * (magnitude / 0x1ff);
    quaternion[component] = value;
    sumSquares += value * value;
    packed >>>= 10;
  }
  quaternion[largest] = Math.sqrt(Math.max(0, 1 - sumSquares));
  return [
    quaternion[0] as number,
    quaternion[1] as number,
    quaternion[2] as number,
    quaternion[3] as number,
  ];
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value));
}
