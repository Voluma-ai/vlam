// Guide sample: docs/guide/unified-rendering.md - opt-in strategy factories.
import type * as THREE from 'three/webgpu';
import { UnifiedSplatMesh } from '@voluma/vlam/unified';
import { exactSort } from '@voluma/vlam/sorting/radix';
import { computeProjection } from '@voluma/vlam/projection/compute';

export function createExperimentalUnified(renderer: THREE.WebGPURenderer, capacity: number) {
  const experimental = new UnifiedSplatMesh(renderer, capacity, {
    sortStrategy: exactSort(),
    projectionStrategy: computeProjection(),
  });
  return experimental;
}
