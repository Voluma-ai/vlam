import { describe, expect, it, vi } from 'vitest';
import { SplatMesh } from '../core/splat-mesh';
import type { SplatSorter } from '../core/sorter';
import type { WebGpuSortScheduler } from '../core/sort-scheduler';

function setup() {
  const mesh = new SplatMesh({ capacity: 2048 });
  const internals = mesh as unknown as {
    sorter: SplatSorter | null;
    sortScheduler: WebGpuSortScheduler;
    radixSorterLoad: Promise<void> | null;
  };
  const dispose = vi.fn();
  internals.sorter = { kind: 'counting', sort: () => true, dispose };
  internals.sortScheduler.markAccepted(10);
  return { mesh, internals, dispose };
}

describe('live sorter selection', () => {
  it('replaces the sorter and forces a sort with a stationary camera', async () => {
    const { mesh, internals, dispose } = setup();
    await mesh.setSortStrategy('radix');
    expect(mesh.sortStrategy).toBe('radix');
    expect(dispose).toHaveBeenCalledOnce();
    expect(internals.sorter).toBeNull();
    expect(internals.sortScheduler.hasPendingForce()).toBe(true);
    await mesh.setSortStrategy('counting');
    expect(mesh.sortStrategy).toBe('counting');
    mesh.dispose();
  });

  it('keeps the old sorter during loading and cancels HD when switched back to SD', async () => {
    const { mesh, internals, dispose } = setup();
    let finish!: () => void;
    internals.radixSorterLoad = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending = mesh.setSortStrategy('radix');
    expect(mesh.sortStrategy).toBe('counting');
    expect(dispose).not.toHaveBeenCalled();
    await mesh.setSortStrategy('counting');
    finish();
    await pending;
    expect(mesh.sortStrategy).toBe('counting');
    expect(dispose).not.toHaveBeenCalled();
    expect(internals.sortScheduler.hasPendingForce()).toBe(false);
    mesh.dispose();
  });

  it('does not install a pending strategy after the scene is disposed', async () => {
    const { mesh, internals, dispose } = setup();
    let finish!: () => void;
    internals.radixSorterLoad = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending = mesh.setSortStrategy('exact');
    mesh.dispose();
    finish();
    await pending;
    expect(mesh.sortStrategy).toBe('counting');
    expect(internals.sorter).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
