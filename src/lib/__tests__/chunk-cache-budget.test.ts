import { describe, expect, it } from 'vitest';

import { ChunkCacheBudget, type ChunkCacheHandle } from '../chunk-cache-budget';

/**
 * Acceptance tests for the scene-wide decoded-chunk cache ceiling.
 *
 * The invariant that matters is `Σ allowance <= totalBytes` in every branch:
 * the whole point of the class is that a scene of thirteen additional meshes cannot each
 * take `min(2 GiB, its own capture)` and collectively exceed the tab's heap. A
 * budget that can be overrun by registering another mesh would be worse than
 * none, because it reads as a bound while not being one.
 *
 * `FakeMesh` mirrors what `StreamedSplatMesh` gives the budget: a weight it
 * reads on demand, a ceiling from its capture size, and a callback that would
 * post to its frontier worker. No workers, no network.
 */
class FakeMesh {
  handle!: ChunkCacheHandle;
  /** Allowances delivered through `onAllowanceChanged`, in order. */
  readonly notified: number[] = [];

  constructor(
    public weight: number,
    public ceilingBytes = Number.MAX_SAFE_INTEGER,
  ) {}

  join(budget: ChunkCacheBudget): this {
    this.handle = budget.register({
      weight: () => this.weight,
      ceilingBytes: this.ceilingBytes,
      onAllowanceChanged: (bytes) => this.notified.push(bytes),
    });
    return this;
  }
}

const MIB = 1024 * 1024;

/** Total currently allocated across every registered mesh. */
const allocated = (budget: ChunkCacheBudget, meshes: readonly FakeMesh[]) =>
  meshes.reduce((sum, mesh) => sum + budget.allowanceFor(mesh.handle), 0);

