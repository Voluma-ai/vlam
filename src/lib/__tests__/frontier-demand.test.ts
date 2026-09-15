import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import type { SplatData } from '../core/splat-data';
import { FrontierDemandScan, rankDemandParent } from '../formats/rad/frontier-demand';
import { traverseFrontier, frontierView } from '../formats/rad/rad-frontier';
import type {
  FrontierDemandMessage,
  FrontierDemandReply,
} from '../formats/rad/frontier-worker-protocol';
import { createStreamedMeshFixture } from './helpers/streamed-mesh-fixture';
import { experiments } from '../internal/experiments';

const projection = new THREE.PerspectiveCamera(90, 1, 0.1, 100).projectionMatrix.elements;
function chunks(
  nodes: { x: number; z?: number; size: number; children?: [number, number] }[],
  size: number,
): Map<number, SplatData> {
  const map = new Map<number, SplatData>();
  for (let base = 0; base < nodes.length; base += size) {
    const group = nodes.slice(base, base + size);
    const data: SplatData = {
      count: group.length,
      positions: Float32Array.from(group.flatMap((n) => [n.x, 0, n.z ?? -10])),
      colors: new Uint8Array(group.length * 4),
      covariances: new Float32Array(group.length * 6),
      radTree: {
        size: Float32Array.from(group.map((n) => n.size)),
        childCount: Uint16Array.from(group.map((n) => n.children?.[1] ?? 0)),
        childStart: Uint32Array.from(group.map((n) => n.children?.[0] ?? 0)),
      },
    };
    map.set(base / size, data);
  }
  return map;
}
function message(limit = 0.001): FrontierDemandMessage {
  return {
    type: 'demand',
    generation: 1,
    cameraLocal: [0, 0, 0],
    cameraForward: [0, 0, -1],
    projection,
    coneFov0: 90,
    coneFov: 120,
    coneFoveate: 0.4,
    behindFoveate: 0.2,
    limit,
    budget: 10,
  };
}

