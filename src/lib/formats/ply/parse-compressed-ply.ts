import { writeCovariance, type SplatData, type SplatPackedShData } from '../../core/splat-data';
import {
  assertPlyElementFits,
  assertPlyPropertyTypes,
  plyPropertyOffset,
  type PlyHeader,
} from '../../loaders/ply-header';

/**
 * Decoder for the compressed PLY flavor written by SuperSplat / PlayCanvas
 * (and by `@playcanvas/splat-transform -c`). It is the same container as the
 * uncompressed 3DGS PLY but quantized ~10× smaller:
 *
 * - `element chunk` - one record per 256 splats, holding the float min/max
 *   bounds those splats' quantized values are interpolated across.
 * - `element vertex` - four `uint32` per splat: position and scale packed
 *   11-10-11, rotation as smallest-three (2-bit selector + 3×10 bits), and
 *   color as RGBA8.
 * - `element sh` - optional per-splat higher-order SH, one `uchar` per
 *   coefficient per channel, channel-major, quantized across [-4, 4].
 *
 * Spec: PlayCanvas's `GSplatCompressedData` is the reference implementation
 * (MIT). The decode below matches its unpacking and dequantization; the
 * implementation is original.
 */

/** Splats per `chunk` record - fixed by the format. */
const SPLATS_PER_CHUNK = 256;

/** Chunk bounds every compressed PLY carries. */
const CHUNK_BOUNDS = [
  'min_x',
  'min_y',
  'min_z',
  'max_x',
  'max_y',
  'max_z',
  'min_scale_x',
  'min_scale_y',
  'min_scale_z',
  'max_scale_x',
  'max_scale_y',
  'max_scale_z',
] as const;

/** Optional per-chunk color bounds (absent in the format's earliest writers). */
const CHUNK_COLOR_BOUNDS = ['min_r', 'min_g', 'min_b', 'max_r', 'max_g', 'max_b'] as const;

/** The four packed words that make a compressed vertex. */
const VERTEX_PROPERTIES = [
  'packed_position',
  'packed_rotation',
  'packed_scale',
  'packed_color',
] as const;

/** SH coefficient count per channel, indexed by band. */
const SH_COEFFICIENTS: Record<number, number> = { 1: 3, 2: 8, 3: 15 };

/** Bytes the `sh` element's uchar values dequantize across. */
const SH_MIN = -4;
const SH_MAX = 4;

/**
 * Whether this PLY is the compressed flavor rather than the uncompressed
 * 3DGS one. Keyed on the packed vertex properties, which no uncompressed
 * export has.
 */
export function isCompressedPly(header: PlyHeader): boolean {
  const vertex = header.element('vertex');
  return vertex !== undefined && vertex.properties.has('packed_position');
}

function unpackUnorm(value: number, bits: number): number {
  const max = (1 << bits) - 1;
  return (value & max) / max;
}

function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * t;
}

/**
 * Parses a compressed splat PLY into flat, GPU-friendly arrays.
 *
 * @param header - The already-parsed header (its element offsets locate the
 * chunk, vertex and sh records).
 * @throws {Error} if the chunk/vertex layout is not the compressed one.
 */