describe('ChunkCacheBudget', () => {
  it('rejects a non-positive total rather than silently allocating nothing', () => {
    expect(() => new ChunkCacheBudget({ totalBytes: 0 })).toThrow(RangeError);
    expect(() => new ChunkCacheBudget({ totalBytes: Number.NaN })).toThrow(RangeError);
  });

  it('never allocates more than the scene total, however many meshes register', () => {
    const budget = new ChunkCacheBudget({ totalBytes: 1024 * MIB, perMeshFloorBytes: 32 * MIB });
    const meshes: FakeMesh[] = [];
    // Fourteen is the shape that motivated this: one main plus thirteen additional meshes.
    for (let i = 0; i < 14; i++) {
      meshes.push(new FakeMesh(i + 1).join(budget));
      expect(allocated(budget, meshes)).toBeLessThanOrEqual(budget.totalBytes);
    }
  });

  it('holds the invariant when the floors alone would exceed the total', () => {
    // 10 meshes x 32 MiB floor against a 64 MiB envelope: the floors cannot all
    // be honoured, and the budget must scale back rather than overcommit.
    const budget = new ChunkCacheBudget({ totalBytes: 64 * MIB, perMeshFloorBytes: 32 * MIB });
    const meshes = Array.from({ length: 10 }, (_, i) => new FakeMesh(i + 1).join(budget));
    expect(allocated(budget, meshes)).toBeLessThanOrEqual(budget.totalBytes);
  });

  it('holds the invariant when every mesh is hidden', () => {
    const budget = new ChunkCacheBudget({ totalBytes: 512 * MIB });
    const meshes = Array.from({ length: 5 }, () => new FakeMesh(0).join(budget));
    expect(allocated(budget, meshes)).toBeLessThanOrEqual(budget.totalBytes);
    // Even shares rather than a divide-by-zero or a starved scene.
    const first = budget.allowanceFor(meshes[0]!.handle);
    expect(first).toBeGreaterThan(0);
    for (const mesh of meshes) expect(budget.allowanceFor(mesh.handle)).toBe(first);
  });

  it('gives the near mesh more than the far ones', () => {
    const budget = new ChunkCacheBudget({ totalBytes: 1024 * MIB, perMeshFloorBytes: 8 * MIB });
    const near = new FakeMesh(10).join(budget);
    const far = new FakeMesh(1).join(budget);
    expect(budget.allowanceFor(near.handle)).toBeGreaterThan(budget.allowanceFor(far.handle));
  });

  it('keeps a hidden mesh on its floor rather than evicting its coarse base', () => {
    const budget = new ChunkCacheBudget({ totalBytes: 1024 * MIB, perMeshFloorBytes: 32 * MIB });
    const visible = new FakeMesh(100).join(budget);
    const hidden = new FakeMesh(0).join(budget);
    expect(budget.allowanceFor(hidden.handle)).toBe(32 * MIB);
    expect(budget.allowanceFor(visible.handle)).toBeGreaterThan(32 * MIB);
  });

  it('never gives a mesh more than its capture could use', () => {
    const budget = new ChunkCacheBudget({ totalBytes: 1024 * MIB, perMeshFloorBytes: 8 * MIB });
    const small = new FakeMesh(100, 4 * MIB).join(budget);
    expect(budget.allowanceFor(small.handle)).toBe(4 * MIB);
  });

  it('flows a clamped mesh surplus to siblings that can use it', () => {
    const budget = new ChunkCacheBudget({ totalBytes: 1024 * MIB, perMeshFloorBytes: 8 * MIB });
    // Both heavy, but one can only use 4 MiB - the other should get far more
    // than the even split it would have received without the redistribution.
    const tiny = new FakeMesh(1, 4 * MIB).join(budget);
    const large = new FakeMesh(1).join(budget);
    expect(budget.allowanceFor(tiny.handle)).toBe(4 * MIB);
    expect(budget.allowanceFor(large.handle)).toBeGreaterThan(512 * MIB);
    expect(allocated(budget, [tiny, large])).toBeLessThanOrEqual(budget.totalBytes);
  });

  it('reallocates when a mesh unregisters', () => {
    const budget = new ChunkCacheBudget({ totalBytes: 1024 * MIB, perMeshFloorBytes: 8 * MIB });
    const staying = new FakeMesh(1).join(budget);
    const leaving = new FakeMesh(1).join(budget);
    const before = budget.allowanceFor(staying.handle);

    budget.unregister(leaving.handle);

    expect(budget.allowanceFor(staying.handle)).toBeGreaterThan(before);
    expect(budget.allowanceFor(leaving.handle)).toBe(0);
    expect(budget.clientCount).toBe(1);
  });

  it('does not notify a mesh of its own opening allowance', () => {
    // The mesh reads that one out of `allowanceFor` for its worker init; a
    // callback before the worker exists would be posted into nothing.
    const budget = new ChunkCacheBudget({ totalBytes: 1024 * MIB });
    const mesh = new FakeMesh(1).join(budget);
    expect(mesh.notified).toEqual([]);
    expect(budget.allowanceFor(mesh.handle)).toBeGreaterThan(0);
  });

  it('suppresses reposts for changes inside the dead-band', () => {
    const budget = new ChunkCacheBudget({
      totalBytes: 1024 * MIB,
      perMeshFloorBytes: 0,
      minIntervalMs: 0,
      deadband: 0.15,
    });
    const a = new FakeMesh(100).join(budget);
    new FakeMesh(100).join(budget);
    a.notified.length = 0;

    // ~2% move: below the dead-band, so nothing is posted.
    a.weight = 102;
    budget.weightsChanged(1000);
    expect(a.notified).toEqual([]);

    // 3x: well past it.
    a.weight = 300;
    budget.weightsChanged(2000);
    expect(a.notified.length).toBe(1);
  });

  it('rate-limits weight-driven reallocation but not membership changes', () => {
    const budget = new ChunkCacheBudget({
      totalBytes: 1024 * MIB,
      perMeshFloorBytes: 0,
      minIntervalMs: 250,
      deadband: 0,
    });
    const a = new FakeMesh(1).join(budget);
    new FakeMesh(1).join(budget);
    a.notified.length = 0;

    a.weight = 100;
    budget.weightsChanged(1000);
    const afterFirst = a.notified.length;
    // Inside the window: ignored.
    a.weight = 1000;
    budget.weightsChanged(1100);
    expect(a.notified.length).toBe(afterFirst);

    // A registration must not be deferred - the new mesh needs its allowance now.
    const third = new FakeMesh(1).join(budget);
    expect(budget.allowanceFor(third.handle)).toBeGreaterThan(0);
    expect(a.notified.length).toBeGreaterThan(afterFirst);
  });

  it('re-splits when the scene envelope is resized', () => {
    const budget = new ChunkCacheBudget({ totalBytes: 1024 * MIB, perMeshFloorBytes: 0 });
    const mesh = new FakeMesh(1).join(budget);
    const before = budget.allowanceFor(mesh.handle);

    budget.setTotalBytes(512 * MIB);

    expect(budget.allowanceFor(mesh.handle)).toBeLessThan(before);
    expect(mesh.notified.at(-1)).toBe(budget.allowanceFor(mesh.handle));
  });

  it('is inert and idempotent after dispose', () => {
    const budget = new ChunkCacheBudget({ totalBytes: 1024 * MIB });
    const mesh = new FakeMesh(1).join(budget);

    budget.dispose();
    budget.dispose();

    expect(budget.clientCount).toBe(0);
    expect(budget.allowanceFor(mesh.handle)).toBe(0);
    mesh.notified.length = 0;
    budget.weightsChanged(9999);
    expect(mesh.notified).toEqual([]);
  });
});
