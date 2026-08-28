/** @role Bridge - Camera-aware rendering for worker-built static splat hierarchies. */
import * as THREE from 'three/webgpu';
import { loadSplatData, type SplatDataLoadOptions } from './load-splat-data';
import type { SplatData } from './splat-data';
import { SplatMesh, type SplatMeshOptions, type SplatUpdateOptions } from './splat-mesh';
import type { StaticLodBuildProgress } from './static-lod';
import type { StaticLodWorkerRequest, StaticLodWorkerResponse } from './static-lod-worker-protocol';

const BUDGET_GRANULARITY = 4096;
const CAMERA_RESCHEDULE_INTERVAL_MS = 250;

export interface StaticLodSplatMeshOptions extends SplatMeshOptions {
  /** Initial selected-frontier budget. Defaults to the build ceiling. */
  budget?: number;
  /** Finest frontier retained by the hierarchy and immutable pool ceiling. */
  maxBudget: number;
  /** Reports the spatial ordering and hierarchy-build phase. */
  onLodProgress?: (progress: StaticLodBuildProgress) => void;
  /** Phase-aware progress spanning download, decode completion and LOD build. */
  onAutoLodProgress?: (progress: StaticLodLoadProgress) => void;
}

export interface StaticLodLoadProgress {
  readonly phase: 'download' | 'decode' | 'lod-build';
  readonly completed: number;
  readonly total: number;
}

export interface StaticLodSplatMeshLoadOptions
  extends StaticLodSplatMeshOptions, SplatDataLoadOptions {}

const transferablesFor = (data: SplatData): Transferable[] => {
  const transferables: Transferable[] = [
    data.positions.buffer as ArrayBuffer,
    data.colors.buffer as ArrayBuffer,
    data.covariances.buffer as ArrayBuffer,
  ];
  if (data.sh) transferables.push(data.sh.labels.buffer as ArrayBuffer);
  if (data.shPacked) transferables.push(data.shPacked.packed.buffer as ArrayBuffer);
  return transferables;
};

const normalizeBudget = (value: number, ceiling: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('StaticLodSplatMesh budget must be a positive finite number.');
  }
  const clamped = Math.min(ceiling, Math.floor(value));
  if (clamped === ceiling || clamped < BUDGET_GRANULARITY) return Math.max(1, clamped);
  return Math.max(
    BUDGET_GRANULARITY,
    Math.floor(clamped / BUDGET_GRANULARITY) * BUDGET_GRANULARITY,
  );
};

