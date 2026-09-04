import { warn } from '../../core/logging';
import { isAbortError, toRequestInit, type SplatRequestOptions } from '../../loaders/loading';
import type { SplatDatasetSource } from '../../streaming/dataset-source';

/**
 * Streamed SOG / `.lcc2` do not declare SH in the scene manifest. The pool
 * still has to know the band count *before* the first chunk decodes, because
 * packed-SH textures are allocated once. Peeking one tile's `meta.json` is
 * enough: a capture is uniform, and a miss (no `shN`, no Range support)
 * leaves SH off instead of allocating hundreds of megabytes speculatively.
 */

const MAX_ZIP_COMMENT_PLUS_EOCD = 65557;
const MAX_PEEK_BYTES = 1_048_576;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export type PaletteShBands = 0 | 1 | 2 | 3;

export interface PaletteShPeekTarget {
  readonly kind: 'json' | 'zip';
  readonly url: string;
  /** Dataset-relative path, for {@link SplatDatasetSource.size}. */
  readonly path: string;
}

/** Reads `shN.bands` from a SOG `meta.json` object. Invalid or absent → 0. */
export function sogShBandsFromMeta(json: unknown): PaletteShBands {
  if (typeof json !== 'object' || json === null) return 0;
  const shN = (json as { shN?: unknown }).shN;
  if (typeof shN !== 'object' || shN === null) return 0;
  const bands = (shN as { bands?: unknown }).bands;
  return bands === 1 || bands === 2 || bands === 3 ? bands : 0;
}

/**
 * Picks one tile to inspect: a Streamed SOG chunk `meta.json`, or an `.lcc2`
 * splat `.sog` (skipping the environment tile, which may not match the octree).
 */
export function paletteShPeekTarget(
  format: 'lcc2' | 'streamed-sog',
  json: unknown,
  source: SplatDatasetSource,
): PaletteShPeekTarget | null {
  if (typeof json !== 'object' || json === null) return null;
  if (format === 'streamed-sog') {
    const filenames = (json as { filenames?: unknown }).filenames;
    if (!Array.isArray(filenames) || typeof filenames[0] !== 'string') return null;
    const path = filenames[0].endsWith('meta.json') ? filenames[0] : `${filenames[0]}/meta.json`;
    const url = source.resolve(path);
    return url === null ? null : { kind: 'json', url, path };
  }
  const root = (json as { root?: { splatFiles?: unknown; data?: { env?: { name?: unknown } } } })
    .root;
  const files = root?.splatFiles;
  if (!Array.isArray(files) || files.length === 0) return null;
  const env = root?.data?.env?.name;
  let index = 0;
  if (typeof env === 'number') {
    const other = files.findIndex((_, fileIndex) => fileIndex !== env);
    if (other >= 0) index = other;
  }
  const path: unknown = files[index];
  if (typeof path !== 'string') return null;
  const url = source.resolve(path);
  return url === null ? null : { kind: 'zip', url, path };
}

/**
 * Resolves streamed palette SH: an explicit request wins, a `smooth` profile
 * (or any other declined cap) stays off, otherwise peek one tile.
 */
export async function resolvePaletteShBands(
  format: 'lcc2' | 'streamed-sog',
  json: unknown,
  source: SplatDatasetSource,
  requested: PaletteShBands | undefined,
  profileAllows: boolean,
  options: { request?: SplatRequestOptions; signal?: AbortSignal } = {},
): Promise<PaletteShBands> {
  if (requested !== undefined) return requested;
  if (!profileAllows) return 0;
  return detectPaletteShBands(format, json, source, options);
}

/**
 * Fetches one tile's `meta.json` (or the ZIP entry of that name) and returns
 * its SH band count. Failures other than abort are non-fatal: 0, so the load
 * still proceeds with DC color.
 */
export async function detectPaletteShBands(
  format: 'lcc2' | 'streamed-sog',
  json: unknown,
  source: SplatDatasetSource,
  options: { request?: SplatRequestOptions; signal?: AbortSignal } = {},
): Promise<PaletteShBands> {
  const target = paletteShPeekTarget(format, json, source);
  if (target === null) return 0;
  try {
    options.signal?.throwIfAborted();
    if (target.kind === 'json') {
      return sogShBandsFromMeta(await fetchJson(target.url, options.request, options.signal));
    }
    const size = await source.size(target.path);
    const read = (start: number, length: number) =>
      fetchRangeBytes(target.url, start, length, options.request, options.signal);
    if (size !== null && size > 0) return await sogShBandsFromZip(read, size);
    const tail = await fetchSuffixBytes(
      target.url,
      MAX_ZIP_COMMENT_PLUS_EOCD,
      options.request,
      options.signal,
    );
    if (tail === null) return 0;
    return await sogShBandsFromZip(read, tail.size, tail);
  } catch (error) {
    if (isAbortError(error)) throw error;
    warn('could not peek streamed SOG SH bands; leaving SH off.', error);
    return 0;
  }
}

