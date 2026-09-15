import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';

import { SplatMesh } from '../core/splat-mesh';
import { SPLAT_DATA_TEXTURE_WIDTH, SplatPool } from '../core/splat-mesh-pool';
import { StreamedSplatMesh, type StreamedSplatMeshOptions } from '../streaming/streamed-splat-mesh';

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

/** A streamed mesh over a scene stub, as the other streamed tests build one. */
function makeStreamed(budget: number, capacity: number, options: StreamedSplatMeshOptions = {}) {
  const scene = {
    source: {
      budget,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      computeDesiredRuns: () => [],
      coarsestRunsFor: () => [],
    } as unknown,
    chunkUrls: [] as string[],
    chunkKind: 'file' as const,
    bounds: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(100, 100, 100)),
    pinnedFiles: new Set<number>(),
    maxResidentSplats: Math.max(capacity, budget),
    chunkSize: 65536,
  };
  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
  ) => StreamedSplatMesh;
  return new Ctor(scene, budget, capacity, options);
}

/**
 * Several meshes drawing from one pool.
 *
 * This is the multi-mesh budget story: instead of every mesh reserving a
 * private ceiling up front (so N additional meshes each get total/N, however close the
 * camera is to one of them), they draw from a shared envelope and rows go to
 * whoever asks. These tests pin the ownership rules that make that safe.
 */
