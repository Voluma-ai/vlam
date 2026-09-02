import type * as THREE from 'three/webgpu';
import type { SplatSortRange } from './splat-sort-bounds';

/**
 * Depth-sorts splats back-to-front by rewriting the `splatIndex` buffer
 * that the splat material reads. Two implementations exist:
 *
 *  - `ComputeSorter`: GPU counting sort in TSL compute (WebGPU backend);
 *    supports dynamic-capacity meshes via source-index indirection.
 *  - `WorkerSorter`: stable CPU radix sort in a Web Worker (the WebGL2
 *    fallback and an explicit WebGPU stability option); handles static and
 *    dynamic-capacity meshes alike by mirroring the pool's centers and
 *    sorting the active spans.
 *  - `RadixSorter`: experimental GPU radix (opt-in via `sortStrategy: 'radix'`).
 */
export type SplatSorterKind = 'counting' | 'radix' | 'worker';

export interface SplatSorter {
  /** Discriminator so hosts can branch without a static class import. */
  readonly kind: SplatSorterKind;

  /**
   * Requests a re-sort for the given model-view matrix.
   *
   * @param modelView - Model-view matrix of the mesh.
   * @param activeCount - Number of active splats to sort.
   * @param bounds - Bounding sphere of the active splats, in mesh-local
   * space, used to derive the depth quantization range.
   * @returns true when the sort was accepted; false when it was skipped
   * (e.g. a previous asynchronous sort is still running) and the caller
   * should retry on a later frame.
   */
  sort(
    modelView: THREE.Matrix4,
    activeCount: number,
    bounds: THREE.Sphere,
    visibleRange?: SplatSortRange | null,
  ): boolean;

  dispose(): void;
}