/** Inspects a ZIP via ranged reads. Pass `tail` when a suffix fetch already ran. */
export async function sogShBandsFromZip(
  read: (start: number, length: number) => Promise<Uint8Array>,
  fileSize: number,
  tail?: { readonly start: number; readonly bytes: Uint8Array },
): Promise<PaletteShBands> {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return 0;
  const tailLength = Math.min(fileSize, MAX_ZIP_COMMENT_PLUS_EOCD);
  const tailStart = fileSize - tailLength;
  const tailBytes = tail?.bytes ?? (await read(tailStart, tailLength));
  const resolvedStart = tail?.start ?? tailStart;
  const entry = await zipMetaEntry(tailBytes, resolvedStart, fileSize, read);
  if (entry === null) return 0;
  const header = await read(entry.localOffset, 30);
  if (header.byteLength < 30 || view32(header, 0) !== LOCAL_SIGNATURE) return 0;
  const nameLength = view16(header, 26);
  const extraLength = view16(header, 28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  if (entry.compressedSize > MAX_PEEK_BYTES) return 0;
  const compressed = await read(dataStart, entry.compressedSize);
  const payload = await inflateZipPayload(compressed, entry.method);
  try {
    return sogShBandsFromMeta(JSON.parse(new TextDecoder().decode(payload)));
  } catch {
    return 0;
  }
}

interface ZipMetaEntry {
  readonly localOffset: number;
  readonly compressedSize: number;
  readonly method: number;
}

async function zipMetaEntry(
  tail: Uint8Array,
  tailStart: number,
  fileSize: number,
  read: (start: number, length: number) => Promise<Uint8Array>,
): Promise<ZipMetaEntry | null> {
  const eocd = findEocd(tail);
  if (eocd < 0) return null;
  const cdOffset = view32(tail, eocd + 16);
  const cdSize = view32(tail, eocd + 12);
  const entryCount = view16(tail, eocd + 10);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) return null;
  if (cdSize > MAX_PEEK_BYTES || cdOffset + cdSize > fileSize) return null;
  const directory =
    cdOffset >= tailStart && cdOffset + cdSize <= tailStart + tail.byteLength
      ? tail.subarray(cdOffset - tailStart, cdOffset + cdSize - tailStart)
      : await read(cdOffset, cdSize);
  if (directory.byteLength < cdSize) return null;
  let cursor = 0;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > directory.byteLength || view32(directory, cursor) !== CENTRAL_SIGNATURE) {
      return null;
    }
    const method = view16(directory, cursor + 10);
    const compressedSize = view32(directory, cursor + 20);
    const nameLength = view16(directory, cursor + 28);
    const extraLength = view16(directory, cursor + 30);
    const commentLength = view16(directory, cursor + 32);
    const localOffset = view32(directory, cursor + 42);
    if (cursor + 46 + nameLength > directory.byteLength) return null;
    const name = new TextDecoder().decode(
      directory.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name === 'meta.json' && (method === 0 || method === 8)) {
      return { localOffset, compressedSize, method };
    }
  }
  return null;
}

function findEocd(bytes: Uint8Array): number {
  const scanEnd = Math.max(0, bytes.byteLength - MAX_ZIP_COMMENT_PLUS_EOCD);
  for (let offset = bytes.byteLength - 22; offset >= scanEnd; offset--) {
    if (view32(bytes, offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

async function inflateZipPayload(compressed: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return compressed;
  const stream = new Blob([compressed as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fetchJson(
  url: string,
  request: SplatRequestOptions | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const response = await fetch(url, toRequestInit(request, signal));
  if (!response.ok) {
    await cancelBody(response);
    throw new Error(`HTTP ${response.status}`);
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(length) && length > MAX_PEEK_BYTES) {
    await cancelBody(response);
    throw new Error('meta.json is larger than the SH peek budget.');
  }
  return response.json();
}

async function fetchRangeBytes(
  url: string,
  start: number,
  length: number,
  request: SplatRequestOptions | undefined,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (length <= 0) return new Uint8Array(0);
  if (length > MAX_PEEK_BYTES) throw new Error('ZIP peek range exceeds the SH peek budget.');
  const response = await fetch(url, {
    ...toRequestInit(request, signal),
    headers: { ...(request?.headers ?? {}), Range: `bytes=${start}-${start + length - 1}` },
  });
  if (response.status !== 206) {
    await cancelBody(response);
    throw new Error(`Range ignored (HTTP ${response.status})`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength !== length) {
    throw new Error(`expected ${length} bytes, got ${buffer.byteLength}`);
  }
  return buffer;
}

async function fetchSuffixBytes(
  url: string,
  maxBytes: number,
  request: SplatRequestOptions | undefined,
  signal: AbortSignal | undefined,
): Promise<{ start: number; bytes: Uint8Array; size: number } | null> {
  const response = await fetch(url, {
    ...toRequestInit(request, signal),
    headers: { ...(request?.headers ?? {}), Range: `bytes=-${maxBytes}` },
  });
  if (response.status !== 206) {
    await cancelBody(response);
    return null;
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (match === null) return null;
  const start = Number(match[1]);
  const size = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || size <= 0) return null;
  return { start, bytes, size };
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already consumed or locked: the peek still must not throw.
  }
}

function view16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function view32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}
