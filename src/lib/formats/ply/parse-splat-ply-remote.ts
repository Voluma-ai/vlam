import { packShCoefficient } from '../../core/sh-pack';
import type { SplatData, SplatPackedShData } from '../../core/splat-data';
import { isCompressedPly } from './parse-compressed-ply';
import { parsePlyHeader } from '../../loaders/ply-header';
import { PLY_TEMP_DIRECTORY } from '../../loaders/ply-temp-constants';
import {
  STREAM_WINDOW_BYTES,
  allocate,
  allocatePackedRest,
  decodeRecords,
  finalizePlyDecode,
  measureRestExtent,
  parseSplatPly,
  requireSplatVertexElement,
  restLayout,
  vertexOffsets,
  writePackedRest,
  type RestLayout,
} from './parse-splat-ply';

const HEADER_LIMIT = 64 * 1024;
const SAMPLE_LIMIT = 65_536;

export interface RemotePlyMetrics {
  mode: 'exact-stream' | 'approximate-sh-stream';
  inputBytes: number;
  peakInputBytes: number;
  temporaryDiskBytes: number;
  shExtent: number;
  clippedCoefficients: number;
  clippedSplats: number;
  bufferedFallback: boolean;
}

export interface RemotePlyResult {
  data: SplatData;
  metrics: RemotePlyMetrics;
}

/**
 * Incrementally decodes uncompressed fixed-stride PLY records. The only input
 * reservoir is a reusable 64 MiB window plus the at-most-64 KiB header. The
 * final decoded arrays are deliberately separate from the source-buffer peak.
 */
