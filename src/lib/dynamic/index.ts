/**
 * `@voluma/vlam/dynamic` - animated Gaussian splats.
 *
 * - **Captured 4D clips**: {@link loadSplatClip} loads a clip in any format
 *   vlam reads (Animated SOG `.asog`, also through {@link loadAsogClip}, and
 *   Faltwerk `.csgs`, also through {@link loadCsgsClip}),
 *   and {@link SplatClipMesh} plays any {@link SplatClip} with the same
 *   transport as a glTF animation: an `AnimationMixer` rooted at the mesh
 *   drives its `time` through {@link SplatClipMesh.animation}. A format may
 *   evaluate its motion on the GPU (both on WebGPU); every format can play
 *   on the frame path, where whole frames are evaluated and swapped in.
 * - **Rigged splats**: {@link SkinnedSplatMesh} skins a static splat by a
 *   `THREE.Skeleton`, so whatever moves the bones (glTF clips under an
 *   `AnimationMixer`, cross-fades, IK, code) moves the splats.
 *   {@link loadSplatGltf} loads rigged splats from a `KHR_gaussian_splatting`
 *   glTF with a skin and animations.
 *
 * The decoders themselves stay on the worker-safe, three-free
 * `@voluma/vlam/formats/asog` and `@voluma/vlam/formats/csgs` subpaths.
 *
 * @experimental The API may change in a minor release.
 * @module dynamic
 */
export {
  SPLAT_CLIP_FORMATS,
  type SplatClip,
  type SplatClipFormat,
  type SplatClipLoadOptions,
  type SplatClipLoadProgress,
} from './splat-clip';
export { loadSplatClip, type LoadSplatClipOptions } from './load-splat-clip';
export { loadAsogClip } from './load-asog-clip';
export type { AsogClip, LoadAsogClipOptions } from './asog-clip';
export {
  fetchCsgsScene,
  loadCsgsClip,
  type CsgsClip,
  type CsgsSceneFile,
  type CsgsSceneSection,
  type CsgsTestCamera,
  type LoadCsgsClipOptions,
} from './csgs-clip';
export type { CsgsSectionInfo } from './csgs-gpu-playback';
export { splatFrameBounds } from './splat-frame-bounds';
export { SplatClipStagingBudget } from './splat-clip-staging-budget';
export {
  SplatClipMesh,
  type SplatClipMeshEventMap,
  type SplatClipMeshOptions,
} from './splat-clip-mesh';
export {
  SKINNED_SPLAT_MAX_BONES,
  SkinnedSplatMesh,
  type SkinnedSplatMeshOptions,
  type SplatSkinData,
} from './skinned-splat-mesh';
export { computeSplatSkinWeights, type SplatSkinWeightOptions } from './splat-skin-weights';
export {
  loadSplatGltf,
  type LoadSplatGltfOptions,
  type SplatGltf,
  type SplatGltfClipHints,
} from './load-splat-gltf';
