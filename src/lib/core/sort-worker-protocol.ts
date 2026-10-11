/**
 * Wire protocol for the CPU sort worker (`sort-worker.ts`).
 *
 * Kept out of the worker module so `worker-sorter.ts` can be typed without
 * pulling worker source into the published declarations - the worker is
 * bundled into a blob URL and is not a public entry point.
 */
import type { SplatSortRange } from './splat-sort-bounds';

export interface InitMessage {
  type: 'init';
  /** Pool capacity in splats. */
  capacity: number;
}

export interface WriteMessage {
  type: 'write';
  /** First pool splat index the data belongs to. */
  start: number;
  /** Center data, vec4 stride (x, y, z, unused) - the pool texture layout. */
  centers: Float32Array;
  /** Optional source ids parallel to this write, for unified-pool sorting. */
  sourceIds?: Float32Array;
}

export interface SortMessage {
  type: 'sort';
  /** Identity of the immutable scene snapshot being sorted. */
  requestId: number;
  /** Camera-space ordering key. */
  sortMetric: 'depth' | 'radial';
  /** Column-major 4×4 model-view matrix elements. */
  modelView: Float32Array;
  /** Active ranges as (start, count) pairs of pool splat indices, in
   * active-list order. */
  spans: Uint32Array;
  /** Exact active pool-index list for a captured publication. */
  indices?: Uint32Array;
  /**
   * Source id per entry of {@link indices}, for a pooled unified sort whose
   * sources share one pool but carry their own `matrices`. Overrides the
   * pool-indexed `sourceIds` written through {@link WriteMessage}.
   */
  indexSources?: Uint8Array;
  /**
   * Sort the `indices` / `indexSources` of the previous request again (the
   * worker keeps them): a camera-only re-sort of an unchanged pooled scene
   * sends no index list at all. Invalid without an earlier transferred list.
   */
  reuseIndices?: boolean;
  /** Reply with a `Float32Array` order, ready for a float `splatIndex` attribute. */
  orderAsFloat?: boolean;
  /** Optional column-major source matrices, four columns per source. */
  matrices?: Float32Array;
  /** Pre-intersected scene/camera key range; clamps invisible outliers. */
  sortRange?: SplatSortRange;
}

export interface OrderMessage {
  type: 'order';
  /** Echoes {@link SortMessage.requestId}; never infer identity from slots. */
  requestId: number;
  /** Active pool splat indices, ordered back-to-front (`Float32Array` when `orderAsFloat`). */
  order: Uint32Array | Float32Array;
  /** Source id per entry of {@link order}; present when the request sent `indexSources`. */
  orderSources?: Uint8Array;
}

export type SortWorkerRequest = InitMessage | WriteMessage | SortMessage;
