import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import {
  createGatherCache,
  gatherGeometryMatches,
  gatherModifiersReusable,
  gatherShCameraMatches,
  writeGatherCache,
} from '../unified/gather-cache';
import type { UnifiedSourceView } from '../core/splat-mesh-types';

function view(overrides: Partial<UnifiedSourceView> = {}): UnifiedSourceView {
  return {
    capacity: 1,
    sourceIndex: new THREE.StorageBufferAttribute(new Uint32Array(1), 1),
    activeCount: 1,
    activeListVersion: 1,
    centersTexture: new THREE.DataTexture(new Float32Array(4), 1, 1),
    colorsTexture: new THREE.DataTexture(new Uint8Array(4), 1, 1),
    covarianceATexture: new THREE.DataTexture(new Float32Array(4), 1, 1),
    covarianceBTexture: new THREE.DataTexture(new Float32Array(4), 1, 1),
    dataTextureWidth: 1,
    matrixWorld: new THREE.Matrix4(),
    worldBounds: new THREE.Sphere(),
    sh: null,
    modifiers: [],
    hasSourcePlacement: false,
    channels: new Map(),
    localCameraPosition: uniform(new THREE.Vector3()),
    graphRevision: 0,
    srgbOutput: true,
    maxStdDev: 3,
    minSplatSizePx: 0,
    minPixelSize: 0,
    minContribution: 0,
    antialias: false,
    projectedFilterProfile: 'default',
    lodAlpha: false,
    revealMultiplier: 1,
    contentRevision: 1,
    ...overrides,
  };
}

describe('gather cache signatures', () => {
  it('treats same-count active-list replacement as a geometry change', () => {
    const first = view({ activeListVersion: 4, contentRevision: 4, activeCount: 8 });
    const cache = createGatherCache(first, 0, 1);
    const replaced = view({ activeListVersion: 5, contentRevision: 4, activeCount: 8 });
    expect(gatherGeometryMatches(cache, replaced, 0, true, 1)).toBe(false);
  });

  it('reuses geometry when only the camera position used for SH changes', () => {
    const first = view({
      sh: { mode: 'palette', bands: 1, paletteTexture: new THREE.DataTexture() },
    });
    const cache = createGatherCache(first, 0, 1);
    first.localCameraPosition.value.set(2, 0, 0);
    expect(gatherGeometryMatches(cache, first, 0, true, 1)).toBe(true);
    expect(gatherShCameraMatches(cache, first)).toBe(false);
    writeGatherCache(cache, first, 0, 1);
    expect(gatherShCameraMatches(cache, first)).toBe(true);
  });

  it('keeps live modifier stacks off the cached path', () => {
    const live = view({ modifiers: [() => ({})] });
    expect(gatherModifiersReusable(live, false)).toBe(false);
    expect(gatherModifiersReusable(live, true)).toBe(true);
  });
});
