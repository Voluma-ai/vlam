/**
 * VLAM! | a WebGPU-first 3D Gaussian Splatting renderer for three.js.
 *
 * Public API surface. Everything else under `src/lib/` is internal and may
 * change without notice.
 *
 * Optional systems live on dedicated subpaths so a host that only draws a
 * static mesh does not pay for workers, schedulers, or work buffers:
 *  - `@voluma/vlam/loaders` - {@link loadScene}, {@link ChunkLoader}
 *  - `@voluma/vlam/static-lod` - {@link StaticLodSplatMesh}
 *  - `@voluma/vlam/streaming` - {@link StreamedSplatMesh}, budget governors
 *  - `@voluma/vlam/unified` - {@link UnifiedSplatRenderer}
 *  - `@voluma/vlam/selection` - volume select and partition
 *  - `@voluma/vlam/effects` - tree-shakeable modifier presets
 *  - `@voluma/vlam/formats/ply` - 3DGS `.ply`, raw and compressed
 *  - `@voluma/vlam/formats/sog` - PlayCanvas SOG, bundled and unbundled
 *  - `@voluma/vlam/formats/rad` - Spark `.rad`/`.radc`
 *  - `@voluma/vlam/formats/lcc` - XGRIDS LCC / `.lcc2` + collision helpers
 *  - `@voluma/vlam/formats/spz` - Niantic `.spz`
 *  - `@voluma/vlam/formats/splat` - antimatter15 `.splat`
 *  - `@voluma/vlam/formats/ksplat` - mkkellogg `.ksplat`
 *
 * {@link loadScene} / {@link StreamedSplatMesh.load} still accept those formats
 * without importing a format subpath; the library loads format code on demand.
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
export { SplatScene, type SplatSceneOptions, type AddSourceOptions } from './splat-scene';
export { MAX_SOURCES } from './source-transform';
// Named so embedders can type what `SplatMesh.getUnifiedSourceView` returns
// (e.g. a custom gather pass); the uniform-node aliases it embeds come along.
export type { SplatShInputs, Vec3Uniform } from './splat-mesh-material';
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
  suggestAdaptivePixelRatio,
  ADAPTIVE_PIXEL_RATIO_WARMUP_FRAMES,
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
  deviceMaxStorageBufferBindingSize,
  assertStorageBufferFitsDevice,
  WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
  type WebGpuRequiredLimits,
  type WebGpuPowerPreference,
} from './webgpu-limits';
export type { SplatData, SplatShData, SplatPackedShData } from './splat-data';
// `SplatData.sourceFormat` and `SplatBudgetOptions.format` name these unions.
export type { SplatSourceFormat, StreamedSplatFormat } from './loading';
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
