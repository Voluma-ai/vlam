/**
 * Reads a whole-file scene's declared splat count from its header, without
 * downloading the scene: a few small range requests for a URL, a few small
 * slices for a local file. {@link SplatSceneBudget.plan} uses it to split a
 * budget across a batch before any file decodes.
 */
import {
  peekSogMeta,
  fetchSuffixBytes,
  MAX_ZIP_COMMENT_PLUS_EOCD,
} from '../formats/sog/peek-sog-sh';
import { parsePlyHeader } from './ply-header';
import {
  isAbortError,
  resolveSplatUrl,
  splatFormatForExtension,
  splatNameExtension,
  splatUrlExtension,
  toRequestInit,
  type SplatDataFormat,
  type SplatFormat,
  type SplatRequestOptions,
} from './loading';

/** Options for {@link peekSplatCount}. */
export interface SplatCountPeekOptions {
  baseUrl?: string | URL;
  request?: SplatRequestOptions;
  signal?: AbortSignal;
  /** Parser selection; the extension is used only for `auto`. */
  format?: SplatFormat;
}

/** PLY headers are text; every real one fits in this many bytes. */
const PLY_HEADER_BYTES = 64 * 1024;
/** Bytes per splat in the antimatter15 `.splat` layout. */
const SPLAT_RECORD_BYTES = 32;
/** The largest ranged read a peek makes, so a server that ignores the range
 * header cannot make it download the scene. */
const MAX_PEEK_BYTES = 1_048_576;

interface PeekReader {
  /** Up to `length` bytes from `start`; fewer only at the end of the input. */
  read(start: number, length: number): Promise<Uint8Array>;
  /** Exactly `length` bytes from `start`, or a throw. */
  readExact(start: number, length: number): Promise<Uint8Array>;
}

/**
 * The declared splat count of a self-contained scene file, read from its
 * header.
 *
 * @returns The count, or `undefined` when it cannot be read cheaply: an
 * unsupported or unknown format (whole-file `.rad`, legacy gzip `.spz`), a
 * server without `Range` support, or a malformed header. Never throws except
 * for an `AbortError` when `options.signal` fires.
 */
export async function peekSplatCount(
  input: string | URL | File,
  options: SplatCountPeekOptions = {},
): Promise<number | undefined> {
  try {
    options.signal?.throwIfAborted();
    if (typeof File !== 'undefined' && input instanceof File) {
      const format = resolveFormat(options.format, () =>
        splatFormatForExtension(splatNameExtension(input.name), input.name),
      );
      return await peekWithReader(format, fileReader(input), {
        size: async () => input.size,
        tail: async () => null,
      });
    }
    const url = resolveSplatUrl(input as string | URL, options.baseUrl);
    const format = resolveFormat(options.format, () =>
      splatFormatForExtension(splatUrlExtension(url), url.href),
    );
    const reader = urlReader(url.href, options.request, options.signal);
    return await peekWithReader(format, reader, {
      size: () => headContentLength(url.href, options.request, options.signal),
      tail: () =>
        fetchSuffixBytes(url.href, MAX_ZIP_COMMENT_PLUS_EOCD, options.request, options.signal),
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

function resolveFormat(
  format: SplatFormat | undefined,
  fromName: () => SplatDataFormat,
): SplatDataFormat {
  return format === undefined || format === 'auto' ? fromName() : format;
}

async function peekWithReader(
  format: SplatDataFormat,
  reader: PeekReader,
  source: {
    size(): Promise<number | null>;
    tail(): Promise<{ start: number; bytes: Uint8Array; size: number } | null>;
  },
): Promise<number | undefined> {
  switch (format) {
    case 'sog': {
      const tail = await source.tail();
      const size = tail?.size ?? (await source.size());
      if (size === null) return undefined;
      const meta = await peekSogMeta(
        (start, length) => reader.readExact(start, length),
        size,
        tail ?? undefined,
      );
      const count = (meta as { count?: unknown } | null)?.count;
      return validCount(count);
    }
    case 'ply': {
      const bytes = await reader.read(0, PLY_HEADER_BYTES);
      const header = parsePlyHeader(bytesToBuffer(bytes));
      return validCount(header.element('vertex')?.count);
    }
    case 'spz': {
      const bytes = await reader.read(0, 16);
      if (bytes.byteLength < 12) return undefined;
      // Legacy gzip SPZ hides its header inside the stream.
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) return undefined;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (view.getUint32(0, true) !== SPZ_MAGIC) return undefined;
      return validCount(view.getUint32(8, true));
    }
    case 'ksplat': {
      const bytes = await reader.read(0, 20);
      if (bytes.byteLength < 20) return undefined;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return validCount(view.getUint32(16, true));
    }
    case 'splat': {
      const size = await source.size();
      return size === null ? undefined : validCount(Math.floor(size / SPLAT_RECORD_BYTES));
    }
    case 'rad':
      return undefined;
  }
}

/** `NGSP` little-endian, the SPZ magic. */
const SPZ_MAGIC = 0x5053474e;

function validCount(count: unknown): number | undefined {
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

function bytesToBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : bytes.slice().buffer;
}

function fileReader(file: File): PeekReader {
  const read = async (start: number, length: number): Promise<Uint8Array> =>
    new Uint8Array(await file.slice(start, start + length).arrayBuffer());
  return {
    read,
    readExact: async (start, length) => {
      const bytes = await read(start, length);
      if (bytes.byteLength !== length) throw new Error('Truncated read.');
      return bytes;
    },
  };
}

function urlReader(
  url: string,
  request: SplatRequestOptions | undefined,
  signal: AbortSignal | undefined,
): PeekReader {
  const read = async (start: number, length: number): Promise<Uint8Array> => {
    if (length <= 0) return new Uint8Array(0);
    if (length > MAX_PEEK_BYTES) throw new Error('Peek range exceeds the peek size limit.');
    const response = await fetch(url, {
      ...toRequestInit(request, signal),
      headers: { ...(request?.headers ?? {}), Range: `bytes=${start}-${start + length - 1}` },
    });
    if (response.status !== 206) {
      // A 200 is the whole scene: stop it rather than download it to peek.
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Range ignored (HTTP ${response.status}).`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
  return {
    read,
    readExact: async (start, length) => {
      const bytes = await read(start, length);
      if (bytes.byteLength !== length) throw new Error('Truncated range response.');
      return bytes;
    },
  };
}

async function headContentLength(
  url: string,
  request: SplatRequestOptions | undefined,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  const response = await fetch(url, { ...toRequestInit(request, signal), method: 'HEAD' });
  if (!response.ok) return null;
  // A compressed transfer reports the compressed size, not the file's.
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding !== 'identity') return null;
  const length = Number(response.headers.get('content-length'));
  return Number.isSafeInteger(length) && length > 0 ? length : null;
}
