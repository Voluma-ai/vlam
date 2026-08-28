/**
 * `@voluma/vlam/static-lod` - worker-built merged hierarchy for a fully
 * decoded capture.
 *
 * {@link StaticLodSplatMesh.load} fetches through `@voluma/vlam/loaders` and
 * then builds the hierarchy off the main thread. Import this entry rather
 * than calling a streaming alias: there is none.
 *
 * @module static-lod
 */
export {
  StaticLodSplatMesh,
  type StaticLodSplatMeshOptions,
  type StaticLodSplatMeshLoadOptions,
  type StaticLodLoadProgress,
} from './static-lod-splat-mesh';
export type { StaticLodBuildProgress } from './static-lod';
