import type { UnifiedSourceView } from '../core/splat-mesh-types';
import type * as THREE from 'three/webgpu';

/** Last successful gather inputs that decide whether a source can skip work. */
export type GatherCacheSnapshot = {
  activeCount: number;
  contentRevision: number;
  /** Streamed LOD / slot replacement; not always identical to contentRevision. */
  activeListVersion: number;
  offset: number;
  opacity: number;
  matrixWorld: THREE.Matrix4;
  /** Local camera position used by view-dependent SH evaluation. */
  localCameraPosition: THREE.Vector3;
};

/** True when world centers, covariance, and cached modifier geometry still match. */
export const gatherGeometryMatches = (
  last: GatherCacheSnapshot,
  view: UnifiedSourceView,
  sliceOffset: number,
  ownedSameSlice: boolean,
  effectiveOpacity: number,
): boolean =>
  ownedSameSlice &&
  last.activeCount === view.activeCount &&
  last.contentRevision === view.contentRevision &&
  last.activeListVersion === view.activeListVersion &&
  last.offset === sliceOffset &&
  last.opacity === effectiveOpacity &&
  last.matrixWorld.equals(view.matrixWorld);

/** SH depends on camera position, not orientation. */
export const gatherShCameraMatches = (
  last: GatherCacheSnapshot,
  view: UnifiedSourceView,
): boolean => view.sh === null || last.localCameraPosition.equals(view.localCameraPosition.value);

/** Cached modifier geometry is camera-independent until the host invalidates. */
export const gatherModifiersReusable = (
  view: UnifiedSourceView,
  cacheModifiers: boolean,
): boolean => view.modifiers.length === 0 || cacheModifiers;

export const createGatherCache = (
  view: UnifiedSourceView,
  sliceOffset: number,
  effectiveOpacity: number,
): GatherCacheSnapshot => ({
  activeCount: view.activeCount,
  contentRevision: view.contentRevision,
  activeListVersion: view.activeListVersion,
  offset: sliceOffset,
  opacity: effectiveOpacity,
  matrixWorld: view.matrixWorld.clone(),
  localCameraPosition: view.localCameraPosition.value.clone(),
});

export const writeGatherCache = (
  last: GatherCacheSnapshot,
  view: UnifiedSourceView,
  sliceOffset: number,
  effectiveOpacity: number,
): void => {
  last.activeCount = view.activeCount;
  last.contentRevision = view.contentRevision;
  last.activeListVersion = view.activeListVersion;
  last.offset = sliceOffset;
  last.opacity = effectiveOpacity;
  last.matrixWorld.copy(view.matrixWorld);
  last.localCameraPosition.copy(view.localCameraPosition.value);
};