describe('SplatMesh sharing a SplatPool', () => {
  const W = SPLAT_DATA_TEXTURE_WIDTH;
  /** Minimal SplatData-shaped source of `count` splats. */
  const data = (count: number) => ({
    count,
    positions: new Float32Array(count * 3),
    colors: new Uint8Array(count * 4),
    covariances: new Float32Array(count * 6),
  });

  it('lets one mesh hold most of a shared pool while another holds little', () => {
    const pool = new SplatPool({ capacity: 10 * W });
    const near = new SplatMesh(data(6 * W), { pool });
    const far = new SplatMesh(data(W), { pool });

    // The split is by demand, not by an even share: `near` holds 6/7 of the
    // allocated rows even though there are two meshes. Under per-mesh pools it
    // could never have exceeded its own ceiling.
    expect(pool.tenantCount).toBe(2);
    expect(near.activeSplatCount).toBe(6 * W);
    expect(far.activeSplatCount).toBe(W);
    expect(pool.freeRows).toBe(3);

    near.dispose();
    far.dispose();
  });

  it('does not dispose a shared pool with one of its meshes', () => {
    const pool = new SplatPool({ capacity: 4 * W });
    const a = new SplatMesh(data(W), { pool });
    const b = new SplatMesh(data(W), { pool });

    a.dispose();

    // The pool and its textures outlive `a` - `b` is still drawing from them.
    expect(pool.tenantCount).toBe(1);
    expect(pool.centersTexture.image.data).toBeInstanceOf(Float32Array);
    expect(b.activeSplatCount).toBe(W);
    // `a`'s rows came back, so the pool can hand them to a newcomer.
    expect(pool.freeRows).toBe(3);
    const newcomer = new SplatMesh(data(2 * W), { pool });
    expect(newcomer.activeSplatCount).toBe(2 * W);

    newcomer.dispose();
    b.dispose();
  });

  it('returns a departing mesh’s rows so compaction still balances', () => {
    const pool = new SplatPool({ capacity: 4 * W });
    const keep = new SplatMesh(data(W), { pool });
    const leave = new SplatMesh(data(W), { pool });

    leave.dispose();
    // dispose released the rows *and* unregistered the tenant, so the pool's
    // "every row is free or owned by a registered tenant" invariant holds.
    expect(() => pool.compact()).not.toThrow();
    expect(keep.activeSplatCount).toBe(W);

    keep.dispose();
  });

  it('needs a compaction when tenants leave holes, not merely free rows', () => {
    const pool = new SplatPool({ capacity: 4 * W });
    const a = new SplatMesh(data(W), { pool }); // row 0
    const b = new SplatMesh(data(W), { pool }); // row 1

    a.dispose(); // frees row 0, leaving a hole before b

    // Three rows are free but split either side of `b`, so a mesh needing
    // three contiguous rows cannot be placed. This is the cost sharing pays
    // that Spark's fixed interchangeable pages avoid.
    expect(pool.freeRows).toBe(3);
    expect(() => new SplatMesh(data(3 * W), { pool })).toThrow(/capacity exceeded/);

    // Packing the pool moves `b` down and restores one contiguous span.
    pool.compact();
    expect(pool.freeRowSpans).toEqual([{ start: 1, count: 3 }]);
    const big = new SplatMesh(data(3 * W), { pool });
    expect(big.activeSplatCount).toBe(3 * W);

    big.dispose();
    b.dispose();
  });

  it('still owns and frees a pool it allocated itself', () => {
    const mesh = new SplatMesh(data(W));
    // No pool was supplied, so disposing the mesh disposes its storage; the
    // textures are released rather than leaked.
    expect(() => mesh.dispose()).not.toThrow();
    expect(() => mesh.dispose()).not.toThrow(); // idempotent
  });

  it('lets streamed meshes share one pool, sized per mesh not per pool', () => {
    // The multi-mesh case: several streamed meshes over one envelope.
    const pool = new SplatPool({ capacity: 20 * W });
    const a = makeStreamed(2 * W, 4 * W, { pool });
    const b = makeStreamed(2 * W, 4 * W, { pool });

    expect(pool.tenantCount).toBe(2);
    // `capacity` reports the storage each mesh draws from - the shared pool.
    expect(a.capacity).toBe(20 * W);
    // But the per-mesh draw list is sized by what this mesh can hold, not by
    // the pool: otherwise every tenant would allocate a pool-sized draw list
    // and active list (8 B per pool splat, per mesh) and sharing would cost
    // more memory than it saves.
    const drawList = (a as unknown as { splatIndexAttribute: { array: Float32Array } })
      .splatIndexAttribute.array;
    expect(drawList).toHaveLength(4 * W);

    a.dispose();
    b.dispose();
  });

  it('gives a streamed mesh headroom from the shared pool, not a private ceiling', () => {
    const pool = new SplatPool({ capacity: 20 * W });
    // Two meshes whose ceilings together exceed any even split of the pool:
    // each may climb to 8 rows of a 20-row pool because the headroom is the
    // pool's, not reserved per mesh up front.
    const near = makeStreamed(W, 8 * W, { pool, maxBudget: 8 * W });
    const far = makeStreamed(W, 8 * W, { pool, maxBudget: 8 * W });

    expect(near.setBudget(8 * W)).toBe(8 * W);
    expect(far.budget).toBe(W);
    expect(pool.tenantCount).toBe(2);

    near.dispose();
    far.dispose();
  });

  it('downgrades an SH mesh into an SH0 shared pool', () => {
    const pool = new SplatPool({ capacity: 4 * W, packedShBands: 0, packedShTextureCount: 0 });
    const plain = new SplatMesh(data(W), { pool });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const withSh = new SplatMesh({ capacity: W }, { pool, shBands: 2 });

    expect((withSh as unknown as { pool: SplatPool }).pool).toBe(pool);
    expect(pool.tenantCount).toBe(2);
    expect(withSh.shBands).toBe(0);
    expect(
      (withSh as unknown as { shPackedTextures: readonly unknown[] }).shPackedTextures,
    ).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shared-pool memory limit'));
    warn.mockRestore();

    withSh.dispose();
    plain.dispose();
    pool.dispose();
  });

  it('keeps an SH-disabled mesh shared with an SH-capable pool', () => {
    const pool = new SplatPool({ capacity: 4 * W, packedShBands: 3, packedShTextureCount: 4 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mesh = new SplatMesh({ capacity: W }, { pool, shBands: 0 });

    expect((mesh as unknown as { pool: SplatPool }).pool).toBe(pool);
    expect(pool.tenantCount).toBe(1);
    expect(mesh.shBands).toBe(0);
    expect(
      (mesh as unknown as { shPackedTextures: readonly unknown[] }).shPackedTextures,
    ).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();

    mesh.dispose();
    pool.dispose();
  });

  it('retains matching packed SH while sharing the pool', () => {
    const pool = new SplatPool({ capacity: 4 * W, packedShBands: 3, packedShTextureCount: 4 });
    const mesh = new SplatMesh({ capacity: W }, { pool, shBands: 3 });

    expect((mesh as unknown as { pool: SplatPool }).pool).toBe(pool);
    expect(pool.tenantCount).toBe(1);
    expect(mesh.shBands).toBe(3);
    expect(
      (mesh as unknown as { shPackedTextures: readonly unknown[] }).shPackedTextures,
    ).toHaveLength(4);

    mesh.dispose();
    pool.dispose();
  });
});
