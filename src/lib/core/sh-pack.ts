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

/** Quantizes one signed coefficient into one packed channel field. */
function encodeShField(value: number, divisor: number, max: number): number {
  return Math.min(max, Math.max(0, Math.round((value / divisor + 1) * 0.5 * max)));
}

/** Coefficients per channel for a band count (0 → none, 3 → 3rd order). */
export function shCoefficientCount(bands: number): number {
  return [0, 3, 8, 15][bands] ?? 0;
}

/** Symmetric three-channel range used by packed per-splat SH. */
export function symmetricShRange(extent: number): ShRange {
  return {
    min: [-extent, -extent, -extent],
    max: [extent, extent, extent],
  };
}

/**
 * Packs one RGB coefficient against a scene-wide symmetric extent.
 *
 * Kept separate from {@link packShCoefficients} so fixed-stride parsers can
 * measure their extent in one pass and pack directly from source records in a
 * second pass, without retaining a full float coefficient array.
 */
export function packShCoefficient(r: number, g: number, b: number, extent: number): number {
  const divisor = extent || 1;
  return (
    (encodeShField(r, divisor, SH_FIELD_MAX[0]) |
      (encodeShField(g, divisor, SH_FIELD_MAX[1]) << 11) |
      (encodeShField(b, divisor, SH_FIELD_MAX[2]) << 21)) >>>
    0
  );
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
  const range = symmetricShRange(extent);
  const packed = new Uint32Array(count * words);
  for (let i = 0; i < packed.length; i++) {
    const base = i * 3;
    packed[i] = packShCoefficient(
      coefficients[base] as number,
      coefficients[base + 1] as number,
      coefficients[base + 2] as number,
      extent,
    );
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
 * `targetRange`, when already locked by the pool, moves that exact second
 * quantization into the shared palette before expanding its labels.
 */
export function packPaletteSh(
  sh: SplatShData,
  count: number,
  bands: 1 | 2 | 3,
  targetRange?: ShRange,
): SplatPackedShData {
  const want = shCoefficientCount(bands);
  const have = shCoefficientCount(sh.bands);
  const width = sh.paletteWidth;
  const readable = Math.min(want, have);
  const entries = new Map<number, Uint32Array>();
  let extent = 0;
  for (let i = 0; i < count; i++) {
    const label = sh.labels[i] as number;
    if (entries.has(label)) continue;
    const column0 = (label % 64) * have;
    const row = Math.floor(label / 64);
    if (column0 + have > width || (row * width + column0 + have) * 4 > sh.palette.length) {
      throw new Error(`packPaletteSh: splat ${i} has SH label ${label} outside the palette.`);
    }
    entries.set(label, new Uint32Array(want));
    for (let c = 0; c < readable; c++) {
      const texel = (row * width + column0 + c) * 4;
      extent = Math.max(
        extent,
        Math.abs(sh.palette[texel] as number),
        Math.abs(sh.palette[texel + 1] as number),
        Math.abs(sh.palette[texel + 2] as number),
      );
    }
  }
  // Measure only referenced entries, just as the former expanded float array
  // did. Unused palette extremes must not change quantization or visible color.
  // Pack each shared entry once instead of allocating count * bands * RGB
  // floats and requantizing identical coefficients for every splat.
  const sourceRange = symmetricShRange(extent);
  const convert = targetRange !== undefined && !packedRangesEqual(sourceRange, targetRange);
  const neutral = packShCoefficient(0, 0, 0, extent);
  for (const [label, words] of entries) {
    words.fill(neutral);
    const column0 = (label % 64) * have;
    const row = Math.floor(label / 64);
    for (let c = 0; c < readable; c++) {
      const texel = (row * width + column0 + c) * 4;
      words[c] = packShCoefficient(
        sh.palette[texel] as number,
        sh.palette[texel + 1] as number,
        sh.palette[texel + 2] as number,
        extent,
      );
    }
    // Preserve both quantization steps exactly, including neutral padding.
    // Converting shared palette words here avoids per-splat range conversion
    // in the renderer's bounded upload allowance.
    if (convert) {
      for (let c = 0; c < want; c++) {
        words[c] = requantizeShWord(words[c] as number, sourceRange, targetRange);
      }
    }
  }
  const packed = new Uint32Array(count * want);
  for (let i = 0; i < count; i++) {
    packed.set(entries.get(sh.labels[i] as number) as Uint32Array, i * want);
  }
  return { bands, packed, range: targetRange ?? sourceRange };
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

/** Shifted channel codes for an exact packed-SH range conversion. */
export type ShRequantizationLookup = readonly [Uint32Array, Uint32Array, Uint32Array];

/**
 * Precomputes every 11/10/11 channel code for a fixed pair of chunk/pool ranges.
 * LCC2 stages many row batches from the same chunk; lookup avoids repeating
 * range arithmetic and allocating channel arrays for every coefficient.
 */
export function createShRequantizationLookup(from: ShRange, to: ShRange): ShRequantizationLookup {
  const red = new Uint32Array(2048);
  const green = new Uint32Array(1024);
  const blue = new Uint32Array(2048);
  for (let code = 0; code < red.length; code++) {
    red[code] = requantizeShWord(code, from, to) & 0x7ff;
    blue[code] = requantizeShWord(code << 21, from, to) & 0xffe00000;
  }
  for (let code = 0; code < green.length; code++) {
    green[code] = requantizeShWord(code << 11, from, to) & 0x1ff800;
  }
  return [red, green, blue];
}