const buildInWorker = async (
  source: SplatData,
  options: StaticLodSplatMeshOptions,
  signal: AbortSignal | undefined,
): Promise<{
  data: SplatData;
  contentSplatCount: number;
  finestSplatCount: number;
  worker: Worker;
}> => {
  const module = await import('./static-lod-worker?worker&inline');
  const WorkerClass = module.default;
  const worker = new WorkerClass();
  return await new Promise((resolve, reject) => {
    const abort = (): void => {
      worker.terminate();
      reject(new DOMException('Static LOD build aborted.', 'AbortError'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = (event): void => {
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.onmessage = (event: MessageEvent<StaticLodWorkerResponse>): void => {
      const response = event.data;
      if (response.type === 'progress') {
        options.onLodProgress?.(response.progress);
        options.onAutoLodProgress?.({ phase: 'lod-build', ...response.progress });
        return;
      }
      if (response.type === 'error') {
        signal?.removeEventListener('abort', abort);
        worker.terminate();
        reject(new Error(response.message));
        return;
      }
      if (response.type !== 'built') return;
      signal?.removeEventListener('abort', abort);
      resolve({
        data: response.data,
        contentSplatCount: response.contentSplatCount,
        finestSplatCount: response.finestSplatCount,
        worker,
      });
    };
    const request: StaticLodWorkerRequest = {
      type: 'build',
      source,
      maxBudget: options.maxBudget,
    };
    worker.postMessage(request, transferablesFor(source));
  });
};

/**
 * Static splat mesh backed by a merged hierarchy and camera-aware frontier.
 * The full hierarchy is uploaded once; camera/budget cuts only remap the
 * active pool indices and never rewrite resident splat attributes.
 */
export class StaticLodSplatMesh extends SplatMesh {
  private readonly worker: Worker;
  private readonly ceilingValue: number;
  private readonly contentCountValue: number;
  private budgetValue: number;
  private sequence = 0;
  private lastScheduleAt = -Infinity;
  private selectionPending = false;
  private readonly cameraLocal = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3(0, 0, -1);
  private readonly inverseWorld = new THREE.Matrix4();

  private constructor(
    data: SplatData,
    contentSplatCount: number,
    finestSplatCount: number,
    worker: Worker,
    options: StaticLodSplatMeshOptions,
  ) {
    super(data, options);
    this.worker = worker;
    this.ceilingValue = finestSplatCount;
    this.contentCountValue = contentSplatCount;
    this.budgetValue = normalizeBudget(options.budget ?? this.ceilingValue, this.ceilingValue);
    // Hierarchy layout: finest level occupies pool indices `[0, finest)`.
    this.replaceActivePrefix(this.ceilingValue);
    this.worker.onmessage = (event: MessageEvent<StaticLodWorkerResponse>): void => {
      const response = event.data;
      if (response.type === 'error') {
        this.selectionPending = false;
        return;
      }
      if (response.type !== 'selection' || response.sequence !== this.sequence) return;
      this.selectionPending = false;
      this.replaceActiveIndices(response.indices);
    };
    if (this.budgetValue < this.ceilingValue) this.scheduleSelection(true);
  }

  /** Loads, decodes and builds a merged static hierarchy without blocking UI. */
  static async load(
    input: string | URL,
    options: StaticLodSplatMeshLoadOptions,
  ): Promise<StaticLodSplatMesh> {
    let decodeReported = false;
    const source = await loadSplatData(input, {
      ...options,
      onProgress: (completed, total) => {
        options.onProgress?.(completed, total);
        options.onAutoLodProgress?.({ phase: 'download', completed, total });
        if (!decodeReported && total > 0 && completed >= total) {
          decodeReported = true;
          options.onAutoLodProgress?.({ phase: 'decode', completed: 0, total: 1 });
        }
      },
    });
    if (!decodeReported) {
      options.onAutoLodProgress?.({ phase: 'decode', completed: 0, total: 1 });
    }
    options.onAutoLodProgress?.({ phase: 'decode', completed: 1, total: 1 });
    const result = await buildInWorker(source, options, options.signal);
    return new StaticLodSplatMesh(
      result.data,
      result.contentSplatCount,
      result.finestSplatCount,
      result.worker,
      options,
    );
  }

  get budget(): number {
    return this.budgetValue;
  }

  get budgetCeiling(): number {
    return this.ceilingValue;
  }

  get maxBudget(): number {
    return this.ceilingValue;
  }

  get contentSplatCount(): number {
    return this.contentCountValue;
  }

  /** Changes the selected frontier budget within the immutable build ceiling. */
  setBudget(value: number): number {
    const next = normalizeBudget(value, this.ceilingValue);
    if (next === this.budgetValue) return next;
    this.budgetValue = next;
    this.selectionPending = false;
    this.scheduleSelection(true);
    return next;
  }

  override update(
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGPURenderer,
    options: SplatUpdateOptions = {},
  ): void {
    super.update(camera, renderer, options);
    this.updateLod(camera);
  }

  /** Schedules a camera-aware cut when a unified renderer owns drawing/sorting. */
  updateLod(camera: THREE.PerspectiveCamera): void {
    camera.updateMatrixWorld();
    this.updateWorldMatrix(true, false);
    this.inverseWorld.copy(this.matrixWorld).invert();
    this.cameraLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this.inverseWorld);
    camera.getWorldDirection(this.cameraForward).transformDirection(this.inverseWorld);
    this.scheduleSelection(false);
  }

  override dispose(): void {
    if (this.disposed) return;
    this.worker.terminate();
    super.dispose();
  }

  private scheduleSelection(immediate: boolean): void {
    if (this.disposed || this.selectionPending) return;
    const now = performance.now();
    if (!immediate && now - this.lastScheduleAt < CAMERA_RESCHEDULE_INTERVAL_MS) return;
    this.lastScheduleAt = now;
    this.selectionPending = true;
    const request: StaticLodWorkerRequest = {
      type: 'select',
      sequence: ++this.sequence,
      budget: this.budgetValue,
      cameraLocal: this.cameraLocal.toArray(),
      cameraForward: this.cameraForward.toArray(),
    };
    this.worker.postMessage(request);
  }
}
