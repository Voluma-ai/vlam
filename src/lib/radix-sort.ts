/**
 * @role Utility
 * Shared constants and deterministic reference logic for GPU radix sorting.
 */

/** Depth precision retained by both the GPU radix path and WebGL worker path. */
export const RADIX_KEY_BITS = 24;
/** Exact Float32 depth keys use every sortable IEEE-754 bit. */
export const RADIX_EXACT_KEY_BITS = 32;
/** Four-bit digits keep the portable shader's workgroup memory requirements small. */
export const RADIX_BITS_PER_PASS = 4;
export const RADIX_BUCKETS = 1 << RADIX_BITS_PER_PASS;
export const RADIX_PASS_COUNT = RADIX_KEY_BITS / RADIX_BITS_PER_PASS;
export const RADIX_KEY_MAX = (1 << RADIX_KEY_BITS) - 1;

/** Number of four-bit passes required for one unsigned radix key width. */
export function radixPassCount(keyBits: number): number {
  if (!Number.isInteger(keyBits) || keyBits <= 0 || keyBits % RADIX_BITS_PER_PASS !== 0) {
    throw new RangeError('Radix key width must be a positive multiple of four bits.');
  }
  return keyBits / RADIX_BITS_PER_PASS;
}

/**
 * Maps a Float32 bit pattern onto unsigned integer order without losing depth
 * precision. Ascending mapped keys are ascending numeric floats, including
 * negative view-space Z values (farther splats first in VLAM's convention).
 */
export function sortableFloat32Bits(bits: number): number {
  const value = bits >>> 0;
  return (value ^ ((value & 0x80000000) === 0 ? 0x80000000 : 0xffffffff)) >>> 0;
}

/** Quantizes a depth into the unsigned 24-bit key used by the GPU sorter. */
export function quantizeDepthKey(depth: number, minimum: number, maximum: number): number {
  const span = maximum - minimum;
  if (!Number.isFinite(depth) || !Number.isFinite(span) || span <= 0) return 0;
  return Math.min(
    RADIX_KEY_MAX,
    Math.max(0, Math.round(((depth - minimum) / span) * RADIX_KEY_MAX)),
  );
}

/**
 * Stable CPU reference for validating the GPU's six four-bit radix passes.
 * This is deliberately test/debug-only logic, not the WebGL production sorter.
 */
export function stableRadixSortReference(
  keys: Uint32Array,
  values?: Uint32Array,
  keyBits = RADIX_KEY_BITS,
): Uint32Array {
  const count = keys.length;
  let inputKeys = Uint32Array.from(keys);
  let outputKeys = new Uint32Array(count);
  let inputValues = values ? Uint32Array.from(values) : Uint32Array.from(keys.keys());
  let outputValues = new Uint32Array(count);
  const counts = new Uint32Array(RADIX_BUCKETS);
  const offsets = new Uint32Array(RADIX_BUCKETS);

  for (let pass = 0; pass < radixPassCount(keyBits); pass++) {
    counts.fill(0);
    const shift = pass * RADIX_BITS_PER_PASS;
    for (let i = 0; i < count; i++) {
      const digit = ((inputKeys[i] as number) >>> shift) & 0xf;
      counts[digit] = (counts[digit] as number) + 1;
    }
    let total = 0;
    for (let digit = 0; digit < RADIX_BUCKETS; digit++) {
      offsets[digit] = total;
      total += counts[digit] as number;
    }
    for (let i = 0; i < count; i++) {
      const key = inputKeys[i] as number;
      const digit = (key >>> shift) & 0xf;
      const target = offsets[digit] as number;
      offsets[digit] = target + 1;
      outputKeys[target] = key;
      outputValues[target] = inputValues[i] as number;
    }
    [inputKeys, outputKeys] = [outputKeys, inputKeys];
    [inputValues, outputValues] = [outputValues, inputValues];
  }
  return inputValues;
}
