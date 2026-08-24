import { writeCovariance, type SplatData } from '../../splat-data';
import { packedRangesEqual, requantizeShWord } from '../../sh-pack';

/**
 * Decoder for XGRIDS' older LCC datasets (`.lcc` / `meta.lcc`; see
 * `docs/formats/lcc-notes.md`). Manifest versions **2.x** through **5.x** share the
 * same binary layout; v2/v3 omit `fileType` and v3 often names the manifest `meta.lcc`.
 *
 * Unlike `.lcc2` - which delivers SOG/WebP tiles and reuses {@link parseSog} -
 * an LCC dataset is raw binary: a JSON manifest, an `index.bin` of per-cell
 * per-level ranges, and one large `data.bin` of fixed 32-byte splat records
 * that chunks are cut out of with HTTP range requests.
 *
 * Implemented from XGRIDS' openly published spec (Data Organization Format
 * originated from XGRIDS); no XGRIDS code is used, and their capture data is
 * never redistributed. Where the whitepaper's field table disagrees with real
 * captures the bytes win - see `docs/formats/lcc-notes.md` for the verification.
 */

/** Bytes per splat in `data.bin`. */
export const LCC_RECORD_BYTES = 32;
/** Bytes per splat in `shcoef.bin`, and of the SH block inside an env record. */
export const LCC_SH_RECORD_BYTES = 64;
/** SH coefficients per channel in a `Quality` capture (3rd order). */
export const LCC_SH_COEFFICIENTS = 15;

/**
 * Upper bound on a decoded chunk's splat count, mirroring {@link parseSog}'s
 * guard: the renderer cannot draw more than the 2048-wide pool textures hold,
 * so a corrupt index should be rejected rather than allocate gigabytes.
 */
const MAX_CHUNK_SPLATS = 1 << 24;