export function parseCompressedPly(buffer: ArrayBuffer, header: PlyHeader): SplatData {
  const chunks = header.element('chunk');
  const vertices = header.element('vertex');
  if (!chunks || !vertices) {
    throw new Error('Compressed PLY is missing its "chunk" or "vertex" element.');
  }
  assertPlyPropertyTypes(vertices, VERTEX_PROPERTIES, ['uint', 'uint32'], 'Compressed PLY vertex');
  assertPlyPropertyTypes(chunks, CHUNK_BOUNDS, ['float', 'float32'], 'Compressed PLY chunk');
  // Color bounds arrived later in the format's life; without them the packed
  // color is already the final value (the reference skips the lerp).
  const hasColorBounds = chunks.properties.has('min_r');
  if (hasColorBounds) {
    assertPlyPropertyTypes(
      chunks,
      CHUNK_COLOR_BOUNDS,
      ['float', 'float32'],
      'Compressed PLY chunk',
    );
  }

  assertPlyElementFits(chunks, buffer.byteLength);
  assertPlyElementFits(vertices, buffer.byteLength);

  const count = vertices.count;
  const neededChunks = Math.ceil(count / SPLATS_PER_CHUNK);
  if (chunks.count < neededChunks) {
    throw new Error(
      `Compressed PLY declares ${chunks.count} chunks, too few for ${count} splats ` +
        `(needs ${neededChunks} at ${SPLATS_PER_CHUNK} splats per chunk).`,
    );
  }

  const chunkView = new DataView(buffer, chunks.offset);
  const vertexView = new DataView(buffer, vertices.offset);
  const chunkAt = (chunk: number, property: string): number =>
    chunkView.getFloat32(chunk * chunks.stride + plyPropertyOffset(chunks, property), true);

  const positionOffset = plyPropertyOffset(vertices, 'packed_position');
  const rotationOffset = plyPropertyOffset(vertices, 'packed_rotation');
  const scaleOffset = plyPropertyOffset(vertices, 'packed_scale');
  const colorOffset = plyPropertyOffset(vertices, 'packed_color');

  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);

  for (let chunk = 0; chunk < neededChunks; chunk++) {
    // Chunk bounds are read once per 256 splats rather than per splat.
    const minX = chunkAt(chunk, 'min_x'),
      minY = chunkAt(chunk, 'min_y'),
      minZ = chunkAt(chunk, 'min_z');
    const maxX = chunkAt(chunk, 'max_x'),
      maxY = chunkAt(chunk, 'max_y'),
      maxZ = chunkAt(chunk, 'max_z');
    const minSx = chunkAt(chunk, 'min_scale_x'),
      minSy = chunkAt(chunk, 'min_scale_y'),
      minSz = chunkAt(chunk, 'min_scale_z');
    const maxSx = chunkAt(chunk, 'max_scale_x'),
      maxSy = chunkAt(chunk, 'max_scale_y'),
      maxSz = chunkAt(chunk, 'max_scale_z');
    const minR = hasColorBounds ? chunkAt(chunk, 'min_r') : 0;
    const minG = hasColorBounds ? chunkAt(chunk, 'min_g') : 0;
    const minB = hasColorBounds ? chunkAt(chunk, 'min_b') : 0;
    const maxR = hasColorBounds ? chunkAt(chunk, 'max_r') : 1;
    const maxG = hasColorBounds ? chunkAt(chunk, 'max_g') : 1;
    const maxB = hasColorBounds ? chunkAt(chunk, 'max_b') : 1;

    const first = chunk * SPLATS_PER_CHUNK;
    const last = Math.min(first + SPLATS_PER_CHUNK, count);
    for (let i = first; i < last; i++) {
      const base = i * vertices.stride;

      // Position: 11-10-11 unorm, interpolated across the chunk's bounds.
      const packedPosition = vertexView.getUint32(base + positionOffset, true);
      positions[i * 3 + 0] = lerp(minX, maxX, unpackUnorm(packedPosition >>> 21, 11));
      positions[i * 3 + 1] = lerp(minY, maxY, unpackUnorm(packedPosition >>> 11, 10));
      positions[i * 3 + 2] = lerp(minZ, maxZ, unpackUnorm(packedPosition, 11));

      // Color: RGB is the base color in 0..1 (the 0.5 + Y₀₀·f_dc the
      // uncompressed flavor stores unevaluated), alpha the already-activated
      // opacity - so neither needs the PLY parser's SH/sigmoid conversion.
      const packedColor = vertexView.getUint32(base + colorOffset, true);
      const r = unpackUnorm(packedColor >>> 24, 8);
      const g = unpackUnorm(packedColor >>> 16, 8);
      const b = unpackUnorm(packedColor >>> 8, 8);
      const a = unpackUnorm(packedColor, 8);
      colors[i * 4 + 0] = toByte(hasColorBounds ? lerp(minR, maxR, r) : r);
      colors[i * 4 + 1] = toByte(hasColorBounds ? lerp(minG, maxG, g) : g);
      colors[i * 4 + 2] = toByte(hasColorBounds ? lerp(minB, maxB, b) : b);
      colors[i * 4 + 3] = toByte(a);

      // Scale: 11-10-11 unorm across the chunk's bounds, in log space.
      const packedScale = vertexView.getUint32(base + scaleOffset, true);
      const scaleX = Math.exp(lerp(minSx, maxSx, unpackUnorm(packedScale >>> 21, 11)));
      const scaleY = Math.exp(lerp(minSy, maxSy, unpackUnorm(packedScale >>> 11, 10)));
      const scaleZ = Math.exp(lerp(minSz, maxSz, unpackUnorm(packedScale, 11)));

      // Rotation: "smallest three". The 2-bit selector says which component
      // was dropped (the largest, rebuilt from unit length); the other three
      // are 10-bit unorms over [-√½, +√½]. Component order is (w, x, y, z) -
      // the same convention the SOG decoder uses.
      const packedRotation = vertexView.getUint32(base + rotationOffset, true);
      const q0 = (unpackUnorm(packedRotation >>> 20, 10) - 0.5) * Math.SQRT2;
      const q1 = (unpackUnorm(packedRotation >>> 10, 10) - 0.5) * Math.SQRT2;
      const q2 = (unpackUnorm(packedRotation, 10) - 0.5) * Math.SQRT2;
      const largest = Math.sqrt(Math.max(0, 1 - (q0 * q0 + q1 * q1 + q2 * q2)));
      const [qw, qx, qy, qz] =
        packedRotation >>> 30 === 0
          ? [largest, q0, q1, q2]
          : packedRotation >>> 30 === 1
            ? [q0, largest, q1, q2]
            : packedRotation >>> 30 === 2
              ? [q0, q1, largest, q2]
              : [q0, q1, q2, largest];

      writeCovariance(covariances, i, scaleX, scaleY, scaleZ, qw, qx, qy, qz);
    }
  }

  const shPacked = decodeSh(buffer, header, count);
  return { count, positions, colors, covariances, ...(shPacked ? { shPacked } : {}) };
}

function toByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

/**
 * Decodes the optional `sh` element into the per-splat packed form.
 *
 * The file stores one uchar per (channel, coefficient), channel-major:
 * `f_rest_0…n-1` are red, then green, then blue. The packed form is
 * coefficient-major with all three channels in one word (11-10-11), so this
 * transposes as it goes. Both quantizations are unit fractions of the same
 * [-4, 4] range, so re-quantizing 8-bit into 10/11-bit fields is exact to
 * well within the source's own resolution.
 */
function decodeSh(
  buffer: ArrayBuffer,
  header: PlyHeader,
  count: number,
): SplatPackedShData | undefined {
  const sh = header.element('sh');
  if (!sh || sh.count === 0) return undefined;
  if (sh.count !== count) {
    throw new Error(`Compressed PLY "sh" element has ${sh.count} records for ${count} splats.`);
  }

  const coefficients = sh.propertyNames.length / 3;
  const bands = Number(
    Object.keys(SH_COEFFICIENTS).find((band) => SH_COEFFICIENTS[Number(band)] === coefficients),
  );
  if (!bands) {
    throw new Error(
      `Compressed PLY "sh" element has ${sh.propertyNames.length} properties, which is not ` +
        '3, 8 or 15 coefficients across three channels.',
    );
  }
  const names = Array.from({ length: coefficients * 3 }, (_, i) => `f_rest_${i}`);
  assertPlyPropertyTypes(sh, names, ['uchar', 'uint8'], 'Compressed PLY sh');
  assertPlyElementFits(sh, buffer.byteLength);

  const bytes = new Uint8Array(buffer, sh.offset);
  const offsets = names.map((name) => plyPropertyOffset(sh, name));
  const packed = new Uint32Array(count * coefficients);
  for (let i = 0; i < count; i++) {
    const base = i * sh.stride;
    for (let c = 0; c < coefficients; c++) {
      // Channel-major in the file: red coefficients, then green, then blue.
      const r = (bytes[base + (offsets[c] as number)] as number) / 255;
      const g = (bytes[base + (offsets[coefficients + c] as number)] as number) / 255;
      const b = (bytes[base + (offsets[2 * coefficients + c] as number)] as number) / 255;
      packed[i * coefficients + c] =
        (Math.round(r * 2047) | (Math.round(g * 1023) << 11) | (Math.round(b * 2047) << 21)) >>> 0;
    }
  }

  return {
    bands: bands as 1 | 2 | 3,
    packed,
    range: { min: [SH_MIN, SH_MIN, SH_MIN], max: [SH_MAX, SH_MAX, SH_MAX] },
  };
}
