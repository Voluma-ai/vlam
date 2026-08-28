import { parseSpz } from '../formats/spz/parse-spz';
import { parseSplat } from '../formats/splat/parse-splat';
import { parseKsplat } from '../formats/ksplat/parse-ksplat';
import type { SplatData } from '../core/splat-data';
import type { LoadWorkerSource } from './load-worker-protocol';
import { fetchBuffer } from './worker-fetch';
import { serveLoadRequests } from './worker-host';
import {
  isAbortError,
  readWholeFile,
  toSplatLoadError,
  type ChunkFileFormat,
  type SplatProgressCallback,
} from './loading';

/**
 * Web Worker for the one-shot whole-file formats: `.spz`, `.splat`, `.ksplat`.
 *
 * These are single-file loads with no chunked or streamed variant, so nothing
 * needs them resident. Splitting them out of `load-worker.ts` is what keeps
 * SPZ's ZSTD decoder - a ~39 KB base64 wasm blob, 16 KB gzipped - out of the
 * always-inlined streaming worker and therefore out of `dist/loaders.js`.
 * `ChunkLoader` dynamic-imports this module the first time one of these formats
 * is actually requested, so the decode still happens off the main thread.
 */

serveLoadRequests((message, signal, onProgress) =>
  load(message.source, message.format, signal, onProgress),
);

async function load(
  source: LoadWorkerSource,
  format: ChunkFileFormat,
  signal: AbortSignal,
  onProgress?: SplatProgressCallback,
): Promise<SplatData> {
  const label = source.from === 'url' ? source.url : source.file.name;
  const buffer =
    source.from === 'url'
      ? await fetchBuffer(source.url, source.request, signal, onProgress)
      : await readWholeFile(source.file);
  try {
    switch (format) {
      // Not awaited, matching the streaming worker's `rad` case: an async
      // parser's rejection is wrapped by the message loop as `phase: 'worker'`
      // rather than `phase: 'decode'`. Adding `await` here would quietly change
      // the phase consumers already see for a malformed `.spz`.
      case 'spz':
        return parseSpz(buffer);
      case 'splat':
        return parseSplat(buffer);
      case 'ksplat':
        return parseKsplat(buffer);
      // `ChunkLoader` routes only the three formats above here; anything else
      // means the routing table and this switch disagree.
      default:
        throw new Error(`The one-shot worker does not decode ${format}.`);
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw toSplatLoadError(error, { phase: 'decode', url: label });
  }
}