/** A `[min, max]` dequantization range from the manifest's `attributes`. */
export interface LccRange {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * Where a capture's local origin sits in the real world. Purely informational
 * - the splat data is local and is rendered as-is (see `parseGeoreference`).
 */
export interface LccGeoreference {
  /** The local origin's coordinates in {@link epsg}, from manifest `offset`. */
  readonly origin: readonly [number, number, number];
  /** The projection's EPSG code, when the manifest names one. */
  readonly epsg?: number;
}

/** The manifest fields this loader consumes. */
export interface LccManifest {
  readonly totalSplats: number;
  readonly totalLevel: number;
  readonly cellLengthX: number;
  readonly cellLengthY: number;
  readonly indexDataSize: number;
  /** Per-level splat totals; index 0 is the finest level. */
  readonly splats: readonly number[];
  readonly bounds: { min: [number, number, number]; max: [number, number, number] };
  /** `Quality` captures carry `shcoef.bin`; `Portable` ones have no SH. */
  readonly fileType: 'Portable' | 'Quality';
  readonly scale: LccRange;
  readonly shcoef: LccRange;
  readonly envScale: LccRange;
  readonly envShcoef: LccRange;
  /** Set when the capture is georeferenced; absent for a purely local one. */
  readonly georeference?: LccGeoreference;
}

/** One cell's range within `data.bin` at one LOD level. */
export interface LccLevelRange {
  readonly count: number;
  readonly byteOffset: number;
  readonly byteSize: number;
}

/** One `index.bin` record: a cell of the 2D grid, at every LOD level. */
export interface LccIndexCell {
  readonly cellX: number;
  readonly cellY: number;
  /** Range per level; index 0 is the finest. */
  readonly levels: readonly LccLevelRange[];
}

/** Everything the worker needs to turn fetched bytes into splats. */
export interface LccChunkParams {
  /** `splats` decodes `data.bin`; `environment` decodes `environment.bin`. */
  readonly kind: 'splats' | 'environment';
  /** Byte range within the source file. */
  readonly start: number;
  readonly length: number;
  /**
   * Bytes per record. Always 32 in `data.bin`; `environment.bin` interleaves
   * a 64-byte SH block per splat in a `Quality` capture, making it 96.
   *
   * This is a property of the *file*, not of whether the SH is wanted - a
   * `Quality` environment stays 96 bytes per record even with SH disabled.
   */
  readonly stride: number;
  /** Dequantization range for the scale field (`scale` or `envscale`). */
  readonly scale: LccRange;
  /** Present when this chunk's SH should be decoded (see `LccShParams`). */
  readonly sh?: LccShParams;
}

/** How to obtain (and dequantize) a chunk's higher-order SH. */
export interface LccShParams {
  /** SH bands to keep: 1, 2 or 3 → 3, 8 or 15 coefficients. */
  readonly bands: 1 | 2 | 3;
  readonly range: LccRange;
  /**
   * Where the SH bytes come from. `sidecar` fetches `shcoef.bin` over the
   * given range (`data.bin` offset × 2); `inline` reads the 64-byte block
   * that follows each base record inside a 96-byte environment record.
   */
  readonly source: 'sidecar' | 'inline';
  /** Absolute `shcoef.bin` URL; only for `source: 'sidecar'`. */
  readonly url?: string;
  /**
   * Re-encode the decoded words into this range instead of {@link range}.
   *
   * An LCC capture quantizes base SH (`shcoef`) and environment SH
   * (`envshcoef`) against *different* ranges, but the shared pool decodes the
   * whole scene through one range uniform. Left alone, whichever chunk lands
   * first wins and the other's coefficients are read against the wrong span -
   * the environment range is wider, so base SH gets amplified into a
   * view-dependent "flashlight." So the environment chunk is requantized into
   * the base range here, letting every chunk agree on `shcoef`. Values outside
   * the base range clip (only decorative sky highlights, and only the few
   * thousand environment splats pay the re-encode).
   */
  readonly requantizeTo?: LccRange;
}

/** Coefficients carried by each SH band count. */
export function lccShCoefficientCount(bands: 1 | 2 | 3): number {
  return bands === 1 ? 3 : bands === 2 ? 8 : 15;
}

/**
 * Validates an untrusted `.lcc` manifest and extracts the fields the loader
 * needs. Everything downstream (index record size, chunk byte ranges, pool
 * sizing) derives from these, so they are checked up front.
 *
 * @throws {Error} on an unsupported version or a malformed manifest.
 */
export function parseLccManifest(json: unknown): LccManifest {
  const raw = json as Record<string, unknown>;
  const version = String(raw['version'] ?? '');
  // 2.x, 3.x (older L2 Pro / `meta.lcc`), 4.x and 5.x share the same binary
  // layout; 2.x and 3.x omit `fileType`, 4.x and 5.x write it. 4.x was
  // verified against a real capture (conferencehall) - its only quirk is
  // manifest `splats` counts that slightly over-declare what index.bin holds,
  // which the index cross-check in `lcc.ts` tolerates. 2.x was verified
  // against a real capture (trainmuseum): base attributes only, no
  // environment records, and every field this parser reads carries the same
  // meaning as in 3.x. Other major versions have not been verified.
  if (!/^[2345]\./.test(version)) {
    throw new Error(
      `Unsupported LCC manifest version: "${version}" (expected 2.x, 3.x, 4.x or 5.x).`,
    );
  }
  // The whitepaper defines only COMPRESS; anything else is a format we have
  // not seen and would silently mis-decode.
  const encoding = raw['encoding'];
  if (encoding !== undefined && encoding !== 'COMPRESS') {
    throw new Error(`Unsupported LCC encoding: "${String(encoding)}" (expected COMPRESS).`);
  }

  const totalLevel = raw['totalLevel'];
  if (!Number.isSafeInteger(totalLevel) || (totalLevel as number) < 1) {
    throw new Error(`LCC manifest declares an invalid totalLevel: ${String(totalLevel)}.`);
  }
  const levels = totalLevel as number;

  const indexDataSize = raw['indexDataSize'];
  const expectedIndexSize = 4 + levels * 16;
  if (indexDataSize !== expectedIndexSize) {
    throw new Error(
      `LCC manifest indexDataSize is ${String(indexDataSize)}, but ${levels} levels imply ${expectedIndexSize}.`,
    );
  }

  const splats = raw['splats'];
  if (!Array.isArray(splats) || splats.length !== levels) {
    throw new Error(`LCC manifest "splats" must list one count per level (${levels}).`);
  }
  for (const count of splats) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`LCC manifest "splats" contains an invalid count: ${String(count)}.`);
    }
  }

  const totalSplats = raw['totalSplats'];
  if (!Number.isSafeInteger(totalSplats) || (totalSplats as number) < 0) {
    throw new Error(`LCC manifest declares an invalid totalSplats: ${String(totalSplats)}.`);
  }

  const cellLengthX = numberField(raw, 'cellLengthX');
  const cellLengthY = numberField(raw, 'cellLengthY');
  if (cellLengthX <= 0 || cellLengthY <= 0) {
    throw new Error('LCC manifest cell lengths must be positive.');
  }

  // `offset` is a georeference anchor, not a transform of the splat data: it
  // names where the local origin sits in the manifest's `epsg` projection
  // (e.g. UTM easting/northing/height), while `boundingBox` and every record
  // in `data.bin` stay local. Adding it to positions would be wrong twice
  // over - it double-places the scene, and baking hundreds of kilometres into
  // float32 destroys the precision splats are rendered with. So it is carried
  // as metadata and left out of the geometry.
  const georeference = parseGeoreference(raw);

  // `shift` and `scale`, unlike `offset`, would genuinely transform the data.
  // No capture has used them, so refuse rather than place the scene wrong.
  const shift = raw['shift'];
  if (Array.isArray(shift) && shift.some((v) => v !== 0)) {
    throw new Error(
      `LCC manifest "shift" is non-zero (${JSON.stringify(shift)}), which is not supported.`,
    );
  }
  const scaleTransform = raw['scale'];
  if (Array.isArray(scaleTransform) && scaleTransform.some((v) => v !== 1)) {
    throw new Error(
      `LCC manifest "scale" is non-identity (${JSON.stringify(scaleTransform)}), which is not supported.`,
    );
  }

  const bounds = raw['boundingBox'] as { min?: unknown; max?: unknown } | undefined;
  const min = triple(bounds?.min, 'boundingBox.min');
  const max = triple(bounds?.max, 'boundingBox.max');

  const attributes = raw['attributes'];
  if (!Array.isArray(attributes)) throw new Error('LCC manifest is missing "attributes".');
  const byName = new Map<string, LccRange>();
  for (const entry of attributes as { name?: unknown; min?: unknown; max?: unknown }[]) {
    if (typeof entry?.name !== 'string') continue;
    // Opacity is 1-D; only the 3-D ranges the decoder reads are kept.
    if (!Array.isArray(entry.min) || entry.min.length < 3) continue;
    byName.set(entry.name, {
      min: triple(entry.min, `attributes.${entry.name}.min`),
      max: triple(entry.max, `attributes.${entry.name}.max`),
    });
  }
  const require = (name: string): LccRange => {
    const range = byName.get(name);
    if (!range) throw new Error(`LCC manifest is missing the "${name}" attribute range.`);
    return range;
  };

  const shcoef = byName.get('shcoef') ?? ZERO_RANGE;
  const fileType = resolveFileType(raw['fileType'], shcoef);

  return {
    totalSplats: totalSplats as number,
    totalLevel: levels,
    cellLengthX,
    cellLengthY,
    indexDataSize: expectedIndexSize,
    splats: splats as number[],
    bounds: { min, max },
    fileType,
    scale: require('scale'),
    // A Portable capture has no SH at all; keep a benign range so the type
    // stays total rather than sprinkling optionality through the loader.
    shcoef,
    envScale: byName.get('envscale') ?? ZERO_RANGE,
    envShcoef: byName.get('envshcoef') ?? ZERO_RANGE,
    georeference,
  };
}

