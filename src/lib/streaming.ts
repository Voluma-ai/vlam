/**
 * `@voluma/vlam/streaming` - budgeted LOD streaming for scenes larger than
 * GPU memory.
 *
 * {@link StreamedSplatMesh.load} opens Streamed SOG, LCC / `.lcc2`, and Spark
 * `.rad`. Shared loading errors and request types are re-exported so a host
 * that only imports this entry can still name them.
 *
 * Static auto-LOD lives on `@voluma/vlam/static-lod`.
 *
 * @module streaming
 */
export {
  StreamedSplatMesh,
  type StreamedSplatMeshOptions,
  type InitialRevealState,
  type PersistentChannelOptions,
  type StreamedSplatPerformanceEvent,
} from './streamed-splat-mesh';
export {
  BudgetGovernor,
  type BudgetGovernorOptions,
  type BudgetGovernedMember,
} from './budget-governor';
export {
  CameraBudgetGovernor,
  type CameraBudgetGovernorOptions,
  type CameraBudgetMember,
  type CameraBudgetMemberOptions,
} from './camera-budget-governor';
export {
  ChunkFetchScheduler,
  type ChunkFetchSchedulerOptions,
  type ChunkFetchClient,
  type ChunkFetchHandle,
  type ChunkFetchKind,
} from './chunk-fetch-scheduler';
export {
  ChunkCacheBudget,
  type ChunkCacheBudgetOptions,
  type ChunkCacheClient,
  type ChunkCacheHandle,
} from './chunk-cache-budget';
export { httpDatasetSource, createLocalDataset } from './dataset-source';
export type { SplatDatasetSource, LocalDataset } from './dataset-source';
export type { CollisionMeshTile } from './formats/lcc/collision-mesh';
export type { SplatCollisionData, CollisionMeshDescriptor, EnvironmentTile } from './lod-source';
export { resolveCpuCacheBytes } from './splat-budget';
export {
  SplatLoadError,
  isAbortError,
  type SplatProgressCallback,
  type StreamedSplatFormat,
  type SplatRequestOptions,
  type SplatLoadPhase,
  type SplatInputOptions,
} from './loading';
