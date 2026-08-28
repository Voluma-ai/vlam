import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  StreamedSplatMesh,
  type StreamedSplatMeshOptions,
  type StreamedSplatPerformanceEvent,
} from '../streaming/streamed-splat-mesh';
import { writeCovariance, type SplatData } from '../core/splat-data';

const WIDTH = 2048;

// StreamedSplatMesh spins up a ChunkLoader Web Worker on construction; these
// tests drive `reschedule` directly, so a no-op Worker stub is enough for node.
beforeAll(() => {
  if (typeof (globalThis as { Worker?: unknown }).Worker === 'undefined') {
    (globalThis as { Worker: unknown }).Worker = class {
      postMessage(): void {}
      terminate(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
      onmessage: unknown = null;
      onerror: unknown = null;
    };
  }
});

function makeChunk(count: number): SplatData {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = i;
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

/** Builds a StreamedSplatMesh without `.load()` (see the channels tests). */
function makeStreamedMesh(options: StreamedSplatMeshOptions = {}): StreamedSplatMesh {
  const capacity = 4 * WIDTH;
  const scene = {
    source: { budget: capacity } as unknown,
    chunkUrls: [] as string[],
    chunkKind: 'file' as const,
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 1, 1)),
    pinnedFiles: new Set<number>(),
    maxResidentSplats: capacity,
  };
  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
  ) => StreamedSplatMesh;
  return new Ctor(scene, capacity, capacity, options);
}

type Internals = {
  scene: { source: { computeDesiredRuns?: () => unknown[] } };
  cache: Map<number, { data: SplatData; bytes: number; lastUsed: number }>;
  resident: Map<string, { run: { count: number }; handle: unknown }>;
  reschedule: (
    camera: THREE.PerspectiveCamera,
    now: number,
  ) => StreamedSplatPerformanceEvent | null;
  createPerformanceEvent: (
    residentBefore: ReadonlyMap<string, number>,
    stagedBefore: ReadonlyMap<string, number>,
    compactionCountBefore: number,
    startedAt: number,
  ) => StreamedSplatPerformanceEvent | null;
};

function internals(mesh: StreamedSplatMesh): Internals {
  return mesh as unknown as Internals;
}

function run(file: number, offset: number, count: number): Record<string, number> {
  return { file, offset, count, leafStart: file, leafEnd: file + 1, level: 0 };
}

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  cam.updateMatrixWorld(true);
  return cam;
}

describe('StreamedSplatMesh performance-event gating', () => {
  const meshes: StreamedSplatMesh[] = [];
  afterEach(() => {
    for (const m of meshes) m.dispose();
    meshes.length = 0;
  });

  it('skips the before-snapshots and event construction without a listener', () => {
    const m = makeStreamedMesh();
    meshes.push(m);
    const inner = internals(m);
    const buildEvent = vi.spyOn(inner, 'createPerformanceEvent');
    inner.scene.source.computeDesiredRuns = () => [run(0, 0, 10)];
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });

    expect(inner.reschedule(camera(), 0)).toBeNull();
    // The reschedule work itself still happened; only its diffing was skipped.
    expect(inner.resident.size).toBe(1);
    expect(buildEvent).not.toHaveBeenCalled();
  });

  it('still builds the event for a changed tick when a listener is set', () => {
    const m = makeStreamedMesh({ onPerformanceEvent: () => {} });
    meshes.push(m);
    const inner = internals(m);
    inner.scene.source.computeDesiredRuns = () => [run(0, 0, 10)];
    inner.cache.set(0, { data: makeChunk(10), bytes: 0, lastUsed: 0 });

    const event = inner.reschedule(camera(), 0);
    expect(event).toMatchObject({
      appendedCount: 10,
      removedCount: 0,
      activeCount: 10,
      forcedSort: true,
    });

    // A settled tick (same desired runs, all resident) reports no event.
    expect(inner.reschedule(camera(), 1)).toBeNull();
  });
});
