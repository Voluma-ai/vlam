import { describe, expect, it, vi } from 'vitest';
import { SplatMesh } from '../core/splat-mesh';
import type { SplatSorter } from '../core/sorter';
import type { WebGpuSortScheduler } from '../core/sort-scheduler';
import { exactSort, radixSort } from '../sorting/radix';

function setup() {
  const mesh = new SplatMesh({ capacity: 2048 });
  const internals = mesh as unknown as {
    sorter: SplatSorter | null;
    sortScheduler: WebGpuSortScheduler;
  };
  const dispose = vi.fn();
  internals.sorter = { kind: 'counting', sort: () => true, dispose };
  internals.sortScheduler.markAccepted(10);
  return { mesh, internals, dispose };
}

describe('live sorter selection', () => {
  it('replaces the sorter and forces a sort with a stationary camera', async () => {
    const { mesh, internals, dispose } = setup();
    const radix = radixSort();
    await mesh.setSortStrategy(radix);
    expect(mesh.sortStrategy).toBe(radix);
    expect(dispose).toHaveBeenCalledOnce();
    expect(internals.sorter).toBeNull();
    expect(internals.sortScheduler.hasPendingForce()).toBe(true);
    await mesh.setSortStrategy('counting');
    expect(mesh.sortStrategy).toBe('counting');
    mesh.dispose();
  });

  it('leaves counting in place when requested again', async () => {
    const { mesh, internals, dispose } = setup();
    await mesh.setSortStrategy('counting');
    expect(mesh.sortStrategy).toBe('counting');
    expect(dispose).not.toHaveBeenCalled();
    expect(internals.sortScheduler.hasPendingForce()).toBe(false);
    mesh.dispose();
  });

  it('does not install a strategy after the scene is disposed', async () => {
    const { mesh, internals, dispose } = setup();
    mesh.dispose();
    await mesh.setSortStrategy(exactSort());
    expect(mesh.sortStrategy).toBe('counting');
    expect(internals.sorter).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects the former radix string instead of falling through to counting', () => {
    expect(() => new SplatMesh({ capacity: 8 }, { sortStrategy: 'radix' as never })).toThrow(
      /unsupported sortStrategy "radix"/,
    );
  });
});
