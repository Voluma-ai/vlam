import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import type { FrontierDemandReply } from '../formats/rad/frontier-worker-protocol';
import { RAD_TRACE_HEARTBEAT_MS } from '../formats/rad/rad-trace-gate';
import { createStreamedMeshFixture } from './helpers/streamed-mesh-fixture';

class WorkerStub {
  posted: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror = null;
  onmessageerror = null;
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {}
}

/**
 * With `onPerformanceEvent` set, a camera-driven no-op plan cycle must not
 * flood the console: uneventful `[vlam:rad-*]` lines are limited to one per
 * heartbeat per tag, while lines that carry demand always print.
 */
describe('rad trace throttling', () => {
  const meshes: ReturnType<typeof createStreamedMeshFixture>[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
  });

  function fixture() {
    const scene = {
      source: {
        budget: 8192,
        lodBaseDistance: 10,
        lodMultiplier: 2,
        computeDesiredRuns: () => [],
        coarsestRunsFor: () => [],
      },
      chunkUrls: Array.from({ length: 30 }, (_, i) => `https://example.test/${i}`),
      chunkSize: 4,
      chunkKind: 'file',
      bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
      pinnedFiles: new Set([0]),
      maxResidentSplats: 8192,
      foveation: { minScreenRadiusPx: 1.6, maxScreenRadiusPx: 4 },
    };
    const mesh = createStreamedMeshFixture(
      scene,
      8192,
      8192,
      { foveationMode: 'page-table', onPerformanceEvent: () => {} },
      WorkerStub,
    );
    meshes.push(mesh);
    return mesh as unknown as {
      demandGeneration: number;
      applyDemand: (reply: FrontierDemandReply) => void;
    };
  }

  const demandLines = (debug: { mock: { calls: unknown[][] } }) =>
    debug.mock.calls.filter((call) => call[0] === '[vlam:rad-demand-main]').length;

  it('prints an uneventful demand reply once per heartbeat', () => {
    const inner = fixture();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    let now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const noop = (): FrontierDemandReply => ({
      type: 'demand',
      generation: inner.demandGeneration,
      revision: inner.demandGeneration,
      wants: [],
      complete: true,
      traversalId: 1,
      reason: 'traversed',
    });
    for (let i = 0; i < 30; i++) {
      inner.applyDemand(noop());
      now += 16;
    }
    expect(demandLines(debug)).toBe(1);
    now += RAD_TRACE_HEARTBEAT_MS;
    inner.applyDemand(noop());
    expect(demandLines(debug)).toBe(2);
  });

  it('always prints a reply that wants chunks', () => {
    const inner = fixture();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    let now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    for (let i = 0; i < 5; i++) {
      inner.applyDemand({
        type: 'demand',
        generation: inner.demandGeneration,
        revision: inner.demandGeneration,
        wants: [{ file: 1 + i, tier: 0, priority: 1 }],
        complete: true,
        traversalId: 1 + i,
        reason: 'traversed',
      });
      now += 16;
    }
    expect(demandLines(debug)).toBe(5);
  });
});
