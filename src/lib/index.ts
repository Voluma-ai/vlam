/**
 * VLAM! | a WebGPU-first 3D Gaussian Splatting renderer for three.js.
 *
 * Public API surface. Everything else under `src/lib/` is internal and may
 * change without notice.
 *
 * Format-specific parsers live on optional subpaths:
 *  - `@voluma/vlam/formats/ply` - 3DGS `.ply`, raw and compressed
 *  - `@voluma/vlam/formats/sog` - PlayCanvas SOG, bundled and unbundled
 *  - `@voluma/vlam/formats/rad` - Spark `.rad`/`.radc`
 *  - `@voluma/vlam/formats/lcc` - XGRIDS LCC / `.lcc2` + collision helpers
 *  - `@voluma/vlam/formats/spz` - Niantic `.spz`
 *  - `@voluma/vlam/formats/splat` - antimatter15 `.splat`
 *  - `@voluma/vlam/formats/ksplat` - mkkellogg `.ksplat`
 *
 * {@link loadScene} / {@link StreamedSplatMesh.load} still accept those formats
 * without importing a subpath; the library loads format code on demand.
 *
 * @module core
 */
export {
  SplatMesh,
  MAX_SH_BANDS,
  DEFAULT_FOVEATION_TARGET_PX,
  DEFAULT_FOVEATION_DRAW_BUDGET,
  resolveSplatPerformanceProfile,
  type UnifiedSourceView,
  type SplatMeshOptions,
  type SplatUpdateOptions,
  type SplatSortStrategy,
  type SplatPerformanceProfile,
  type SplatRange,
  type SplatPickOptions,
  type SplatPickResult,
  type SplatNearestResult,
  type SplatRayResult,
  type SplatHeightResult,
  type SplatChannelType,
  type SplatChannelOptions,
} from './splat-mesh';
// The storage behind a mesh, exported so several meshes can share one envelope
// (`SplatMeshOptions.pool`) instead of each reserving a private ceiling.
export { SplatPool, type SplatPoolOptions } from './splat-mesh-pool';
// Pool texture geometry and the device limit it must fit in, so a host can size
// a budget against what the device can actually hold (see `SplatPoolOptions.maxTextureSize`).
export {
  SPLAT_DATA_TEXTURE_WIDTH,
  deviceMaxTextureSize,
  assertPoolRowsFitDevice,
} from './splat-mesh-pool';
export {
  MAX_DOF_RADIUS_PX,
  MAX_DOF_VARIANCE,
  apertureAngleFromSize,
  computeDofCocVariancePx2,
  computeDofOpacityFade,
  clampDepthOfFieldSettings,
  type DepthOfFieldSettings,
} from './depth-of-field';
export {
  DEFAULT_RELIGHT_BLEND,
  DEFAULT_RELIGHT_BRIGHTNESS,
  DEFAULT_RELIGHT_BACKGROUND,
  DEFAULT_RELIGHT_SOFTNESS,
  clampRelightingSettings,
  createPlaceholderRelightTexture,
  type RelightingSettings,
  type RelightingUniforms,
} from './relighting';
export {
  type SplatOrientation,
  type OrientableFormat,
  createYUpTransform,
  yUpTransformForFormat,
} from './orientation';
export {
  StreamedSplatMesh,
  type StreamedSplatMeshOptions,
  type InitialRevealState,
  type PersistentChannelOptions,
  type StreamedSplatPerformanceEvent,
} from './streamed-splat-mesh';
export {
  StaticLodSplatMesh,
  type StaticLodSplatMeshOptions,
  type StaticLodSplatMeshLoadOptions,
  type StaticLodLoadProgress,
} from './static-lod-splat-mesh';
export type { StaticLodBuildProgress } from './static-lod';
export { SplatScene, type SplatSceneOptions, type AddSourceOptions } from './splat-scene';
export { MAX_SOURCES } from './source-transform';
// Named so embedders can type what `SplatMesh.getUnifiedSourceView` returns
// (e.g. a custom gather pass); the uniform-node aliases it embeds come along.
export type { SplatShInputs, Vec3Uniform } from './splat-mesh-material';
export {
  UnifiedSplatRenderer,
  supportsUnifiedSplatRenderer,
  type UnifiedSplatPickResult,
  type UnifiedSplatRendererOptions,
  type UnifiedSplatSourceOptions,
} from './unified-splat-renderer';
export {
  resolveSplatBudget,
  detectSplatDeviceProfile,
  classifySplatGpuClass,
  probeSplatGpuClass,
  isFillConstrainedSplatDevice,
  recommendedMaxPixelRatio,
  recommendedRadMaxStdDev,
  recommendedXrFramebufferScale,
  resolveXrSplatBudget,
  resolveCpuCacheBytes,
  suggestAdaptivePixelRatio,
  estimateSplatPoolBytes,
  type SplatBudgetOptions,
  type SplatCostClass,
  type SplatDeviceProfile,
  type SplatGpuClass,
  type SplatGpuAdapterInfo,
  type AdaptivePixelRatioInput,
  type AdaptivePixelRatioResult,
  type SplatPoolBytesOptions,
} from './splat-budget';
export { xrSessionInit } from './xr-view';
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
  createSplatRenderer,
  type CreateSplatRendererOptions,
  type SplatRendererGpu,
  type SplatRendererGpuAdapter,
  type SplatRendererGpuDevice,
} from './create-splat-renderer';
export {
  recommendedWebGpuRequiredLimits,
  supportsWebGpuPowerPreference,
  webGpuPowerPreferenceOptions,
  estimateLargestStorageBufferBytes,
  estimateUnifiedWorkBufferBytes,
  estimateUnifiedWorkBufferPeakBytes,
  deviceMaxStorageBufferBindingSize,
  assertStorageBufferFitsDevice,
  WORK_BUFFER_CENTERS_BYTES_PER_SPLAT,
  WORK_BUFFER_BYTES_PER_SLOT,
  WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
  type WebGpuRequiredLimits,
  type WebGpuPowerPreference,
} from './webgpu-limits';
export {
  loadScene,
  loadSceneFile,
  type SplatLoadOptions,
  type SplatFileLoadOptions,
} from './load-scene';
export { ChunkLoader } from './chunk-loader';
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
export {
  SplatLoadError,
  isAbortError,
  type SplatProgressCallback,
  type SplatFormat,
  type SplatSourceFormat,
  type StreamedSplatFormat,
  type SplatRequestOptions,
  type SplatLoadPhase,
  // The base of every loader options bag, and the parser union `ChunkLoader`
  // accepts - both are referenced by public signatures, so both must be
  // nameable by a host writing a wrapper.
  type SplatInputOptions,
  type ChunkFileFormat,
} from './loading';
// Collision tile type only - runtime loader lives on `@voluma/vlam/formats/lcc` and is
// reached through StreamedSplatMesh.loadCollisionMeshes.
export type { CollisionMeshTile } from './formats/lcc/collision-mesh';
export type { SceneCollision, CollisionMeshDescriptor, EnvironmentTile } from './lod-source';
// Where a streamed dataset's files come from: an HTTP origin, or a folder the
// user dropped into the page (read in place through blob: URLs).
export { httpDatasetSource, createLocalDataset } from './dataset-source';
export type { SplatDatasetSource, LocalDataset } from './dataset-source';
export type { SplatData, SplatShData, SplatPackedShData } from './splat-data';
// Volume selection + separation: select a region of a loaded cloud with a
// box/sphere/cylinder (or custom) volume and split it into its own SplatData,
// so the part can be posed/animated as an independent object.
export {
  createSelectionVolume,
  selectInData,
  countInData,
  type SelectionVolume,
  type SelectionVolumeKind,
  type SelectionVolumeOptions,
} from './selection-volume';
export { partitionSplatData, type SplatPartition } from './splat-partition';
// Collision-mesh splitting is format-specific (it operates on the LCC triangle
// type), so it lives on `@voluma/vlam/formats/lcc` beside the collision loader.
export type {
  SplatModifier,
  SplatContext,
  SplatOutputs,
  ModifierStackTarget,
} from './splat-modifier';
export { ModifierSlots } from './splat-modifier';
// Every diagnostic the library emits goes through one hook, so a host can
// forward VLAM! warnings into its own logger or silence them.
export { setVlamLogHandler, type VlamLogHandler, type VlamLogLevel } from './logging';
