/**
 * `@voluma/vlam/loaders` - whole-file splat decode and the shared chunk worker.
 *
 * {@link loadSplatData} / {@link loadSplatDataFile} decode a whole file into
 * {@link SplatData} for {@link SplatMesh}. {@link ChunkLoader} is the
 * multiplexed worker behind those helpers and behind streamed chunk fetches.
 *
 * Format-specific parsers stay on `@voluma/vlam/formats/*`; this entry loads
 * them on demand through the worker.
 *
 * @module loaders
 */
export {
  loadSplatData,
  loadSplatDataFile,
  type SplatDataLoadOptions,
  type SplatDataFileLoadOptions,
} from './load-splat-data';
export { ChunkLoader } from './chunk-loader';
export {
  SplatLoadError,
  isAbortError,
  type SplatProgressCallback,
  type SplatFormat,
  type SplatDataFormat,
  type StreamedSplatFormat,
  type SplatRequestOptions,
  type SplatLoadPhase,
  type SplatInputOptions,
  type ChunkFileFormat,
} from './loading';
