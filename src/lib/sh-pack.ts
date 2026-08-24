/**
 * Packing and requantization for per-splat higher-order SH.
 *
 * Every streamed format that keeps view-dependent color stores it in one
 * layout: {@link SplatPackedShData}, a `DecodePacked_11_10_11` word per
 * coefficient (R: bits 0-10 /2047, G: 11-20 /1023, B: 21-31 /2047) dequantized
 * across a per-channel range. LCC `Quality` captures and `.rad` deliver it directly; a
 * streamed SOG (or `.lcc2`) palette is *converted* into it at decode
 * ({@link packPaletteSh}) so it survives the shared pool - see
 * `docs/formats/streamed-shn-notes.md` (M11). The pool decodes the whole scene through
 * one range uniform, so a chunk whose range differs is requantized into the
 * scene's range at append ({@link requantizeShWord}).
 *
 * Pure array math, no THREE - safe to import in the decode worker.
 */
import type { SplatPackedShData, SplatShData } from './splat-data';

/** A per-channel `[min, max]` dequantization range for packed SH. */
export type ShRange = SplatPackedShData['range'];

/** The 11/10/11 field maxima of a packed SH word, per channel. */
const SH_FIELD_MAX = [2047, 1023, 2047] as const;

/** Coefficients per channel for a band count (0 → none, 3 → 3rd order). */
export function shCoefficientCount(bands: number): number {
  return [0, 3, 8, 15][bands] ?? 0;
}

/**
 * Quantizes splat-major coefficient triples into packed 11/10/11 words:
 * `count * shCoefficientCount(bands)` words, each holding one coefficient's
 * (R, G, B). `knownExtent` pins the symmetric range to a scene-wide value
 * (values outside clamp); without it the extent is measured from
 * `coefficients` - only safe when they are the whole scene, since every chunk
 * must share one range.
 */
export function packShCoefficients(
  coefficients: Float32Array,
  count: number,
  bands: 1 | 2 | 3,
  knownExtent?: number,
): SplatPackedShData {
  const words = shCoefficientCount(bands);
  let extent = knownExtent ?? 0;
  if (knownExtent === undefined) {
    for (const value of coefficients) extent = Math.max(extent, Math.abs(value));
  }
  // The shader has one range for every band. A symmetric common range
  // preserves the signed SH convention; exact 0 is not representable (it falls
  // between the two middle codes, a half-LSB positive bias - see the tests).
  const range = {
    min: [-extent, -extent, -extent] as const,
    max: [extent, extent, extent] as const,
  };
  const packed = new Uint32Array(count * words);
  const divisor = extent || 1;
  for (let i = 0; i < packed.length; i++) {
    const base = i * 3;
    const encode = (value: number, max: number): number =>
      Math.min(max, Math.max(0, Math.round((value / divisor + 1) * 0.5 * max)));
    const r = encode(coefficients[base] as number, 2047);
    const g = encode(coefficients[base + 1] as number, 1023);
    const b = encode(coefficients[base + 2] as number, 2047);
    packed[i] = (r | (g << 11) | (b << 21)) >>> 0;
  }
  return { bands, packed, range };
}

/**
 * Converts a palette-compressed SH source ({@link SplatShData}, as SOG/`.lcc2`
 * store it) into the per-splat packed form, keeping the lowest `bands` bands.
 * Each splat's palette label indexes the codebook image; the coefficients are
 * read out into splat-major triples and quantized against this chunk's own
 * measured extent. Later chunks may measure a different extent - the pool
 * requantizes any mismatch into the scene's range at append.
 */