describe('request-only RAD traversal', () => {
  it('prefers central and nearby visible parents, then boundaries, while preserving uncertain off-screen ancestors', () => {
    const map = chunks(
      [
        { x: 0, size: 0.2, children: [4, 1] },
        { x: 5, size: 0.2, children: [5, 1] },
        { x: 0, z: -5, size: 0.2, children: [6, 1] },
        { x: 30, size: 0.2, children: [7, 1] },
      ],
      4,
    );
    const scan = new FrontierDemandScan(map, [0, 1, 2, 3], 4, message());
    expect(scan.step(-1)).toBeNull(); // partial traversal proves nothing absent
    const wants = scan.step(Infinity)!;
    expect(wants.map((w) => w.file)).toEqual([1]); // all parents share chunk 1
    expect(wants[0]!.tier).toBe(0);
    const center = rankDemandParent(map.get(0)!, 0, 4, projection, [0, 0, 0]);
    const edge = rankDemandParent(map.get(0)!, 1, 5, projection, [0, 0, 0]);
    const near = rankDemandParent(map.get(0)!, 2, 6, projection, [0, 0, 0]);
    const outside = rankDemandParent(map.get(0)!, 3, 7, projection, [0, 0, 0]);
    expect(near.priority).toBeGreaterThan(center.priority);
    expect(wants[0]!.priority).toBe(near.priority);
    expect(center.priority).toBeGreaterThan(edge.priority);
    expect(edge.tier).toBe(0);
    expect(outside.tier).toBe(2);
  });

  it('includes every crossed child chunk and applies the same refinement budget and threshold', () => {
    const map = chunks(
      [
        { x: 0, size: 10, children: [3, 2] },
        { x: 0, size: 10, children: [5, 1] },
        { x: 0, size: 10, children: [6, 1] },
      ],
      4,
    );
    const result = new FrontierDemandScan(map, [0, 1, 2], 4, message()).step(Infinity)!;
    expect(result.map((w) => w.file)).toEqual([1]);
    const crossed = chunks([{ x: 0, size: 10, children: [2, 5] }], 3);
    expect(
      new FrontierDemandScan(crossed, [0], 3, message()).step(Infinity)!.map((w) => w.file),
    ).toEqual([1, 2]);
    const budget = { ...message(), budget: 1 };
    expect(new FrontierDemandScan(crossed, [0], 3, budget).step(Infinity)).toEqual([]);
    expect(
      traverseFrontier(
        crossed,
        [0],
        3,
        frontierView({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, message()),
        budget.limit,
        1,
      ).touched.size,
    ).toBe(0);
  });

  it('ranks a footprint on the 15% margin as boundary and never prunes an uncertain ancestor', () => {
    const map = chunks([{ x: 11, size: 0.2, children: [4, 1] }], 4);
    const parent = map.get(0)!;
    expect(rankDemandParent(parent, 0, 1, projection, [0, 0, 0]).tier).toBe(1);
    expect(
      new FrontierDemandScan(map, [0], 4, message()).step(Infinity)!.map((w) => w.file),
    ).toEqual([1]);
  });

  it('leaves the selected global IDs unchanged at identical cache, camera and budget', () => {
    const map = chunks(
      [
        { x: 0, size: 10, children: [1, 2] },
        { x: 0, size: 2 },
        { x: 0, size: 2 },
      ],
      4,
    );
    const camera = frontierView({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, message());
    const before = traverseFrontier(map, [0], 4, camera, 0.001, 2);
    new FrontierDemandScan(map, [0], 4, { ...message(), budget: 2 }).step(Infinity);
    const after = traverseFrontier(map, [0], 4, camera, 0.001, 2);
    expect(after.selection).toEqual(before.selection);
    expect(after.count).toBe(before.count);
  });
});

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

describe('focused demand reconciliation', () => {
  const meshes: ReturnType<typeof createStreamedMeshFixture>[] = [];
  afterEach(() => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
    experiments.radDemand = 'legacy';
  });
  function fixture() {
    experiments.radDemand = 'focus';
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
      { foveationMode: 'page-table' },
      WorkerStub,
    );
    meshes.push(mesh);
    const inner = mesh as unknown as {
      cacheLimitBytes: number;
      demandGeneration: number;
      demandReadyGeneration: number;
      demandOutstanding: boolean;
      demandCacheDirty: boolean;
      demandWants: FrontierDemandReply['wants'];
      demandFirstSeen: Map<number, number>;
      pageTableCachedFiles: Set<number>;
      fetching: Map<number, { controller: AbortController; kind: string }>;
      requestChunk: (file: number, kind: string) => void;
      applyDemand: (reply: FrontierDemandReply) => void;
      reconcileDemand: () => void;
      reschedulePageTable: (
        c: THREE.Vector3,
        f: THREE.Vector3,
        fr: THREE.Frustum,
        now: number,
        p: number[],
      ) => void;
      pageTableInFlight: boolean;
      frontierWorker: WorkerStub;
      applyCacheAllowance: (bytes: number) => void;
      handleFrontierMessage: (reply: FrontierDemandReply | { type: 'plan' }) => void;
      applyFrontierPlan: (plan: { type: 'plan' }) => void;
    };
    inner.cacheLimitBytes = 1;
    inner.pageTableInFlight = true;
    return inner;
  }

  it('coalesces snapshots, ignores stale replies and never cancels from a partial scan', () => {
    const inner = fixture();
    const requested = vi.spyOn(inner, 'requestChunk').mockImplementation(() => {});
    const old = new AbortController();
    inner.fetching.set(3, { controller: old, kind: 'priority' });
    const schedule = (x: number, t: number) =>
      inner.reschedulePageTable(
        new THREE.Vector3(x, 0, 0),
        new THREE.Vector3(0, 0, -1),
        new THREE.Frustum(),
        t,
        [...projection],
      );
    schedule(0, 1000);
    const first = inner.demandGeneration;
    schedule(1, 1010);
    expect(
      inner.frontierWorker.posted.filter((m) => (m as { type: string }).type === 'demand'),
    ).toHaveLength(1);
    expect(old.signal.aborted).toBe(false);
    inner.applyDemand({ type: 'demand', generation: first, wants: [] });
    expect(old.signal.aborted).toBe(false);
    schedule(1, 1100);
    expect(
      inner.frontierWorker.posted.filter((m) => (m as { type: string }).type === 'demand'),
    ).toHaveLength(2);
    inner.applyDemand({
      type: 'demand',
      generation: inner.demandGeneration,
      wants: [{ file: 3, tier: 0, priority: 4 }],
    });
    expect(old.signal.aborted).toBe(false);
    expect(requested).toHaveBeenCalledWith(3, 'priority');
    inner.applyDemand({ type: 'demand', generation: inner.demandGeneration, wants: [] });
    expect(old.signal.aborted).toBe(true);
  });

  it('uses partial demand to fill slots without canceling, then rescans a changed cache', () => {
    const inner = fixture();
    const requested = vi.spyOn(inner, 'requestChunk').mockImplementation(() => {});
    const old = new AbortController();
    inner.fetching.set(3, { controller: old, kind: 'priority' });
    inner.demandGeneration = 5;
    inner.demandOutstanding = true;
    inner.applyDemand({
      type: 'demand',
      generation: 5,
      complete: false,
      wants: [{ file: 4, tier: 0, priority: 10 }],
    });
    expect(requested).toHaveBeenCalledWith(4, 'priority');
    expect(old.signal.aborted).toBe(false);
    expect(inner.demandOutstanding).toBe(true);
    inner.demandCacheDirty = true;
    inner.applyDemand({ type: 'demand', generation: 5, wants: [] });
    expect(old.signal.aborted).toBe(false);
    expect(inner.demandGeneration).toBe(6);
    expect(inner.demandReadyGeneration).toBe(-1);
    expect(inner.demandOutstanding).toBe(false);
  });

  it('keeps a lower-priority dependency progressing alongside seven visible requests', () => {
    const inner = fixture();
    const started: number[] = [];
    vi.spyOn(inner, 'requestChunk').mockImplementation((file) => {
      if (
        inner.pageTableCachedFiles.has(file) ||
        inner.fetching.size >= 8 ||
        inner.fetching.has(file)
      )
        return;
      started.push(file);
      inner.fetching.set(file, { controller: new AbortController(), kind: 'priority' });
    });
    inner.demandGeneration = 1;
    inner.demandReadyGeneration = 1;
    inner.demandWants = [
      ...Array.from({ length: 10 }, (_, i) => ({
        file: i + 1,
        tier: 0 as const,
        priority: 100 - i,
      })),
      { file: 20, tier: 1, priority: 1 },
    ];
    inner.reconcileDemand();
    expect(started).toEqual([1, 2, 3, 4, 5, 6, 7, 20]);
    inner.fetching.delete(1);
    inner.pageTableCachedFiles.add(1);
    inner.reconcileDemand();
    expect(started).toContain(8);
  });

  it('ignores a focused reply after the allowance grows to fit the capture', () => {
    const inner = fixture();
    const old = new AbortController();
    inner.fetching.set(3, { controller: old, kind: 'priority' });
    inner.demandGeneration = 4;
    inner.demandOutstanding = true;
    inner.applyCacheAllowance(100_000_000);
    inner.applyDemand({ type: 'demand', generation: 4, wants: [] });
    expect(old.signal.aborted).toBe(false);
    expect(inner.demandReadyGeneration).toBe(-1);
  });

  it('eventually serves an aging off-screen dependency before fresh boundary work', () => {
    const inner = fixture();
    const requested: number[] = [];
    vi.spyOn(inner, 'requestChunk').mockImplementation((file) => {
      requested.push(file);
    });
    inner.demandGeneration = inner.demandReadyGeneration = 1;
    inner.demandWants = [
      { file: 1, tier: 1, priority: 100 },
      { file: 2, tier: 2, priority: 1 },
    ];
    inner.demandFirstSeen.set(1, performance.now());
    inner.demandFirstSeen.set(2, performance.now() - 6000);
    inner.reconcileDemand();
    expect(requested).toEqual([2, 1]);
  });

  it('preserves eight already-started visible requests when a lower dependency appears', () => {
    const inner = fixture();
    const visible = Array.from({ length: 8 }, (_, index) => ({
      file: index + 1,
      tier: 0 as const,
      priority: 8 - index,
    }));
    const controllers = visible.map(() => new AbortController());
    visible.forEach((want, index) =>
      inner.fetching.set(want.file, {
        controller: controllers[index]!,
        kind: 'priority',
      }),
    );
    inner.demandGeneration = inner.demandReadyGeneration = 1;
    inner.demandWants = [...visible, { file: 20, tier: 1, priority: 1 }];
    inner.reconcileDemand();
    expect(controllers.every((controller) => !controller.signal.aborted)).toBe(true);
  });

  it('still applies a required pager plan after a stale request-only reply', () => {
    const inner = fixture();
    const apply = vi.spyOn(inner, 'applyFrontierPlan').mockImplementation(() => {});
    inner.demandGeneration = 2;
    inner.handleFrontierMessage({ type: 'demand', generation: 1, wants: [] });
    const plan = { type: 'plan' as const };
    inner.handleFrontierMessage(plan);
    expect(apply).toHaveBeenCalledExactlyOnceWith(plan);
  });
});