/**
 * Reads the capture's world anchor. Absent, all-zero or unprojected (`epsg`
 * missing or 0) manifests are simply local, so they report no georeference
 * rather than a meaningless origin.
 */
function parseGeoreference(raw: Record<string, unknown>): LccGeoreference | undefined {
  const offset = raw['offset'];
  if (!Array.isArray(offset) || !offset.some((v) => v !== 0)) return undefined;
  const epsg = raw['epsg'];
  return {
    origin: triple(offset, 'offset'),
    epsg: Number.isSafeInteger(epsg) && (epsg as number) > 0 ? (epsg as number) : undefined,
  };
}

/**
 * Resolves `Portable` vs `Quality`. v5.0 writes the field; v3.0 omits it.
 * Portable manifests still list a stub `shcoef` of `[0,0,0]..[1,1,1]` (or
 * zeros); a real Quality capture has trained ranges outside that.
 */
function resolveFileType(fileType: unknown, shcoef: LccRange): 'Portable' | 'Quality' {
  if (fileType === 'Portable' || fileType === 'Quality') return fileType;
  if (fileType === undefined) return isPlaceholderShcoef(shcoef) ? 'Portable' : 'Quality';
  throw new Error(
    `Unsupported LCC fileType: "${String(fileType)}" (expected Portable or Quality).`,
  );
}

