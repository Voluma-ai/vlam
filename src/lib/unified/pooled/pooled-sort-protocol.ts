/**
 * Wire protocol of the pooled draw's CPU sort worker (`pooled-sort-worker.ts`).
 * Kept apart from the worker so the host side can be typed without pulling the
 * worker source into declarations - the worker is inlined as a blob.
 */
import type { SplatSortRange } from '../../core/splat-sort-bounds';
import type { SplatSortMetric } from '../../core/splat-mesh-types';

export interface PooledInitMessage {
  type: 'init';
  /** Pool capacity in splats. */
  capacity: number;
}

export interface PooledWriteMessage {
  type: 'write';
  /** First pool splat index the centers belong to. */
  start: number;
  /** Centers, vec4 stride (x, y, z, unused) - the pool texture layout. */
  centers: Float32Array;
}

export interface PooledSortMessage {
  type: 'sort';
  requestId: number;
  sortMetric: SplatSortMetric;
  /** Column-major world → view matrix (the draw itself sits at identity). */
  modelView: Float32Array;
  /** Column-major source matrices, 16 floats per source id. */
  matrices: Float32Array;
  /**
   * Concatenated pool indices of every drawn source and each entry's source id.
   * Transferred, and kept by the worker: a request that omits them sorts the
   * last list again (a camera-only re-sort of an unchanged scene).
   */
  indices?: Uint32Array;
  indexSources?: Uint8Array;
  /** Pre-intersected scene/camera key range; clamps invisible outliers. */
  sortRange?: SplatSortRange;
}

export interface PooledOrderMessage {
  type: 'order';
  requestId: number;
  /** Pool indices back-to-front, as floats for the `splatIndex` attribute. */
  order: Float32Array;
  /** Source id per entry of {@link order}, for the `sourceId` attribute. */
  orderSources: Uint8Array;
}

export type PooledSortRequest = PooledInitMessage | PooledWriteMessage | PooledSortMessage;
