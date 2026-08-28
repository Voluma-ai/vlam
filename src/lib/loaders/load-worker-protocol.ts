/**
 * Wire protocol for the loading worker (`load-worker.ts`).
 *
 * These message types live outside the worker module on purpose: the worker
 * itself is bundled into a blob URL and is not part of the published entry
 * graph, so keeping the shared interfaces here is what lets the main-thread
 * client ({@link ChunkLoader}) be typed without dragging worker source into
 * the shipped declarations.
 */
import type { LccChunkParams } from './formats/lcc/parse-lcc';
import type { RadShCodebook, SplatData } from './splat-data';
import type { ChunkFileFormat, SerializedSplatLoadError, SplatRequestOptions } from './loading';

/** Where a load's bytes come from. `File` crosses the worker boundary by
 * structured clone, so a local file is read (and decoded) in the worker. */
export type LoadWorkerSource =
  | {
      from: 'url';
      /** Absolute URL to a supported file, or a SOG chunk directory. */
      url: string;
      /** 'file' decodes by extension; 'directory' is an unbundled SOG. */
      kind: 'file' | 'directory';
      /** Serializable fetch settings supplied by the consumer. */
      request?: SplatRequestOptions;
    }
  | { from: 'file'; file: File };

export type LoadWorkerRequest =
  | {
      type: 'load';
      id: number;
      source: LoadWorkerSource;
      /** Explicit parser selection; 'directory' sources ignore it. */
      format: ChunkFileFormat;
      /** Byte range and dequantization ranges; required by `lcc-bin`. */
      lcc?: LccChunkParams;
      /** Byte range within the single-file `.rad`; required by `rad-chunk`. */
      rad?: RadChunkRangeRequest;
      /** Convert a SOG chunk's palette shN into packed shN at decode (M11). */
      sog?: { packShBands: 1 | 2 | 3 };
      /** A 'directory' chunk's files by name, when it has no directory URL. */
      files?: Readonly<Record<string, string>>;
      /** Report read progress; off unless the caller passed `onProgress`. */
      progress?: boolean;
    }
  | { type: 'cancel'; id: number };

/** A `rad-chunk`'s location. A single-file `.rad` gives a byte range; a
 * `--rad-chunked` set gives no range - the URL is the whole `.radc` file. */
export interface RadChunkRangeRequest {
  /** Byte offset within the single-file `.rad`; omitted for an external
   * `.radc` file (fetched whole). */
  readonly start?: number;
  /** Byte length of the range; omitted for an external `.radc` file. */
  readonly length?: number;
  /** Spark writes clustered SH coefficients only in chunk zero. */
  readonly shCodebook?: RadShCodebook;
  /** Scene-wide SH quantization extent established by chunk zero, so every
   * chunk's packed SH shares the one range the pool decodes against. */
  readonly shExtent?: number;
  /** Reorder splats leaves-first for the prefix reader (default). The foveation
   * reader passes `false` to keep file order (see `parseRadChunkStreaming`). */
  readonly reorder?: boolean;
}

export type LoadWorkerResponse =
  | { type: 'result'; id: number; ok: true; data: SplatData }
  | { type: 'result'; id: number; ok: false; error: SerializedSplatLoadError; cancelled: boolean }
  | { type: 'progress'; id: number; loaded: number; total: number };