export function packPaletteSh(sh: SplatShData, count: number, bands: 1 | 2 | 3): SplatPackedShData {
  const want = shCoefficientCount(bands);
  // The palette stores its own (possibly higher) band count; a lower request is
  // a prefix of each entry's coefficients, since bands run low-order first.
  const have = shCoefficientCount(sh.bands);
  const width = sh.paletteWidth;
  const coefficients = new Float32Array(count * want * 3);
  for (let i = 0; i < count; i++) {
    const label = sh.labels[i] as number;
    // SOG centroids layout: entry n, coefficient c at column (n % 64) · have + c,
    // row ⌊n / 64⌋; R/G/B channels hold that coefficient for the R/G/B SH.
    const column0 = (label % 64) * have;
    const row = Math.floor(label / 64);
    // Labels are 16-bit and the parser validates only the labels image, not
    // the label *values*. An out-of-bounds palette read yields NaN
    // coefficients, NaN-poisoning this chunk's measured range - and, were it
    // the scene's first SH chunk, locking a NaN pool range that destroys SH
    // scene-wide. Throw instead, like the `.rad` label path does.
    // Check the row extent as well as the linear index: a label whose entry
    // would wrap past the row's end must fail rather than silently reading
    // the start of another entry on the next row.
    if (column0 + have > width || (row * width + column0 + have) * 4 > sh.palette.length) {
      throw new Error(`packPaletteSh: splat ${i} has SH label ${label} outside the palette.`);
    }
    // Read the min(want, have) low-order coefficients; if the caller asked for
    // more bands than the palette carries, the surplus stays 0 (neutral) so the
    // packed band count still matches the pool's, rather than a band mismatch
    // that would drop the SH entirely.
    const readable = Math.min(want, have);
    for (let c = 0; c < readable; c++) {
      const texel = (row * width + column0 + c) * 4;
      const base = (i * want + c) * 3;
      coefficients[base] = sh.palette[texel] as number;
      coefficients[base + 1] = sh.palette[texel + 1] as number;
      coefficients[base + 2] = sh.palette[texel + 2] as number;
    }
  }
  return packShCoefficients(coefficients, count, bands);
}

/** The packed word that decodes to 0.0 in every channel under `range`. */
export function neutralShWord(range: ShRange): number {
  const code = (lo: number, hi: number, maxCode: number): number => {
    if (hi === lo) return 0;
    const t = (0 - lo) / (hi - lo);
    return Math.max(0, Math.min(maxCode, Math.round(t * maxCode)));
  };
  return (
    (code(range.min[0], range.max[0], 2047) |
      (code(range.min[1], range.max[1], 1023) << 11) |
      (code(range.min[2], range.max[2], 2047) << 21)) >>>
    0
  );
}

/** Whether two packed-SH ranges are bit-identical (no requantization needed). */
export function packedRangesEqual(a: ShRange, b: ShRange): boolean {
  return (
    a.min[0] === b.min[0] &&
    a.min[1] === b.min[1] &&
    a.min[2] === b.min[2] &&
    a.max[0] === b.max[0] &&
    a.max[1] === b.max[1] &&
    a.max[2] === b.max[2]
  );
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Re-encodes one packed word so it decodes to the same three channel values
 * under `to` as it did under `from`. Values outside `to` clip to its endpoints;
 * a zero-width `to` channel collapses to code 0. This is what lets chunks
 * quantized against different ranges share one pool range.
 */
export function requantizeShWord(word: number, from: ShRange, to: ShRange): number {
  const codes = [word & 0x7ff, (word >>> 11) & 0x3ff, (word >>> 21) & 0x7ff];
  let out = 0;
  let shift = 0;
  for (let ch = 0; ch < 3; ch++) {
    const maxCode = SH_FIELD_MAX[ch] as number;
    const value = lerp(
      from.min[ch] as number,
      from.max[ch] as number,
      (codes[ch] as number) / maxCode,
    );
    const lo = to.min[ch] as number;
    const hi = to.max[ch] as number;
    const t = hi === lo ? 0 : (value - lo) / (hi - lo);
    const code = Math.max(0, Math.min(maxCode, Math.round(t * maxCode)));
    out |= code << shift;
    shift += ch === 0 ? 11 : 10;
  }
  return out >>> 0;
}