/** True when `shcoef` looks like a Portable stub rather than trained ranges. */
function isPlaceholderShcoef(range: LccRange): boolean {
  return range.min.every((v) => v === 0) && range.max.every((v) => v === 0 || v === 1);
}

const ZERO_RANGE: LccRange = { min: [0, 0, 0], max: [0, 0, 0] };

/**
 * Parses `index.bin` into one record per cell.
 *
 * @param buffer - The whole file (a few KB even for large captures).
 * @param manifest - Supplies the record size and level count.
 * @throws {Error} if the file length or any record is inconsistent.
 */
export function parseLccIndex(buffer: ArrayBuffer, manifest: LccManifest): LccIndexCell[] {
  const { indexDataSize, totalLevel } = manifest;
  if (buffer.byteLength === 0 || buffer.byteLength % indexDataSize !== 0) {
    throw new Error(
      `LCC index.bin is ${buffer.byteLength} bytes, not a multiple of indexDataSize ${indexDataSize}.`,
    );
  }
  const view = new DataView(buffer);
  const cells: LccIndexCell[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += indexDataSize) {
    const levels: LccLevelRange[] = [];
    for (let level = 0; level < totalLevel; level++) {
      const at = offset + 4 + level * 16;
      const count = view.getUint32(at, true);
      const byteOffsetBig = view.getBigUint64(at + 4, true);
      // Captures are far below 2^53 bytes; assert so a future 8 EB-addressed
      // dataset fails loudly here instead of silently losing precision.
      if (byteOffsetBig > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(
          `LCC index.bin has a byte offset beyond Number.MAX_SAFE_INTEGER: ${byteOffsetBig}.`,
        );
      }
      const byteSize = view.getUint32(at + 12, true);
      if (byteSize !== count * LCC_RECORD_BYTES) {
        throw new Error(
          `LCC index.bin level ${level} declares ${count} splats but ${byteSize} bytes ` +
            `(expected ${count * LCC_RECORD_BYTES}).`,
        );
      }
      levels.push({ count, byteOffset: Number(byteOffsetBig), byteSize });
    }
    cells.push({
      cellX: view.getUint16(offset, true),
      cellY: view.getUint16(offset + 2, true),
      levels,
    });
  }
  return cells;
}

/**
 * Decodes a packed rotation into a quaternion `[w, x, y, z]`.
 *
 * Smallest-three: bits 30-31 name the omitted (largest-magnitude) component
 * as an index into `(x, y, z, w)`, and three 10-bit fields hold the others in
 * ascending index order as offset binary with bias 511, spanning `[-√½, +√½]`.
 * The omitted component is recovered from unit length.
 *
 * Note this is neither the whitepaper's `QLut`/`DecodeRotation` nor the
 * LCC-Web SDK's sign-magnitude `parseQuat` (which decodes the SDK's own
 * repacked GPU texture, not the file) - see `docs/formats/lcc-notes.md`.
 *
 * The result is unit-length for any word a real encoder produces. A corrupt
 * word whose three stored components already exceed unit length yields a
 * non-unit (but always finite) quaternion, as in {@link parseSog}'s
 * equivalent decode; {@link writeCovariance} normalizes.
 */
