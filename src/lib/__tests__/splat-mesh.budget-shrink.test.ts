import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import type { SplatData } from '../core/splat-data';
import { SplatMesh } from '../core/splat-mesh';
import { SplatPool } from '../core/splat-mesh-pool';
import { SplatSceneBudget } from '../loaders/splat-scene-budget';

const WIDTH = 2048;

/** Splat i sits at x = i; `drawOrder` ranks them by a fixed shuffle. */
function data(count: number, extra: Partial<SplatData> = {}): SplatData {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) positions[i * 3] = i;
  const colors = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) colors[i * 4] = i % 256;
  const drawOrder = Uint32Array.from({ length: count }, (_, i) => (i * 7919) % count);
  return {
    count,
    positions,
    colors,
    covariances: new Float32Array(count * 6),
    drawOrder,
    ...extra,
  };
}

/** Test-local view of the pool and draw list a shrink rewrites. */
function internals(mesh: SplatMesh) {
  const view = mesh as unknown as {
    pool: SplatPool;
    sourceIndexAttribute: THREE.StorageBufferAttribute;
    staticDrawOrder: Uint32Array | null;
  };
  return {
    pool: view.pool,
    activeIndices: () =>
      Array.from(
        (view.sourceIndexAttribute.array as Uint32Array).subarray(0, mesh.activeSplatCount),
      ),
    order: () => view.staticDrawOrder,
    centerX: (row: number) => view.pool.backing.centers[row * 4] as number,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('SplatMesh.shrinkToBudget', () => {
  it('keeps a prefix of the draw order in pool order and reallocates the pool', () => {
    const count = 5000; // three pool rows
    const source = data(count);
    const order = Array.from(source.drawOrder ?? []);
    const mesh = new SplatMesh(source);
    const { pool, activeIndices, centerX } = internals(mesh);
    expect(pool.rows).toBe(3);
    const disposed = vi.fn();
    pool.centersTexture.addEventListener('dispose', disposed);

    expect(mesh.budgetShrinkable).toBe(true);
    expect(mesh.shrinkToBudget(2100)).toBe(2100);

    expect(mesh.budgetedSplatCount).toBe(2100);
    expect(mesh.activeSplatCount).toBe(2100);
    expect(mesh.capacity).toBe(2 * WIDTH);
    expect(pool.rows).toBe(2);
    expect(pool.backing.centers.length).toBe(2 * WIDTH * 4);
    expect(pool.centersTexture.image.height).toBe(2);
    expect(pool.centersTexture.image.data).toBe(pool.backing.centers);
    expect(disposed).toHaveBeenCalledTimes(1);
    // The kept splats are exactly the first 2100 ranked, packed in pool order.
    const kept = order.slice(0, 2100).sort((a, b) => a - b);
    expect(Array.from({ length: 2100 }, (_, row) => centerX(row))).toEqual(kept);
    expect(activeIndices()).toEqual(Array.from({ length: 2100 }, (_, i) => i));
  });

  it('keeps the importance order across repeated shrinks', () => {
    const source = data(3000);
    const order = Array.from(source.drawOrder ?? []);
    const mesh = new SplatMesh(source);
    const { centerX } = internals(mesh);
    mesh.shrinkToBudget(1000);
    mesh.shrinkToBudget(10);
    const kept = order.slice(0, 10).sort((a, b) => a - b);
    expect(Array.from({ length: 10 }, (_, row) => centerX(row))).toEqual(kept);
    expect(mesh.capacity).toBe(WIDTH);
  });

  it('moves channel values with their splats and resizes the channel texture', () => {
    const source = data(3000);
    const order = Array.from(source.drawOrder ?? []);
    const mesh = new SplatMesh(source);
    mesh.defineChannel('mask');
    const values = Float32Array.from({ length: 3000 }, (_, i) => i);
    const staticRange = (
      mesh as unknown as { staticRange: Parameters<SplatMesh['writeChannel']>[0] }
    ).staticRange;
    mesh.writeChannel(staticRange, 'mask', values);
    mesh.shrinkToBudget(500);
    const channel = (
      mesh as unknown as {
        channels: Map<string, { backing: Float32Array; texture: THREE.DataTexture }>;
      }
    ).channels.get('mask');
    expect(channel?.backing.length).toBe(WIDTH);
    expect(channel?.texture.image.height).toBe(1);
    const kept = order.slice(0, 500).sort((a, b) => a - b);
    expect(Array.from(channel?.backing.subarray(0, 500) ?? [])).toEqual(kept);
  });

  it('cannot shrink without a draw order, on a shared pool, or render-only', () => {
    const plain = new SplatMesh(data(100, { drawOrder: undefined }));
    expect(plain.budgetShrinkable).toBe(false);
    expect(plain.shrinkToBudget(10)).toBe(100);

    const pool = new SplatPool({ capacity: 4096 });
    const shared = new SplatMesh(data(100), { pool });
    expect(shared.budgetShrinkable).toBe(false);
    expect(shared.shrinkToBudget(10)).toBe(100);

    const renderOnly = new SplatMesh(data(100), { storageMode: 'render-only' });
    expect(renderOnly.shrinkToBudget(10)).toBe(100);

    const disposed = new SplatMesh(data(100));
    disposed.dispose();
    expect(disposed.budgetShrinkable).toBe(false);
  });
});

describe('SplatPool.shrinkRows', () => {
  it('reallocates backing and textures and clips the free list', () => {
    const pool = new SplatPool({ capacity: 4 * WIDTH, floatTextures: 'float16' });
    pool.backing.centers[0] = 7;
    pool.shrinkRows(2);
    expect(pool.rows).toBe(2);
    expect(pool.capacity).toBe(2 * WIDTH);
    expect(pool.backing.centers.length).toBe(2 * WIDTH * 4);
    expect(pool.backing.centers[0]).toBe(7);
    // Float16 images are separate and re-encoded by the tenant.
    expect(pool.centersTexture.image.data).toBeInstanceOf(Uint16Array);
    expect(pool.colorsTexture.image.data).toBe(pool.backing.colors);
    expect(pool.freeRowSpans).toEqual([{ start: 0, count: 2 }]);
    expect(() => pool.shrinkRows(3)).toThrow(RangeError);
  });

  it('refuses a shared pool', () => {
    const pool = new SplatPool({ capacity: 4 * WIDTH });
    const a = new SplatMesh({ capacity: WIDTH }, { pool });
    const b = new SplatMesh({ capacity: WIDTH }, { pool });
    expect(() => pool.shrinkRows(1)).toThrow(/shared/);
    a.dispose();
    b.dispose();
  });
});

describe('SplatMesh.shrinkToBudget under an in-flight GPU sort', () => {
  it('draws nothing until a sort over the shrunk list lands', async () => {
    let resolve = (): void => {};
    const completion = new Promise<void>((done) => {
      resolve = done;
    });
    const renderer = {
      backend: {
        isWebGPUBackend: true,
        device: { queue: { onSubmittedWorkDone: () => completion } },
      },
      getDrawingBufferSize: (out: THREE.Vector2) => out.set(800, 600),
      compute: vi.fn(),
      copyTextureToTexture: vi.fn(),
    } as unknown as THREE.WebGPURenderer;
    const mesh = new SplatMesh(data(3000), { sortIntervalMs: 1000 });
    const sort = vi.fn(() => true);
    (mesh as unknown as { sorter: unknown }).sorter = { kind: 'counting', sort, dispose: vi.fn() };
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.updateMatrixWorld(true);
    const geometry = mesh.geometry as THREE.InstancedBufferGeometry;
    vi.spyOn(performance, 'now').mockReturnValue(0);

    mesh.update(camera, renderer);
    mesh.onAfterRender(renderer as never, new THREE.Scene(), camera);
    expect(sort).toHaveBeenCalledTimes(1);
    expect(geometry.instanceCount).toBe(3000);

    // The sort still owns the order buffer, which indexes the old layout.
    mesh.shrinkToBudget(1000);
    expect(geometry.instanceCount).toBe(0);
    mesh.update(camera, renderer);
    expect(geometry.instanceCount).toBe(0);

    resolve();
    await Promise.resolve();
    mesh.update(camera, renderer);
    expect(sort).toHaveBeenCalledTimes(2);
    expect(geometry.instanceCount).toBe(1000);
    mesh.dispose();
  });
});

describe('SplatSceneBudget re-balancing', () => {
  function loaded(budget: SplatSceneBudget, count: number): SplatMesh {
    const reservation = budget.reserve(count);
    const source = data(Math.min(count, reservation.maxSplats));
    reservation.commit(source);
    return new SplatMesh(source);
  }

  it('shrinks loaded meshes to proportional shares when a late file does not fit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const budget = new SplatSceneBudget({ profile: null, total: 1000 });
    const a = loaded(budget, 600);
    const b = loaded(budget, 400);
    expect(budget.free).toBe(0);

    // C (1000 splats): sum 2000 → A 300, B 200, C 500.
    const c = budget.reserve(1000);
    expect(a.budgetedSplatCount).toBe(300);
    expect(b.budgetedSplatCount).toBe(200);
    expect(c.maxSplats).toBe(500);
    expect(budget.free).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.join(' '))).toMatch(/re-balanced/);
  });

  it('judges shares by original counts, so a thinned file is not penalised twice', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const budget = new SplatSceneBudget({ profile: null, total: 1000 });
    const reservation = budget.reserve(4000);
    const source = data(1000, { sourceCount: 4000 });
    reservation.commit(source);
    const a = new SplatMesh(source);
    // Sum 5000: A's fair share is 800 by its original 4000, not 1000/5000.
    budget.reserve(1000);
    expect(a.budgetedSplatCount).toBe(800);
  });

  it('leaves loaded meshes alone when the free share covers the newcomer', () => {
    const budget = new SplatSceneBudget({ profile: null, total: 1000 });
    const a = loaded(budget, 700);
    // Sum 1000: the newcomer's fair share (300) is free already.
    expect(budget.reserve(300).maxSplats).toBe(300);
    expect(a.budgetedSplatCount).toBe(700);
  });

  it('never counts on a mesh that cannot shrink', () => {
    const budget = new SplatSceneBudget({ profile: null, total: 1000 });
    const reservation = budget.reserve(1000);
    const source = data(1000, { drawOrder: undefined });
    reservation.commit(source);
    const a = new SplatMesh(source);
    expect(budget.reserve(1000).maxSplats).toBe(0);
    expect(a.budgetedSplatCount).toBe(1000);
  });
});
