/**
 * `@voluma/vlam/loaders` - one-shot scene loading and the shared chunk worker.
 *
 * {@link loadScene} / {@link loadSceneFile} decode a whole file into
 * {@link SplatData} for {@link SplatMesh}. {@link ChunkLoader} is the
 * multiplexed worker behind those helpers and behind streamed chunk fetches.
 *
 * Format-specific parsers stay on `@voluma/vlam/formats/*`; this entry loads
 * them on demand through the worker.
 *
 * @module loaders
 */
export {
  loadScene,
  loadSceneFile,
  type SplatLoadOptions,
  type SplatFileLoadOptions,
} from './load-scene';
export { ChunkLoader } from './chunk-loader';
export {
  SplatLoadError,
  isAbortError,
  type SplatProgressCallback,
  type SplatFormat,
  type SplatSourceFormat,
  type StreamedSplatFormat,
  type SplatRequestOptions,
  type SplatLoadPhase,
  type SplatInputOptions,
  type ChunkFileFormat,
} from './loading';
