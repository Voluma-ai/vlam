import type { SplatData } from '../core/splat-data';
import type { StaticLodBuildProgress } from './static-lod';

export interface StaticLodBuildRequest {
  readonly type: 'build';
  readonly source: SplatData;
  readonly maxBudget: number;
}

export interface StaticLodSelectRequest {
  readonly type: 'select';
  readonly sequence: number;
  readonly budget: number;
  readonly cameraLocal: readonly [number, number, number];
  readonly cameraForward: readonly [number, number, number];
}

export type StaticLodWorkerRequest = StaticLodBuildRequest | StaticLodSelectRequest;

export interface StaticLodProgressResponse {
  readonly type: 'progress';
  readonly progress: StaticLodBuildProgress;
}

export interface StaticLodBuiltResponse {
  readonly type: 'built';
  /** Full hierarchy for a one-time GPU upload; selection later remaps active indices. */
  readonly data: SplatData;
  readonly contentSplatCount: number;
  readonly finestSplatCount: number;
}

export interface StaticLodSelectionResponse {
  readonly type: 'selection';
  readonly sequence: number;
  /** Pool indices into the resident hierarchy (not gathered splat attributes). */
  readonly indices: Uint32Array;
}

export interface StaticLodErrorResponse {
  readonly type: 'error';
  readonly message: string;
}

export type StaticLodWorkerResponse =
  | StaticLodProgressResponse
  | StaticLodBuiltResponse
  | StaticLodSelectionResponse
  | StaticLodErrorResponse;
