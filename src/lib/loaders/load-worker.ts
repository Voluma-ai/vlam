import { parseSplatPly, parseSplatPlyFile } from '../formats/ply/parse-splat-ply';
import { parseSog, parseSogDirectory } from '../formats/sog/parse-sog';
import { parseRad, parseRadChunkStreaming } from '../formats/rad/parse-rad';
import { parseLccChunk, type LccChunkParams } from '../formats/lcc/parse-lcc';
import { packPaletteSh } from '../core/sh-pack';
import type { SplatData } from '../core/splat-data';
import { fetchBuffer, fetchRange, stripFragment } from './worker-fetch';
import { serveLoadRequests } from './worker-host';
import {
  isAbortError,
  readWholeFile,
  toSplatLoadError,
  type ChunkFileFormat,
  type SplatProgressCallback,
} from './loading';

/**
 * Persistent Web Worker that fetches and decodes streamed splat scenes and
 * chunks off the main thread.
 *
 * This worker is inlined into `@voluma/vlam/loaders` (`?worker&inline` in
 * `chunk-loader.ts`), so every parser it imports is a string literal in
 * `dist/loaders.js` that no consumer's bundler can tree-shake. It therefore
 * carries only the formats the streaming paths need: `rad-chunk`, `lcc-bin`,
 * unbundled SOG directories, and PLY (whose local-file path is streamed). The
 * one-shot whole-file formats - `.spz`, `.splat`, `.ksplat` - live in
 * `one-shot-worker.ts`, which `ChunkLoader` loads on demand; that is what keeps
 * SPZ's ~39 KB ZSTD wasm blob out of the loaders entry.
 */

export type {
  LoadWorkerSource,
  LoadWorkerRequest,
  RadChunkRangeRequest,
  LoadWorkerResponse,
} from './load-worker-protocol';
import type { LoadWorkerSource, RadChunkRangeRequest } from './load-worker-protocol';

serveLoadRequests((message, signal, onProgress) =>
  load(
    message.source,
    message.format,
    signal,
    message.lcc,
    message.rad,
    message.files,
    message.sog,
    onProgress,
  ),
);

async function load(
  source: LoadWorkerSource,
  format: ChunkFileFormat,
  signal: AbortSignal,
  lcc?: LccChunkParams,
  rad?: RadChunkRangeRequest,
  files?: Readonly<Record<string, string>>,
  sog?: { packShBands: 1 | 2 | 3 },
  onProgress?: SplatProgressCallback,
): Promise<SplatData> {
  if (source.from === 'url' && source.kind === 'directory') {
    const data = await parseSogDirectory(source.url, {
      signal,
      ...(source.request ? { request: source.request } : {}),
      ...(files ? { files } : {}),
    });
    return sog ? packSogShN(data, sog.packShBands) : data;
  }
  if (format === 'lcc-bin') {
    if (source.from !== 'url') throw new Error('LCC chunks must be loaded from a URL.');
    if (!lcc) throw new Error('LCC chunk request is missing its byte range.');
    return loadLccChunk(source, lcc, signal);
  }
  if (format === 'rad-chunk') {
    if (source.from !== 'url') throw new Error('RAD chunks must be loaded from a URL.');
    if (!rad) throw new Error('RAD chunk request is missing its byte range.');
    return loadRadChunk(source, rad, signal);
  }
  const label = source.from === 'url' ? source.url : source.file.name;
  // A local PLY is streamed: a raw 3DGS export can run past the 2 GiB a
  // browser will read in one piece, and its records are fixed-stride.
  if (source.from === 'file' && format === 'ply') {
    try {
      return await parseSplatPlyFile(source.file, {
        signal,
        ...(onProgress ? { onProgress } : {}),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw toSplatLoadError(error, { phase: 'decode', url: label });
    }
  }
  const buffer =
    source.from === 'url'
      ? await fetchBuffer(source.url, source.request, signal, onProgress)
      : await readWholeFile(source.file);
  try {
    switch (format) {
      case 'ply':
        return parseSplatPly(buffer);
      case 'sog': {
        const data = await parseSog(buffer, { signal });
        return sog ? packSogShN(data, sog.packShBands) : data;
      }
      case 'rad':
        return parseRad(buffer);
      // `ChunkLoader` routes spz/splat/ksplat to the one-shot worker; reaching
      // this worker with one of them means the routing table lost an entry.
      default:
        throw new Error(`The streaming worker does not decode ${format}.`);
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw toSplatLoadError(error, { phase: 'decode', url: label });
  }
}

/**
 * Converts a decoded SOG chunk's palette shN into per-splat packed shN (M11),
 * dropping the palette so it is not transferred. A chunk without shN is
 * returned unchanged - the pool neutral-fills those splats. Runs in the worker,
 * off the main thread.
 */
function packSogShN(data: SplatData, bands: 1 | 2 | 3): SplatData {
  if (!data.sh) return data;
  const shPacked = packPaletteSh(data.sh, data.count, bands);
  const { sh: _dropped, ...rest } = data;
  return { ...rest, shPacked };
}

/**
 * Fetches one `(cell, level)` slice of an LCC `data.bin` - plus the
 * matching `shcoef.bin` slice when SH is enabled - and decodes it.
 *
 * The two fetches overlap: SH is a separate file, so waiting for the base
 * bytes first would double this chunk's latency for no reason.
 */
async function loadLccChunk(
  source: Extract<LoadWorkerSource, { from: 'url' }>,
  lcc: LccChunkParams,
  signal: AbortSignal,
): Promise<SplatData> {
  const url = stripFragment(source.url);
  const sh = lcc.sh?.source === 'sidecar' ? lcc.sh : undefined;
  const [buffer, shBuffer] = await Promise.all([
    fetchRange(url, lcc.start, lcc.length, source.request, signal),
    sh?.url === undefined
      ? Promise.resolve(undefined)
      : // shcoef.bin holds 64 bytes per splat against data.bin's 32, aligned
        // 2:1, so this chunk's SH is exactly its doubled byte range.
        fetchRange(sh.url, lcc.start * 2, lcc.length * 2, source.request, signal),
  ]);
  try {
    return await parseLccChunk(buffer, lcc, shBuffer, signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw toSplatLoadError(error, { phase: 'decode', url });
  }
}

/**
 * Fetches one chunk's byte range from a single-file `.rad` and decodes it,
 * keeping every splat (merged LOD nodes and leaves) plus the per-splat tree
 * columns - the streamed reader (`RadLodSource`) picks the rendered cut.
 */
async function loadRadChunk(
  source: Extract<LoadWorkerSource, { from: 'url' }>,
  rad: RadChunkRangeRequest,
  signal: AbortSignal,
): Promise<SplatData> {
  const url = stripFragment(source.url);
  // A single-file `.rad` chunk is a byte range; an external `.radc` file is
  // fetched whole (its own CDN-cacheable object).
  const buffer =
    rad.start !== undefined && rad.length !== undefined
      ? await fetchRange(url, rad.start, rad.length, source.request, signal)
      : await fetchBuffer(url, source.request, signal);
  try {
    return await parseRadChunkStreaming(buffer, rad.shCodebook, rad.shExtent, rad.reorder ?? true);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw toSplatLoadError(error, { phase: 'decode', url });
  }
}
