// Guide sample: docs/guide/getting-started.md - non-uniform scale.
import type { SplatMesh } from '@voluma/vlam';

/**
 * Per-axis scaling is supported end-to-end (rendering, sorting, picking,
 * spatial queries) - set it like on any three.js object. Animating it per
 * frame is cheap: the transform flows through matrix uniforms only, never a
 * data re-upload.
 */
export function squashForTabletop(splats: SplatMesh): void {
  splats.scale.set(2, 0.5, 1); // stretch x, flatten y
}