export function decodeLccRotation(encoded: number): [number, number, number, number] {
  const largest = (encoded >>> 30) & 3;
  const q = [0, 0, 0, 0]; // (x, y, z, w)
  let next = 0;
  for (let index = 0; index < 4; index++) {
    if (index === largest) continue;
    const block = (encoded >>> (10 * next)) & 0x3ff;
    q[index] = (block - 511) * QUATERNION_SCALE;
    next++;
  }
  const rest =
    (q[0] as number) ** 2 + (q[1] as number) ** 2 + (q[2] as number) ** 2 + (q[3] as number) ** 2;
  q[largest] = Math.sqrt(Math.max(0, 1 - rest));
  return [q[3] as number, q[0] as number, q[1] as number, q[2] as number];
}

/** Maps a 10-bit offset-binary field onto `[-√½, +√½]`. */
const QUATERNION_SCALE = 1 / (511 * Math.SQRT2);

/**
 * Decodes one packed SH word into its three channel values.
 *
 * `DecodePacked_11_10_11`: R is bits 0-10, G bits 11-20, B bits 21-31, each a
 * unit fraction of its field's maximum, dequantized across `range`.
 */
export function decodeLccShWord(
  word: number,
  range: LccRange,
  out: Float32Array,
  at: number,
): void {
  const r = (word & 0x7ff) / 2047;
  const g = ((word >>> 11) & 0x3ff) / 1023;
  const b = ((word >>> 21) & 0x7ff) / 2047;
  out[at + 0] = lerp(range.min[0], range.max[0], r);
  out[at + 1] = lerp(range.min[1], range.max[1], g);
  out[at + 2] = lerp(range.min[2], range.max[2], b);
}

function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * t;
}

/**
 * Decodes a range of `data.bin` (or the base records of `environment.bin`)
 * into the flat arrays the pool uploads.
 *
 * @param buffer - Exactly the chunk's bytes: `count * 32` for `splats`, or
 * `count * stride` for `environment`.
 * @param params - Byte range and dequantization ranges from the scene builder.
 * @param sh - Optional SH bytes: the matching `shcoef.bin` range for
 * `source: 'sidecar'`, or unused when the SH is inline in `buffer`.
 * @param signal - Checked inside the decode loop so a superseded chunk can be
 * abandoned mid-decode.
 * @throws a `DOMException` named `AbortError` when cancelled.
 */
export async function parseLccChunk(
  buffer: ArrayBuffer,
  params: LccChunkParams,
  sh?: ArrayBuffer,
  signal?: AbortSignal,
): Promise<SplatData> {
  const stride = params.stride;
  if (stride !== LCC_RECORD_BYTES && stride !== LCC_RECORD_BYTES + LCC_SH_RECORD_BYTES) {
    throw new Error(`LCC chunk declares an unsupported ${stride}-byte record.`);
  }
  if (params.sh?.source === 'inline' && stride === LCC_RECORD_BYTES) {
    throw new Error('LCC chunk asks for inline SH but its records have no room for it.');
  }
  if (buffer.byteLength % stride !== 0) {
    throw new Error(
      `LCC chunk is ${buffer.byteLength} bytes, not a multiple of the ${stride}-byte record.`,
    );
  }
  const count = buffer.byteLength / stride;
  if (count > MAX_CHUNK_SPLATS) {
    throw new Error(
      `LCC chunk holds ${count} splats, above the supported maximum of ${MAX_CHUNK_SPLATS}.`,
    );
  }

  const view = new DataView(buffer);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  const bytes = new Uint8Array(buffer);

  const { min, max } = params.scale;
  const scaleMinX = min[0],
    scaleMinY = min[1],
    scaleMinZ = min[2];
  const scaleSpanX = max[0] - min[0],
    scaleSpanY = max[1] - min[1],
    scaleSpanZ = max[2] - min[2];

  for (let i = 0; i < count; i++) {
    // The decode loop dominates chunk time (a single cell's finest level can
    // be ~2.9M splats). With a signal, yield every 65,536 splats so a pending
    // cancel can be delivered at all - the worker is single-threaded.
    if (signal && (i & 0xffff) === 0 && i > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
    }
    const at = i * stride;

    positions[i * 3 + 0] = view.getFloat32(at, true);
    positions[i * 3 + 1] = view.getFloat32(at + 4, true);
    positions[i * 3 + 2] = view.getFloat32(at + 8, true);

    // Colors are stored exactly as the pool wants them: RGB pre-mapped through
    // 0.5 + sh·SH_C0, and alpha already activated (no sigmoid, as in SOG).
    colors[i * 4 + 0] = bytes[at + 12] as number;
    colors[i * 4 + 1] = bytes[at + 13] as number;
    colors[i * 4 + 2] = bytes[at + 14] as number;
    colors[i * 4 + 3] = bytes[at + 15] as number;

    // Scale is quantized linear (already exponentiated), unlike PLY/SOG.
    const [qw, qx, qy, qz] = decodeLccRotation(view.getUint32(at + 22, true));
    writeCovariance(
      covariances,
      i,
      scaleMinX + scaleSpanX * (view.getUint16(at + 16, true) / 65535),
      scaleMinY + scaleSpanY * (view.getUint16(at + 18, true) / 65535),
      scaleMinZ + scaleSpanZ * (view.getUint16(at + 20, true) / 65535),
      qw,
      qx,
      qy,
      qz,
    );
  }

  signal?.throwIfAborted();
  const packed = params.sh ? decodeChunkSh(buffer, sh, params.sh, count, stride) : undefined;
  return {
    count,
    positions,
    colors,
    covariances,
    ...(packed ? { shPacked: packed } : {}),
  };
}

