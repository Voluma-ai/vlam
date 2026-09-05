/**
 * `@voluma/vlam/static-lod` - worker-built merged hierarchy for a fully
 * decoded capture. This entire entry is experimental and excluded from the
 * v1.0 compatibility guarantee: it decodes whole captures and uses temporary
 * hierarchy and array-copy memory, not bounded-memory streaming.
 *
 * {@link StaticLodSplatMesh.load} fetches through `@voluma/vlam/loaders` and
 * then builds the hierarchy off the main thread. Import this entry rather
 * than calling a streaming alias: there is none.
 *
 * @module static-lod
 */
/** @experimental Not covered by the v1.0 compatibility guarantee. */
export {
  StaticLodSplatMesh,
  type StaticLodSplatMeshOptions,
  type StaticLodSplatMeshLoadOptions,
  type StaticLodLoadProgress,
} from './static-lod-splat-mesh';
/** @experimental Not covered by the v1.0 compatibility guarantee. */
export type { StaticLodBuildProgress } from './static-lod';
