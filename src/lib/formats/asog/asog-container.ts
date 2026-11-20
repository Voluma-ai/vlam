/**
 * The `.asog` container (Animated SOG format v1, sections 1 and 2): a 64-byte
 * header, a UTF-8 JSON manifest and a payload of zlib-compressed integer
 * streams, then an optional soundtrack.
 *
 * Ported from the MIT-licensed reference decoder of
 * [animated-sog](https://github.com/arrival-space/animated-sog)
 * (`js/src/core/container.js`, Copyright (c) 2026 Arrival.Space).
 */

/** The four magic bytes every `.asog` file starts with. */
export const ASOG_MAGIC = 'ASOG';
/** Bytes of the fixed header. */
export const ASOG_HEADER_SIZE = 64;

/**
 * The `.asog` header: where the manifest and the payload are.
 *
 * @experimental
 */
export interface AsogHeader {
  readonly manifestOffset: number;
  readonly manifestLength: number;
  /** Every manifest `byteOffset` is relative to this. */
  readonly payloadOffset: number;
  readonly payloadLength: number;
}

/**
 * One integer stream of the payload (format section 3.1).
 *
 * @experimental
 */
export interface AsogStreamDesc {
  readonly name: string;
  /** Rows: splats, or SH palette entries for `shpalette`. */
  readonly count: number;
  readonly channels: number;
  /** Bytes per value. */
  readonly planes: number;
  readonly delta: boolean;
  readonly zigzag: boolean;
  /** Relative to the payload. */
  readonly byteOffset: number;
  /** Compressed size. */
  readonly byteLength: number;
}

/**
 * One clip of a file's shared timeline (format section 5), as the TRiGS
 * timeline exporter writes it.
 *
 * @experimental
 */
export interface AsogClipDesc {
  readonly global: {
    readonly frameStart: number;
    readonly activeTimeStart: number;
    readonly activeTimeEnd: number;
    readonly coreTimeStart: number;
    readonly coreTimeEnd: number;
  };
  readonly local: { readonly frameStart: number };
  readonly render?: {
    readonly fadeInFrames?: number;
    readonly fadeOutFrames?: number;
    readonly fadeCurve?: string;
  };
}

/**
 * The quantisation parameters of the motion (format section 4.2).
 *
 * @experimental
 */
export interface AsogMotionParams {
  readonly qp: number;
  readonly qa: number;
  readonly sm: number;
  readonly midO: number;
  readonly midG: number;
  readonly mref_samples: number;
  readonly r_min: number;
}

/**
 * The JSON manifest of a version-1 `.asog` file.
 *
 * @experimental
 */
export interface AsogManifest {
  readonly format: 'asog';
  readonly version: 1;
  /** Splats. */
  readonly count: number;
  readonly timeline: { readonly frameRate: number; readonly durationSeconds: number };
  readonly clips: readonly AsogClipDesc[];
  readonly source?: { readonly format?: string; readonly version?: number };
  readonly means: { readonly mins: readonly number[]; readonly maxs: readonly number[] };
  readonly scales: { readonly codebook: readonly number[] };
  readonly sh0: { readonly codebook: readonly number[] };
  readonly shN?: {
    readonly codebook: readonly number[];
    readonly count: number;
    readonly coeffs: number;
  };
  readonly mu: { readonly scale: number };
  readonly logsigma: { readonly min: number; readonly max: number; readonly bits: number };
  readonly motion: AsogMotionParams;
  readonly audio?: {
    readonly mime: string;
    readonly byteOffset: number;
    readonly byteLength: number;
  };
  readonly streams: readonly AsogStreamDesc[];
}

/**
 * Parses the 64-byte header.
 *
 * @throws {Error} when the bytes are not an `.asog` header.
 * @experimental
 */
export function parseAsogHeader(bytes: Uint8Array): AsogHeader {
  if (bytes.length < ASOG_HEADER_SIZE) throw new Error('ASOG: the header is too short.');
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== ASOG_MAGIC) throw new Error(`ASOG: not an .asog file (magic "${magic}").`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, ASOG_HEADER_SIZE);
  const u64 = (offset: number): number => {
    const value = view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`ASOG: header field at byte ${offset} is out of range.`);
    }
    return Number(value);
  };
  return {
    manifestOffset: u64(16),
    manifestLength: u64(24),
    payloadOffset: u64(32),
    payloadLength: u64(40),
  };
}

/** Whether `bytes` start with the `.asog` magic. */
export function isAsogFile(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x41 &&
    bytes[1] === 0x53 &&
    bytes[2] === 0x4f &&
    bytes[3] === 0x47
  );
}

function fail(why: string): never {
  throw new Error(`ASOG: ${why}`);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    fail(`manifest ${label} is not a number.`);
  return value;
}

function codebook(value: unknown, label: string): void {
  const book = (value as { codebook?: unknown } | undefined)?.codebook;
  if (!Array.isArray(book) || book.length !== 256) {
    fail(`manifest ${label}.codebook must hold 256 numbers.`);
  }
}

/**
 * Parses and checks the JSON manifest: version 1, the fields decoding reads,
 * and a timeline playback can loop.
 *
 * @throws {Error} on another version or a malformed manifest.
 * @experimental
 */
export function parseAsogManifest(bytes: Uint8Array): AsogManifest {
  let manifest: AsogManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes)) as AsogManifest;
  } catch {
    fail('the manifest is not JSON.');
  }
  if (manifest?.format !== 'asog' || manifest.version !== 1) {
    fail(
      `unsupported format ${String(manifest?.format)} v${String(manifest?.version)} (VLAM reads v1).`,
    );
  }
  if (!Number.isInteger(manifest.count) || manifest.count < 0)
    fail('manifest count is not a splat count.');
  const fps = finite(manifest.timeline?.frameRate, 'timeline.frameRate');
  const duration = finite(manifest.timeline?.durationSeconds, 'timeline.durationSeconds');
  if (!(fps > 0) || !(duration > 0)) fail('the timeline needs a positive frame rate and duration.');
  if (!Array.isArray(manifest.clips) || manifest.clips.length === 0)
    fail('the manifest has no clips.');
  for (const axis of [0, 1, 2]) {
    finite(manifest.means?.mins?.[axis], `means.mins[${axis}]`);
    finite(manifest.means?.maxs?.[axis], `means.maxs[${axis}]`);
  }
  codebook(manifest.scales, 'scales');
  codebook(manifest.sh0, 'sh0');
  if (manifest.shN) codebook(manifest.shN, 'shN');
  finite(manifest.mu?.scale, 'mu.scale');
  finite(manifest.logsigma?.min, 'logsigma.min');
  finite(manifest.logsigma?.max, 'logsigma.max');
  finite(manifest.logsigma?.bits, 'logsigma.bits');
  for (const key of ['qp', 'qa', 'sm', 'midO', 'midG', 'mref_samples', 'r_min'] as const) {
    finite(manifest.motion?.[key], `motion.${key}`);
  }
  if (!(manifest.motion.mref_samples >= 2)) fail('motion.mref_samples must be at least 2.');
  if (!Array.isArray(manifest.streams)) fail('the manifest has no stream list.');
  return manifest;
}

/** SH bands (0 to 3) for SH coefficients per channel (0, 3, 8 or 15). */
export function asogShBands(coeffs: number): 0 | 1 | 2 | 3 {
  return coeffs === 3 ? 1 : coeffs === 8 ? 2 : coeffs === 15 ? 3 : 0;
}