export async function parseSplatPlyRemote(
  response: Response,
  options: {
    mode: 'exact-stream' | 'approximate-sh-stream';
    signal: AbortSignal;
    resourceId?: string;
    windowBytes?: number;
    onProgress?: (loaded: number, total: number) => void;
  },
): Promise<RemotePlyResult> {
  const { mode, signal, onProgress } = options;
  if (!response.body) throw new Error('Remote PLY response has no readable body.');
  const declared = Number(response.headers.get('Content-Length'));
  const encoding = response.headers.get('Content-Encoding');
  const total =
    (encoding === null || /^identity$/i.test(encoding.trim())) &&
    Number.isSafeInteger(declared) &&
    declared > 0
      ? declared
      : 0;
  const reader = response.body.getReader();
  let loaded = 0;
  let largestChunk = 0;
  let peakInputBytes = 0;
  const read = async (): Promise<Uint8Array | null> => {
    signal.throwIfAborted();
    const next = await reader.read();
    if (next.done) return null;
    loaded += next.value.byteLength;
    largestChunk = Math.max(largestChunk, next.value.byteLength);
    // Intermediaries can hide Content-Encoding while exposing the encoded
    // Content-Length; the body reader yields decoded bytes in that case.
    onProgress?.(loaded, total > 0 && loaded > total ? 0 : total);
    return next.value;
  };

  try {
    onProgress?.(0, total);
    const head = new Uint8Array(HEADER_LIMIT);
    let headLength = 0;
    let initialTail: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let headerEnd = -1;
    for (;;) {
      const chunk = await read();
      if (!chunk) throw new Error('Truncated PLY header.');
      // A network chunk may also contain records. Copy only the header-sized
      // prefix and retain the remainder as the first record input.
      const prefix = Math.min(chunk.byteLength, HEADER_LIMIT - headLength);
      head.set(chunk.subarray(0, prefix), headLength);
      headLength += prefix;
      initialTail = chunk.subarray(prefix);
      const match = /end_header\r?\n/.exec(
        new TextDecoder('ascii').decode(head.subarray(0, headLength)),
      );
      if (match) {
        headerEnd = match.index + match[0].length;
        break;
      }
      if (headLength === HEADER_LIMIT) throw new Error('PLY header exceeds the 64 KiB limit.');
    }
    const header = parsePlyHeader(head.slice(0, headerEnd).buffer);
    // Compressed PLY retains its current whole-buffer decoder. This is an
    // explicit effective fallback, rather than attempting fixed-stride decode.
    if (isCompressedPly(header)) {
      const chunks: Uint8Array[] = [head.slice(0, headLength)];
      if (initialTail.length) chunks.push(initialTail);
      for (;;) {
        const chunk = await read();
        if (!chunk) break;
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(loaded);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      if (at !== loaded) throw new Error('Compressed PLY fallback lost bytes.');
      return {
        data: parseSplatPly(bytes.buffer),
        metrics: {
          mode,
          inputBytes: loaded,
          peakInputBytes: loaded,
          temporaryDiskBytes: 0,
          shExtent: 0,
          clippedCoefficients: 0,
          clippedSplats: 0,
          bufferedFallback: true,
        },
      };
    }

    const vertices = requireSplatVertexElement(header);
    if (vertices.offset < 0) throw new Error('PLY vertex records follow a variable-size element.');
    const { count, stride, offset } = vertices;
    const vertexEnd = offset + count * stride;
    if (!Number.isSafeInteger(vertexEnd) || stride <= 0)
      throw new Error('Unsafe PLY vertex allocation.');
    const windowBytes = options.windowBytes ?? STREAM_WINDOW_BYTES;
    if (
      !Number.isSafeInteger(windowBytes) ||
      windowBytes < stride ||
      windowBytes > STREAM_WINDOW_BYTES
    )
      throw new Error('Invalid remote PLY decode window.');
    const capacity = Math.max(
      stride,
      Math.floor(Math.min(windowBytes, count * stride) / stride) * stride,
    );
    const window = new Uint8Array(capacity);
    const out = allocate(count);
    const offsets = vertexOffsets(vertices);
    const rest = restLayout(vertices);
    const sampleCount =
      rest && mode === 'approximate-sh-stream' ? Math.min(SAMPLE_LIMIT, count) : 0;
    const sample =
      rest && sampleCount > 0 ? new Float32Array(sampleCount * rest.coefficients * 3) : null;
    let sampleExtent = 0;
    let extent = 0;
    let shPacked: SplatPackedShData | undefined;
    let clippedCoefficients = 0;
    let clippedSplats = 0;
    let decoded = 0;
    let filled = 0;
    let streamAt = 0;
    let diskBytes = 0;

    const decodeWindow = async (write?: FileSystemWritableFileStream): Promise<void> => {
      const records = Math.floor(filled / stride);
      if (records === 0) return;
      const bytes = records * stride;
      const view = new DataView(window.buffer, 0, bytes);
      const last = decoded + records;
      decodeRecords(view, offsets, stride, decoded, decoded, last, out);
      if (rest && mode === 'exact-stream') {
        extent = measureRestExtent(view, stride, decoded, decoded, last, rest, extent);
        if (!write) throw new Error('Exact remote SH needs a temporary-file writer.');
        await write.write(window.subarray(0, bytes));
        diskBytes += bytes;
      }
      if (rest && mode === 'approximate-sh-stream') {
        const sampleLast = Math.min(last, sampleCount);
        if (sample && decoded < sampleLast) {
          for (let i = decoded; i < sampleLast; i++) {
            const base = (i - decoded) * stride;
            for (let c = 0; c < rest.coefficients * 3; c++) {
              const value = view.getFloat32(base + rest.offsets[c]!, true);
              sample[i * rest.coefficients * 3 + c] = value;
              sampleExtent = Math.max(sampleExtent, Math.abs(value));
            }
          }
        }
        if (!shPacked && last >= sampleCount) {
          extent = Math.max(sampleExtent * 1.25, 1e-8);
          shPacked = allocatePackedRest(count, rest, extent);
          if (sample) packSample(sample, sampleCount, rest, extent, shPacked.packed);
        }
        if (shPacked && last > sampleCount) {
          const from = Math.max(decoded, sampleCount);
          writePackedRest(view, stride, decoded, from, last, rest, extent, shPacked.packed);
          const clipping = countClipping(view, stride, decoded, from, last, rest, extent);
          clippedCoefficients += clipping.coefficients;
          clippedSplats += clipping.splats;
        }
      }
      decoded = last;
      window.copyWithin(0, bytes, filled);
      filled -= bytes;
      peakInputBytes = Math.max(
        peakInputBytes,
        capacity + headLength + (sample?.byteLength ?? 0) + largestChunk,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
    };

    const consume = async (
      chunk: Uint8Array,
      write?: FileSystemWritableFileStream,
    ): Promise<void> => {
      let at = 0;
      while (at < chunk.length) {
        if (streamAt < offset) {
          const skip = Math.min(chunk.length - at, offset - streamAt);
          at += skip;
          streamAt += skip;
          continue;
        }
        if (streamAt >= vertexEnd) {
          streamAt += chunk.length - at;
          return;
        }
        const take = Math.min(chunk.length - at, capacity - filled, vertexEnd - streamAt);
        window.set(chunk.subarray(at, at + take), filled);
        filled += take;
        at += take;
        streamAt += take;
        if (filled === capacity) await decodeWindow(write);
      }
    };

    const finish = async (write?: FileSystemWritableFileStream): Promise<RemotePlyResult> => {
      await decodeWindow(write);
      peakInputBytes = Math.max(
        peakInputBytes,
        capacity + headLength + (sample?.byteLength ?? 0) + largestChunk,
      );
      if (decoded !== count || filled !== 0)
        throw new Error(`Truncated PLY vertex records: decoded ${decoded} of ${count}.`);
      if (rest && mode === 'approximate-sh-stream' && !shPacked) {
        extent = Math.max(sampleExtent * 1.25, 1e-8);
        shPacked = allocatePackedRest(count, rest, extent);
        if (sample) packSample(sample, sampleCount, rest, extent, shPacked.packed);
      }
      return {
        data: finalizePlyDecode(count, out, shPacked),
        metrics: {
          mode,
          inputBytes: loaded,
          peakInputBytes,
          temporaryDiskBytes: diskBytes,
          shExtent: extent,
          clippedCoefficients,
          clippedSplats,
          bufferedFallback: false,
        },
      };
    };

    const drain = async (write?: FileSystemWritableFileStream): Promise<RemotePlyResult> => {
      // Re-feed the header-sized prefix, including bytes from any preceding
      // fixed-size elements. This keeps absolute offsets simple and exact.
      await consume(head.subarray(0, headLength), write);
      if (initialTail.length) await consume(initialTail, write);
      for (;;) {
        const chunk = await read();
        if (!chunk) break;
        await consume(chunk, write);
      }
      return finish(write);
    };

    if (!rest || mode === 'approximate-sh-stream') return await drain();
    if (!options.resourceId || !/^[a-zA-Z0-9-]{1,100}$/.test(options.resourceId))
      throw new Error('Exact remote SH requires an opaque temporary resource ID.');
    if (!navigator.storage?.getDirectory || !navigator.locks?.request)
      throw new Error('Exact remote SH requires OPFS and Web Locks.');
    const id = options.resourceId;
    return await navigator.locks.request(`vlam-ply-${id}`, { mode: 'exclusive' }, async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(PLY_TEMP_DIRECTORY, { create: true });
      const handle = await dir.getFileHandle(id, { create: true });
      let writer: FileSystemWritableFileStream | undefined;
      try {
        writer = await handle.createWritable();
        const result = await drain(writer);
        await writer.close();
        writer = undefined;
        const file = await handle.getFile();
        if (file.size !== count * stride)
          throw new Error('Temporary PLY vertex file is truncated.');
        shPacked = allocatePackedRest(count, rest, extent);
        const perWindow = Math.max(1, Math.floor(windowBytes / stride));
        for (let first = 0; first < count; first += perWindow) {
          signal.throwIfAborted();
          const last = Math.min(count, first + perWindow);
          const slice = file.slice(first * stride, last * stride);
          const view = new DataView(await slice.arrayBuffer());
          writePackedRest(view, stride, first, first, last, rest, extent, shPacked.packed);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        result.data = finalizePlyDecode(count, out, shPacked);
        return result;
      } finally {
        if (writer) await writer.abort().catch(() => undefined);
        await dir.removeEntry(id).catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
        });
      }
    });
  } finally {
    reader.releaseLock();
  }
}

function packSample(
  sample: Float32Array,
  count: number,
  rest: RestLayout,
  extent: number,
  packed: Uint32Array,
): void {
  const coeff = rest.coefficients;
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < coeff; c++) {
      const base = i * coeff * 3;
      packed[i * coeff + c] = packShCoefficient(
        sample[base + c]!,
        sample[base + coeff + c]!,
        sample[base + 2 * coeff + c]!,
        extent,
      );
    }
  }
}

function countClipping(
  view: DataView,
  stride: number,
  viewFirst: number,
  from: number,
  to: number,
  rest: RestLayout,
  extent: number,
): { coefficients: number; splats: number } {
  let coefficients = 0;
  let splats = 0;
  for (let i = from; i < to; i++) {
    let clipped = false;
    const base = (i - viewFirst) * stride;
    for (const offset of rest.offsets) {
      if (Math.abs(view.getFloat32(base + offset, true)) > extent) {
        coefficients++;
        clipped = true;
      }
    }
    if (clipped) splats++;
  }
  return { coefficients, splats };
}
