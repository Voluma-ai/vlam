import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { createPlaceholderRelightTexture } from '../core/relighting';
import { createWorkBufferMaterial } from '../unified/work-buffer-material';

function relightDefaults() {
  return {
    relightMap: createPlaceholderRelightTexture(),
    relightBlend: uniform(0),
    relightBrightness: uniform(2),
    relightBackground: uniform(1),
    relightSoftness: uniform(0),
  };
}

describe('createWorkBufferMaterial', () => {
  it('builds a node material that reads gathered centers and sorted work indices', () => {
    const material = createWorkBufferMaterial({
      capacity: 4,
      centers: new THREE.StorageBufferAttribute(new Float32Array(16), 4),
      colors: new THREE.StorageBufferAttribute(new Float32Array(16), 4),
      covarianceA: new THREE.StorageBufferAttribute(new Float32Array(16), 4),
      covarianceB: new THREE.StorageBufferAttribute(new Float32Array(16), 4),
      isotropicMix: new THREE.StorageBufferAttribute(new Float32Array(4), 1),
      isotropicScreenRadius: new THREE.StorageBufferAttribute(new Float32Array(4), 1),
      order: new THREE.StorageInstancedBufferAttribute(new Float32Array(4), 1),
      focal: uniform(new THREE.Vector2()),
      viewport: uniform(new THREE.Vector2()),
      maxStdDev: uniform(3),
      minSplatSizePx: uniform(0),
      antialias: uniform(0),
      projectedLowPassVariance: uniform(0.3),
      compensateProjectedLowPass: uniform(0),
      dofFocusDistance: uniform(10),
      dofAperture: uniform(0),
      ...relightDefaults(),
    });
    expect(material.vertexNode).not.toBeNull();
    expect(material.fragmentNode).not.toBeNull();
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.side).toBe(THREE.DoubleSide);
    expect(material.forceSinglePass).toBe(true);
    expect(material.blending).toBe(THREE.CustomBlending);
    expect(material.blendSrc).toBe(THREE.OneFactor);
    expect(material.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
    material.dispose();
  });

  /**
   * The gather hands this material a single alpha convention: `.rad` sources
   * arrive with their stored `alpha ÷ 2` already doubled, so `alpha > 1` marks
   * a merged node here. Non-`.rad` sources can only reach `alpha ≤ 1`, where
   * both the σ-growth and the super-Gaussian plateau collapse to the plain
   * Gaussian this material drew before - one graph, no per-source variant.
   */
  it('builds one graph that serves merged-node and leaf alpha', () => {
    const material = createWorkBufferMaterial({
      capacity: 2,
      centers: new THREE.StorageBufferAttribute(new Float32Array([0, 0, -1, 1, 0, 0, -1, 1]), 4),
      // Slot 0 is a merged node (alpha 1.6 = stored 0.8 recovered), slot 1 a leaf.
      colors: new THREE.StorageBufferAttribute(new Float32Array([1, 0, 0, 1.6, 0, 1, 0, 0.5]), 4),
      covarianceA: new THREE.StorageBufferAttribute(new Float32Array(8), 4),
      covarianceB: new THREE.StorageBufferAttribute(new Float32Array(8), 4),
      isotropicMix: new THREE.StorageBufferAttribute(new Float32Array(2), 1),
      isotropicScreenRadius: new THREE.StorageBufferAttribute(new Float32Array(2), 1),
      order: new THREE.StorageInstancedBufferAttribute(new Float32Array([0, 1]), 1),
      focal: uniform(new THREE.Vector2(400, 400)),
      viewport: uniform(new THREE.Vector2(800, 600)),
      maxStdDev: uniform(3),
      minSplatSizePx: uniform(0),
      antialias: uniform(0),
      projectedLowPassVariance: uniform(0.3),
      compensateProjectedLowPass: uniform(0),
      dofFocusDistance: uniform(10),
      dofAperture: uniform(0),
      ...relightDefaults(),
    });
    expect(material.vertexNode).not.toBeNull();
    expect(material.fragmentNode).not.toBeNull();
    material.dispose();
  });

  it('builds a graph that draws fractional display opacity from center.w', () => {
    const material = createWorkBufferMaterial({
      capacity: 1,
      centers: new THREE.StorageBufferAttribute(new Float32Array([0, 0, -1, 0.25]), 4),
      colors: new THREE.StorageBufferAttribute(new Float32Array([1, 0, 0, 1.6]), 4),
      covarianceA: new THREE.StorageBufferAttribute(new Float32Array(4), 4),
      covarianceB: new THREE.StorageBufferAttribute(new Float32Array(4), 4),
      isotropicMix: new THREE.StorageBufferAttribute(new Float32Array(1), 1),
      isotropicScreenRadius: new THREE.StorageBufferAttribute(new Float32Array(1), 1),
      order: new THREE.StorageInstancedBufferAttribute(new Float32Array([0]), 1),
      focal: uniform(new THREE.Vector2(400, 400)),
      viewport: uniform(new THREE.Vector2(800, 600)),
      maxStdDev: uniform(3),
      minSplatSizePx: uniform(0),
      antialias: uniform(0),
      projectedLowPassVariance: uniform(0.3),
      compensateProjectedLowPass: uniform(0),
      dofFocusDistance: uniform(10),
      dofAperture: uniform(0),
      ...relightDefaults(),
    });
    expect(material.vertexNode).not.toBeNull();
    expect(material.fragmentNode).not.toBeNull();
    material.dispose();
  });

  it('builds a vertex graph that rejects non-drawable and out-of-frustum work slots', () => {
    // center.w <= 0 collapses to the clipped position alongside near/far and
    // lateral frustum rejects. The far reject must match the standalone graph:
    // unified RAD outliers otherwise become screen-filling spikes.
    const material = createWorkBufferMaterial({
      capacity: 2,
      centers: new THREE.StorageBufferAttribute(new Float32Array([0, 0, -1, 0, 0, 0, -1, 1]), 4),
      colors: new THREE.StorageBufferAttribute(new Float32Array([1, 0, 0, 0, 0, 1, 0, 1]), 4),
      covarianceA: new THREE.StorageBufferAttribute(new Float32Array(8), 4),
      covarianceB: new THREE.StorageBufferAttribute(new Float32Array(8), 4),
      isotropicMix: new THREE.StorageBufferAttribute(new Float32Array(2), 1),
      isotropicScreenRadius: new THREE.StorageBufferAttribute(new Float32Array(2), 1),
      order: new THREE.StorageInstancedBufferAttribute(new Float32Array([0, 1]), 1),
      focal: uniform(new THREE.Vector2(400, 400)),
      viewport: uniform(new THREE.Vector2(800, 600)),
      maxStdDev: uniform(3),
      minSplatSizePx: uniform(0),
      antialias: uniform(0),
      projectedLowPassVariance: uniform(0.3),
      compensateProjectedLowPass: uniform(0),
      dofFocusDistance: uniform(10),
      dofAperture: uniform(0),
      ...relightDefaults(),
    });
    expect(material.vertexNode).not.toBeNull();
    material.dispose();
  });
});
