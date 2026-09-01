/**
 * `@voluma/vlam/formats/rad` - SparkJS `.rad` parser and streamed scene builder.
 *
 * Loading through {@link StreamedSplatMesh.load} / {@link loadSplatData} does not
 * require this import; the library pulls the format in on demand. Use this
 * subpath for direct decode or inspection outside the default loaders.
 */
export {
  RAD_MAGIC,
  RAD_CHUNK_MAGIC,
  parseRad,
  parseRadHeaderMeta,
  parseRadChunkStreaming,
  type RadChunkRange,
  type RadMeta,
  type RadTree,
} from './parse-rad';
export { buildRadScene, RadLodSource } from './rad';
// Names what `ChunkLoader.load`'s `rad` option takes, so a host that wraps the
// chunk-range path can type it. Mirrors `LccChunkParams` on `@voluma/vlam/formats/lcc`.
export type { RadChunkRangeRequest } from '../../loaders/load-worker-protocol';
