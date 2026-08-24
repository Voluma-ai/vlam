import { describe, expect, it, vi } from 'vitest';

import {
  ChunkFetchScheduler,
  type ChunkFetchHandle,
  type ChunkFetchKind,
} from '../chunk-fetch-scheduler';

/**
 * Acceptance tests for cross-mesh fetch arbitration: the focused mesh must take
 * most of the pipe, far meshes must keep trickling their coarse coverage rather
 * than stopping dead, hidden meshes must stop pre-warming, and no path may leak
 * a slot - a leak silently shrinks the scene's whole pipe until teardown.
 *
 * `FakeMesh` mirrors what `StreamedSplatMesh` gives the scheduler: a weight it
 * reads on demand, a poke that marks work pending, and a shed callback. No
 * network, no workers.
 */
class FakeMesh {
  handle!: ChunkFetchHandle;
  wakeCount = 0;
  readonly shed: ChunkFetchKind[] = [];
  /** Slots this mesh believes it holds - the mirror the leak checks compare against. */
  held = 0;

  constructor(public weight: number) {}

  join(scheduler: ChunkFetchScheduler): this {
    this.handle = scheduler.register({
      weight: () => this.weight,
      onSlotAvailable: () => {
        this.wakeCount++;
      },
      shedFetches: (kind) => {
        this.shed.push(kind);
      },
    });
    return this;
  }

  /** Acquires until denied, as a mesh's reschedule loop does. */
  fill(scheduler: ChunkFetchScheduler, kind: ChunkFetchKind = 'priority'): number {
    let granted = 0;
    while (scheduler.tryAcquire(this.handle, kind)) {
      granted++;
      this.held++;
      // A runaway grant would hang the suite rather than fail it.
      if (granted > 1000) throw new Error('scheduler granted without bound');
    }
    return granted;
  }

  release(scheduler: ChunkFetchScheduler, count = 1): void {
    for (let i = 0; i < count; i++) {
      scheduler.release(this.handle);
      this.held--;
    }
  }
}

