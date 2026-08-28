import * as THREE from 'three/webgpu';
import { float } from 'three/tsl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeCovariance, type SplatData } from '../splat-data';
import { SplatMesh, type SplatRange } from '../splat-mesh';
import type { SplatModifier } from '../splat-modifier';
import { UnifiedSplatRenderer } from '../unified-splat-renderer';
import { WorkBufferGather } from '../work-buffer-gather';

/**
 * E2 stress/property tests for the path an embedding app drives: one main mesh
 * plus N additional meshes with frequent add/remove/hide, live opacity, modifier
 * churn, and DoF on the unified draw. GPU work is mocked; correctness is
 * asserted on the work-buffer *layout* and on a shadow model of every slice
 * a gather pass wrote.
 */

function splatData(count: number): SplatData {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4).fill(255);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = i;
    writeCovariance(covariances, i, 1, 1, 1, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

function staticSource(count: number): SplatMesh {
  return new SplatMesh(splatData(count));
}

function mockRenderer(): THREE.WebGPURenderer {
  return {
    compute: vi.fn(),
    copyTextureToTexture: vi.fn(),
    getDrawingBufferSize: (out: THREE.Vector2) => out.set(800, 600),
    backend: { isWebGPUBackend: true },
  } as unknown as THREE.WebGPURenderer;
}

/** Deterministic PRNG so a failure reproduces byte-for-byte. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GatherCall {
  gather: WorkBufferGather;
  activeCount: number;
  offset: number;
  matrix: THREE.Matrix4;
  opacity: number;
}

/** Records every gather dispatch without disturbing the real implementation. */
function instrumentGather(calls: GatherCall[]): () => void {
  const original = WorkBufferGather.prototype.gather;
  WorkBufferGather.prototype.gather = function (
    this: WorkBufferGather,
    renderer,
    activeCount,
    targetOffset,
    sourceMatrix,
    cameraViewMatrixOrOpacity,
    opacity,
  ) {
    calls.push({
      gather: this,
      activeCount,
      offset: targetOffset,
      matrix: sourceMatrix.clone(),
      opacity:
        typeof cameraViewMatrixOrOpacity === 'number' ? cameraViewMatrixOrOpacity : (opacity ?? 1),
    });
    return original.call(
      this,
      renderer,
      activeCount,
      targetOffset,
      sourceMatrix,
      cameraViewMatrixOrOpacity,
      opacity,
    );
  };
  return () => {
    WorkBufferGather.prototype.gather = original;
  };
}

interface PrivateUnified {
  sources: Array<{
    source: SplatMesh;
    gather: WorkBufferGather;
    visible: boolean;
    opacity: number;
  }>;
  previousLayout: Array<{ source: SplatMesh; offset: number; activeCount: number }>;
}

interface ShadowSlot {
  source: SplatMesh;
  contentRevision: number;
  opacity: number;
  matrix: THREE.Matrix4;
}

describe('UnifiedSplatRenderer stress/property', () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length > 0) restores.pop()?.();
  });

  it('keeps the work-buffer layout a complete, non-overlapping, fresh permutation under random churn', () => {
    const CAPACITY = 64;
    const random = mulberry32(0xe2e2);
    const renderer = mockRenderer();
    const unified = new UnifiedSplatRenderer(renderer, CAPACITY);
    const internal = unified as unknown as PrivateUnified;
    const camera = new THREE.PerspectiveCamera();
    const calls: GatherCall[] = [];
    restores.push(instrumentGather(calls));

    // One "main" dynamic pool plus additional meshes appearing/disappearing.
    const main = new SplatMesh({ capacity: 4096 });
    const mainRanges: SplatRange[] = [];
    unified.addSource(main, { priority: 1 });
    const extras: SplatMesh[] = [];
    const registered = new Set<SplatMesh>([main]);
    const modifierPool: SplatModifier[] = [() => ({}), () => ({ scaleSquared: float(1.5) })];

    // Shadow model of the shared work buffer: which source last wrote each
    // slot, and with what content version / opacity / transform.
    const shadow: Array<ShadowSlot | null> = new Array<ShadowSlot | null>(CAPACITY).fill(null);

    const FRAMES = 120;
    for (let frame = 0; frame < FRAMES; frame++) {
      const op = random();
      if (op < 0.18) {
        // Additional-mesh add (a host application's extra load adds meshes mid-stream).
        const extra = staticSource(1 + Math.floor(random() * 12));
        extras.push(extra);
        unified.addSource(extra, { priority: 0, opacity: random() });
        registered.add(extra);
      } else if (op < 0.3 && extras.length > 0) {
        const extra = extras.splice(Math.floor(random() * extras.length), 1)[0]!;
        expect(unified.removeSource(extra)).toBe(true);
        registered.delete(extra);
        extra.dispose();
      } else if (op < 0.42 && extras.length > 0) {
        const extra = extras[Math.floor(random() * extras.length)]!;
        unified.setSourceVisible(extra, random() < 0.5);
      } else if (op < 0.54) {
        const target =
          extras.length > 0 && random() < 0.5
            ? extras[Math.floor(random() * extras.length)]!
            : main;
        unified.setSourceOpacity(target, random());
      } else if (op < 0.66) {
        // Streamed-cut churn on the main pool.
        if (mainRanges.length > 0 && random() < 0.4) {
          main.removeRange(mainRanges.pop()!);
        } else {
          const count = 1 + Math.floor(random() * 8);
          if (main.freeSplatCapacity >= 2048) mainRanges.push(main.appendRange(splatData(count)));
        }
      } else if (op < 0.74 && extras.length > 0) {
        const extra = extras[Math.floor(random() * extras.length)]!;
        extra.modifiers =
          random() < 0.5 ? [] : [modifierPool[Math.floor(random() * modifierPool.length)]!];
      } else if (op < 0.82 && extras.length > 0) {
        const extra = extras[Math.floor(random() * extras.length)]!;
        extra.position.set(random() * 10, random() * 10, random() * 10);
        extra.updateMatrixWorld(true);
      } else if (op < 0.9) {
        unified.setDepthOfField({ focusDistance: 1 + random() * 20, aperture: random() * 0.1 });
      }

      calls.length = 0;
      unified.update(camera);

      // Resolve each dispatched gather to its owning source and stamp the
      // shadow buffer with what that dispatch wrote.
      const bySource = new Map(internal.sources.map((record) => [record.gather, record] as const));
      for (const call of calls) {
        const record = bySource.get(call.gather);
        expect(record, 'gather dispatch must belong to a registered source').toBeDefined();
        expect(call.offset).toBeGreaterThanOrEqual(0);
        expect(call.offset + call.activeCount).toBeLessThanOrEqual(CAPACITY);
        const view = record!.source.getUnifiedSourceView();
        for (let slot = call.offset; slot < call.offset + call.activeCount; slot++) {
          shadow[slot] = {
            source: record!.source,
            contentRevision: view.contentRevision,
            opacity: record!.opacity,
            matrix: view.matrixWorld.clone(),
          };
        }
      }

      // Layout invariants: contiguous from zero, disjoint, within capacity,
      // each admitted source exactly once, instanceCount matches.
      const layout = [...internal.previousLayout].sort((a, b) => a.offset - b.offset);
      let cursor = 0;
      const seen = new Set<SplatMesh>();
      for (const entry of layout) {
        expect(entry.offset).toBe(cursor);
        expect(entry.activeCount).toBeGreaterThan(0);
        expect(seen.has(entry.source)).toBe(false);
        seen.add(entry.source);
        cursor += entry.activeCount;
      }
      expect(cursor).toBeLessThanOrEqual(CAPACITY);
      expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(cursor);

      // Permutation completeness: every visible, non-empty source is either
      // admitted with its full active count or accounted as dropped.
      let visibleSources = 0;
      let visibleSplats = 0;
      for (const record of internal.sources) {
        const view = record.source.getUnifiedSourceView();
        if (!record.visible || view.activeCount === 0) {
          expect(seen.has(record.source)).toBe(false);
          continue;
        }
        visibleSources++;
        visibleSplats += view.activeCount;
        const entry = layout.find((candidate) => candidate.source === record.source);
        if (entry) expect(entry.activeCount).toBe(view.activeCount);
      }
      expect(layout.length + unified.droppedSourceCount).toBe(visibleSources);
      expect(cursor + unified.droppedSplatCount).toBe(visibleSplats);

      // Freshness: every slot a current slice owns must have been written by
      // its source, at the source's *current* content revision, opacity, and
      // world transform - a stale cache hit shows up here immediately.
      for (const entry of layout) {
        const record = internal.sources.find((candidate) => candidate.source === entry.source)!;
        const view = entry.source.getUnifiedSourceView();
        for (let slot = entry.offset; slot < entry.offset + entry.activeCount; slot++) {
          const written = shadow[slot];
          expect(written, `slot ${slot} was never gathered`).not.toBeNull();
          expect(written!.source).toBe(entry.source);
          expect(written!.contentRevision).toBe(view.contentRevision);
          expect(written!.opacity).toBe(record.opacity);
          expect(written!.matrix.equals(view.matrixWorld)).toBe(true);
        }
      }
    }

    unified.dispose();
    for (const extra of extras) extra.dispose();
    main.dispose();
  });

  it('never regathers or rebuilds gather pipelines when only depth of field changes', () => {
    const renderer = mockRenderer();
    const mesh = staticSource(3);
    const unified = new UnifiedSplatRenderer(renderer, 8);
    const internal = unified as unknown as PrivateUnified;
    unified.addSource(mesh);
    const camera = new THREE.PerspectiveCamera();
    const calls: GatherCall[] = [];
    restores.push(instrumentGather(calls));
    unified.update(camera);
    const gatherInstance = internal.sources[0]!.gather;

    calls.length = 0;
    unified.setDepthOfField({ focusDistance: 4, aperture: 0.05 });
    unified.update(camera);
    unified.setDepthOfField({ aperture: 0 });
    unified.update(camera);
    expect(calls).toHaveLength(0);
    expect(internal.sources[0]!.gather).toBe(gatherInstance);
    expect(unified.getDepthOfField()).toEqual({ focusDistance: 4, aperture: 0 });

    unified.dispose();
    mesh.dispose();
  });

  it('regathers a slice after an opacity change and caches it again afterwards', () => {
    const renderer = mockRenderer();
    const mesh = staticSource(2);
    const unified = new UnifiedSplatRenderer(renderer, 4);
    unified.addSource(mesh);
    const camera = new THREE.PerspectiveCamera();
    const calls: GatherCall[] = [];
    restores.push(instrumentGather(calls));
    unified.update(camera);
    expect(calls).toHaveLength(1);

    calls.length = 0;
    unified.setSourceOpacity(mesh, 0.25);
    unified.update(camera);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opacity).toBe(0.25);

    calls.length = 0;
    unified.update(camera);
    expect(calls).toHaveLength(0);

    unified.dispose();
    mesh.dispose();
  });

  it('regathers a static slice after the source mesh moves', () => {
    const renderer = mockRenderer();
    const mesh = staticSource(2);
    const unified = new UnifiedSplatRenderer(renderer, 4);
    unified.addSource(mesh);
    const camera = new THREE.PerspectiveCamera();
    const calls: GatherCall[] = [];
    restores.push(instrumentGather(calls));
    unified.update(camera);

    calls.length = 0;
    mesh.position.set(1, 2, 3);
    unified.update(camera);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.matrix.equals(mesh.matrixWorld)).toBe(true);

    unified.dispose();
    mesh.dispose();
  });

  it('skips empty sources entirely instead of dispatching zero-splat gathers', () => {
    const renderer = mockRenderer();
    const empty = new SplatMesh({ capacity: 2048 });
    const full = staticSource(2);
    const unified = new UnifiedSplatRenderer(renderer, 4);
    unified.addSource(empty);
    unified.addSource(full);
    const camera = new THREE.PerspectiveCamera();
    const calls: GatherCall[] = [];
    restores.push(instrumentGather(calls));
    unified.update(camera);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.activeCount).toBe(2);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(2);
    expect(unified.droppedSourceCount).toBe(0);

    unified.dispose();
    empty.dispose();
    full.dispose();
  });

  it('survives a modifier stack that throws during gather rebuild and recovers on retry', () => {
    const renderer = mockRenderer();
    const mesh = staticSource(1);
    const unified = new UnifiedSplatRenderer(renderer, 2);
    const internal = unified as unknown as PrivateUnified;
    unified.addSource(mesh);
    const camera = new THREE.PerspectiveCamera();
    unified.update(camera);
    const survivor = internal.sources[0]!.gather;
    const survivorDispose = vi.spyOn(survivor, 'dispose');

    // TSL graphs build lazily under a mocked renderer, so force the rebuild
    // failure a throwing modifier would produce at pipeline-build time.
    const target = unified as unknown as { createGather: (view: unknown) => WorkBufferGather };
    const realCreateGather = target.createGather.bind(unified);
    let armed = true;
    target.createGather = (view: unknown) => {
      if (armed) throw new Error('boom');
      return realCreateGather(view);
    };
    mesh.modifiers = [() => ({})];
    expect(() => unified.update(camera)).toThrow('boom');
    // The failed rebuild must not have destroyed the still-referenced gather.
    expect(survivorDispose).not.toHaveBeenCalled();
    expect(internal.sources[0]!.gather).toBe(survivor);

    armed = false;
    expect(() => unified.update(camera)).not.toThrow();
    expect(internal.sources[0]!.gather).not.toBe(survivor);
    expect(survivorDispose).toHaveBeenCalledTimes(1);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);

    unified.dispose();
    mesh.dispose();
  });

  it('keeps capacity accounting exact when sources overflow and later fit again', () => {
    const renderer = mockRenderer();
    const big = staticSource(6);
    const small = staticSource(3);
    const unified = new UnifiedSplatRenderer(renderer, 8);
    unified.addSource(big, { priority: 1 });
    unified.addSource(small, { priority: 0 });
    const camera = new THREE.PerspectiveCamera();
    unified.update(camera);
    // 6 + 3 > 8: the low-priority source is dropped whole.
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(6);
    expect(unified.droppedSourceCount).toBe(1);
    expect(unified.droppedSplatCount).toBe(3);

    unified.setSourceVisible(big, false);
    unified.update(camera);
    expect((unified.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(3);
    expect(unified.droppedSourceCount).toBe(0);
    expect(unified.droppedSplatCount).toBe(0);

    unified.dispose();
    big.dispose();
    small.dispose();
  });
});
