/**
 * Wire protocol for the CPU sort worker (`sort-worker.ts`).
 *
 * Kept out of the worker module so `worker-sorter.ts` can be typed without
 * pulling worker source into the published declarations - the worker is
 * bundled into a blob URL and is not a public entry point.
 */

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
  /** Camera-space ordering key. */
  sortMetric: 'depth' | 'radial';
  /** Column-major 4×4 model-view matrix elements. */
  modelView: Float32Array;
  /** Active ranges as (start, count) pairs of pool splat indices, in
   * active-list order. */
  spans: Uint32Array;
  /** Optional column-major source matrices, four columns per source. */
  matrices?: Float32Array;
}

export interface OrderMessage {
  type: 'order';
  /** Active pool splat indices, ordered back-to-front. */
  order: Uint32Array;
}

export type SortWorkerRequest = InitMessage | WriteMessage | SortMessage;
