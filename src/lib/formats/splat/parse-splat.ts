import { writeCovariance, type SplatData } from '../../splat-data';

const BYTES_PER_SPLAT = 32;
/** Mirrors `parse-sog.ts` MAX_SPLAT_COUNT - the renderer's 2²⁴ splat ceiling. */
const MAX_SPLAT_COUNT = 1 << 24;

/**
 * Parses the common 32-byte `.splat` format into flat, GPU-friendly arrays.
 *
 * Each record stores float32 position and linear scale, followed by RGBA and
 * a byte-quantized `(w, x, y, z)` quaternion.
 *
 * @throws {Error} if the input length is not a whole number of records.
 */
export function parseSplat(buffer: ArrayBuffer): SplatData {
  if (buffer.byteLength % BYTES_PER_SPLAT !== 0) {
    throw new Error(
      `Invalid SPLAT file size: ${buffer.byteLength} bytes is not divisible by ${BYTES_PER_SPLAT}.`,
    );
  }

  const count = buffer.byteLength / BYTES_PER_SPLAT;
  if (count > MAX_SPLAT_COUNT) {
    throw new Error(
      `SPLAT file declares ${count} splats, above the supported maximum of ${MAX_SPLAT_COUNT}.`,
    );
  }
  const view = new DataView(buffer);
  // The format has no magic - any 32-byte-divisible file "parses". As a cheap
  // sanity check, the first record's position must at least be finite floats.
  if (
    count > 0 &&
    (!Number.isFinite(view.getFloat32(0, true)) ||
      !Number.isFinite(view.getFloat32(4, true)) ||
      !Number.isFinite(view.getFloat32(8, true)))
  ) {
    throw new Error('Not a SPLAT file: the first record has a non-finite position.');
  }
  const bytes = new Uint8Array(buffer);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);

  for (let i = 0; i < count; i++) {
    const source = i * BYTES_PER_SPLAT;
    const position = i * 3;
    const color = i * 4;

    positions[position + 0] = view.getFloat32(source + 0, true);
    positions[position + 1] = view.getFloat32(source + 4, true);
    positions[position + 2] = view.getFloat32(source + 8, true);
    colors[color + 0] = bytes[source + 24] as number;
    colors[color + 1] = bytes[source + 25] as number;
    colors[color + 2] = bytes[source + 26] as number;
    colors[color + 3] = bytes[source + 27] as number;

    writeCovariance(
      covariances,
      i,
      view.getFloat32(source + 12, true),
      view.getFloat32(source + 16, true),
      view.getFloat32(source + 20, true),
      decodeQuaternionByte(bytes[source + 28] as number),
      decodeQuaternionByte(bytes[source + 29] as number),
      decodeQuaternionByte(bytes[source + 30] as number),
      decodeQuaternionByte(bytes[source + 31] as number),
    );
  }

  return { count, positions, colors, covariances };
}

function decodeQuaternionByte(value: number): number {
  return (value - 128) / 128;
}