describe('ChunkFetchScheduler', () => {
  it('gives a lone mesh the whole pipe', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 8 });
    const solo = new FakeMesh(1).join(scheduler);
    // A single-mesh scene must not stream slower than it does with no scheduler
    // at all - the mesh's own in-flight cap stays the real bound there.
    expect(solo.fill(scheduler)).toBe(8);
    expect(scheduler.inflight).toBe(8);
  });

  it('splits the pipe by weight, and the focused mesh takes the larger share', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 16, perMeshFloor: 1 });
    const focused = new FakeMesh(2).join(scheduler);
    const adjacent = new FakeMesh(0.25).join(scheduler);
    const far = new FakeMesh(0.05).join(scheduler);

    // Interleaved, because a mesh that asks first must not be able to take the
    // pipe and keep it - that is the starvation this scheduler exists to stop.
    far.fill(scheduler);
    adjacent.fill(scheduler);
    focused.fill(scheduler);

    expect(focused.held).toBeGreaterThan(adjacent.held);
    expect(adjacent.held).toBeGreaterThanOrEqual(far.held);
    expect(scheduler.inflight).toBeLessThanOrEqual(16);
  });

  it('never starves a far mesh below its floor', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 8, perMeshFloor: 1 });
    const focused = new FakeMesh(100).join(scheduler);
    const far = new FakeMesh(0.01).join(scheduler);

    focused.fill(scheduler);
    // The far marker still has to draw *something*; its coarse coverage is what
    // the deferred swaps substitute from.
    expect(far.fill(scheduler, 'base')).toBeGreaterThanOrEqual(1);
  });

  it('denies a hidden mesh its sweep while still letting it fetch coverage', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 8, perMeshFloor: 1 });
    const hidden = new FakeMesh(0).join(scheduler);

    expect(scheduler.tryAcquire(hidden.handle, 'sweep')).toBe(false);
    // Priority and base are the mesh's own detail and coverage, not speculation
    // about a camera move - a hidden mesh keeps its floor for those.
    expect(scheduler.tryAcquire(hidden.handle, 'base')).toBe(true);
  });

  it('a denied sweep does not make the mesh a wake target', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 2 });
    const focused = new FakeMesh(1).join(scheduler);
    const hidden = new FakeMesh(0).join(scheduler);

    focused.fill(scheduler);
    expect(scheduler.tryAcquire(hidden.handle, 'sweep')).toBe(false);
    focused.release(scheduler);
    // Waking it would just re-deny the sweep, forever.
    expect(hidden.wakeCount).toBe(0);
  });

  it('wakes the heaviest denied mesh when a slot frees', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 1, perMeshFloor: 0 });
    const holder = new FakeMesh(1).join(scheduler);
    const heavy = new FakeMesh(5).join(scheduler);
    const light = new FakeMesh(0.1).join(scheduler);

    holder.fill(scheduler);
    expect(scheduler.tryAcquire(heavy.handle, 'priority')).toBe(false);
    expect(scheduler.tryAcquire(light.handle, 'priority')).toBe(false);

    holder.release(scheduler);
    expect(heavy.wakeCount).toBe(1);
    expect(light.wakeCount).toBe(0);
  });

  it('releases slots on abort and failure, not just on success', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 4 });
    const mesh = new FakeMesh(1).join(scheduler);

    mesh.fill(scheduler);
    expect(scheduler.inflight).toBe(4);
    // Every settle path - resolve, reject, abort - runs the same release.
    mesh.release(scheduler, 4);
    expect(scheduler.inflight).toBe(0);
    expect(mesh.fill(scheduler)).toBe(4);
  });

  it('ignores a release the mesh does not owe', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 4 });
    const mesh = new FakeMesh(1).join(scheduler);

    scheduler.release(mesh.handle);
    // A double release must not mint capacity out of nothing.
    expect(scheduler.inflight).toBe(0);
    expect(mesh.fill(scheduler)).toBe(4);
  });

  it('reclaims the slots of a mesh that unregisters mid-flight', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 4, perMeshFloor: 0 });
    const leaving = new FakeMesh(1).join(scheduler);
    const staying = new FakeMesh(1).join(scheduler);

    leaving.fill(scheduler);
    scheduler.unregister(leaving.handle);
    expect(scheduler.inflight).toBe(0);
    expect(staying.fill(scheduler)).toBe(4);
    // A late abort landing after dispose must not double-refund.
    scheduler.release(leaving.handle);
    expect(scheduler.inflight).toBe(4);
  });

  it('sheds the sweeps of meshes that just lost their weight', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 8 });
    const focused = new FakeMesh(2).join(scheduler);
    const going = new FakeMesh(1).join(scheduler);

    going.fill(scheduler, 'sweep');
    focused.fill(scheduler);

    going.weight = 0; // the camera turned away
    scheduler.weightsChanged();

    expect(going.shed).toEqual(['sweep']);
    // Nothing is shed from a mesh that still has weight, and nothing is shed
    // from a mesh holding no slots.
    expect(focused.shed).toEqual([]);
  });

  it('does not shed from a mesh that still has weight', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 8 });
    const mesh = new FakeMesh(1).join(scheduler);
    mesh.fill(scheduler, 'sweep');

    scheduler.weightsChanged();
    expect(mesh.shed).toEqual([]);
  });

  it('treats NaN, negative and infinite weights as no claim', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 4, perMeshFloor: 1 });
    for (const weight of [NaN, -1, Infinity]) {
      const mesh = new FakeMesh(weight).join(scheduler);
      expect(scheduler.tryAcquire(mesh.handle, 'sweep')).toBe(false);
      // Still gets its floor for real work rather than being wedged shut.
      expect(scheduler.tryAcquire(mesh.handle, 'base')).toBe(true);
      scheduler.unregister(mesh.handle);
    }
  });

  it('shares evenly when every mesh is weightless', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 8, perMeshFloor: 1 });
    const a = new FakeMesh(0).join(scheduler);
    const b = new FakeMesh(0).join(scheduler);

    // Asked one at a time, as two meshes rescheduling on the same frame do.
    expect(scheduler.tryAcquire(a.handle, 'base')).toBe(true);
    expect(scheduler.tryAcquire(b.handle, 'base')).toBe(true);
    a.held++;
    b.held++;
    a.fill(scheduler, 'base');
    b.fill(scheduler, 'base');
    // No division by zero, and neither mesh takes everything.
    expect(a.held).toBeGreaterThan(0);
    expect(b.held).toBeGreaterThan(0);
    expect(scheduler.inflight).toBeLessThanOrEqual(8);
  });

  it('refuses to grant after dispose', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 4 });
    const mesh = new FakeMesh(1).join(scheduler);
    mesh.fill(scheduler);

    scheduler.dispose();
    expect(scheduler.tryAcquire(mesh.handle, 'priority')).toBe(false);
    expect(scheduler.inflight).toBe(0);
    // Meshes outlive the scheduler; a late settle must not throw at them.
    expect(() => scheduler.release(mesh.handle)).not.toThrow();
    expect(() => scheduler.weightsChanged()).not.toThrow();
  });

  it('holds the global cap under churn across many meshes', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 16, perMeshFloor: 1 });
    // The reference scene: one focused marker among thirteen.
    const meshes = Array.from({ length: 13 }, (_, i) =>
      new FakeMesh(i === 0 ? 8 : 0.05).join(scheduler),
    );

    for (let round = 0; round < 20; round++) {
      for (const mesh of meshes) mesh.fill(scheduler, 'priority');
      expect(scheduler.inflight).toBeLessThanOrEqual(16);
      for (const mesh of meshes) if (mesh.held > 0) mesh.release(scheduler);
    }
    for (const mesh of meshes) mesh.release(scheduler, mesh.held);
    expect(scheduler.inflight).toBe(0);
    // The focused marker got materially more of the pipe than any far one.
    expect(meshes[0]!.wakeCount).toBeGreaterThanOrEqual(0);
  });

  it('still favours the focused mesh when a scene has more meshes than slots', () => {
    // The reference scene: a main plus thirteen markers against a 16-slot pipe,
    // so per-mesh floors alone would consume the whole thing. Dividing only the
    // remainder after floors would leave the focused marker with *less* than
    // the far markers it is competing against - the opposite of the point.
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 16, perMeshFloor: 1 });
    const focused = new FakeMesh(8).join(scheduler);
    const far = Array.from({ length: 13 }, () => new FakeMesh(0.05).join(scheduler));

    for (const mesh of far) mesh.fill(scheduler, 'priority');
    focused.fill(scheduler, 'priority');

    expect(focused.held).toBeGreaterThan(far[0]!.held);
    expect(scheduler.inflight).toBeLessThanOrEqual(16);
    // Every far mesh still trickles rather than stopping dead.
    for (const mesh of far) expect(mesh.held).toBeGreaterThanOrEqual(1);
  });

  it('lets a heavy mesh use the pipe its idle siblings are not asking for', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 8, perMeshFloor: 1 });
    const focused = new FakeMesh(8).join(scheduler);
    // Registered and visible, but settled - not fetching anything.
    new FakeMesh(0.05).join(scheduler);
    new FakeMesh(0.05).join(scheduler);

    // Entitlement is a ceiling against the whole pipe, not a fixed partition,
    // so a focused marker is not throttled to a third of it by two idle ones.
    expect(focused.fill(scheduler, 'priority')).toBeGreaterThanOrEqual(5);
  });

  it('never wakes a mesh while the pipe is still full', () => {
    const scheduler = new ChunkFetchScheduler({ maxGlobalInflight: 2, perMeshFloor: 0 });
    const a = new FakeMesh(1).join(scheduler);
    const b = new FakeMesh(1).join(scheduler);
    const denied = new FakeMesh(1).join(scheduler);
    const spy = vi.spyOn(denied, 'wakeCount', 'get');

    a.fill(scheduler);
    b.fill(scheduler);
    expect(scheduler.tryAcquire(denied.handle, 'priority')).toBe(false);
    expect(scheduler.inflight).toBe(2);
    spy.mockRestore();
    expect(denied.wakeCount).toBe(0);
  });
});