/**
 * Extracts a chunk's SH words, keeping only the requested bands.
 *
 * The words stay packed: the shader decodes them, so this is a copy rather
 * than a 45-float-per-splat expansion. Coefficients are ordered low-band
 * first, so a lower band count is a prefix of each 16-word record.
 */
function decodeChunkSh(
  buffer: ArrayBuffer,
  sidecar: ArrayBuffer | undefined,
  params: LccShParams,
  count: number,
  stride: number,
): NonNullable<SplatData['shPacked']> {
  const coefficients = lccShCoefficientCount(params.bands);
  const packed = new Uint32Array(count * coefficients);

  if (params.source === 'inline') {
    // Environment records carry their 64-byte SH block right after the base.
    const view = new DataView(buffer);
    for (let i = 0; i < count; i++) {
      const at = i * stride + LCC_RECORD_BYTES;
      for (let c = 0; c < coefficients; c++)
        packed[i * coefficients + c] = view.getUint32(at + c * 4, true);
    }
    return finishChunkSh(packed, params);
  }

  if (!sidecar) throw new Error('LCC chunk expected shcoef.bin bytes but none were fetched.');
  const expected = count * LCC_SH_RECORD_BYTES;
  if (sidecar.byteLength !== expected) {
    throw new Error(
      `LCC shcoef.bin range is ${sidecar.byteLength} bytes; expected ${expected} for ${count} splats.`,
    );
  }
  const view = new DataView(sidecar);
  for (let i = 0; i < count; i++) {
    const at = i * LCC_SH_RECORD_BYTES;
    for (let c = 0; c < coefficients; c++)
      packed[i * coefficients + c] = view.getUint32(at + c * 4, true);
  }
  return finishChunkSh(packed, params);
}

/**
 * Tags the packed words with their range, re-encoding into
 * {@link LccShParams.requantizeTo} first when the chunk's own range differs
 * from it (the environment case - see that field's note).
 */
function finishChunkSh(
  packed: Uint32Array,
  params: LccShParams,
): NonNullable<SplatData['shPacked']> {
  const to = params.requantizeTo;
  if (!to || packedRangesEqual(params.range, to)) {
    return { bands: params.bands, packed, range: params.range };
  }
  for (let i = 0; i < packed.length; i++) {
    packed[i] = requantizeShWord(packed[i] as number, params.range, to);
  }
  return { bands: params.bands, packed, range: to };
}

function numberField(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`LCC manifest field "${key}" is not a finite number.`);
  }
  return value;
}

function triple(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3)
    throw new Error(`LCC manifest "${label}" must have three numbers.`);
  const out = value.slice(0, 3).map((v) => {
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw new Error(`LCC manifest "${label}" has a non-finite entry.`);
    return v;
  });
  return out as [number, number, number];
}
