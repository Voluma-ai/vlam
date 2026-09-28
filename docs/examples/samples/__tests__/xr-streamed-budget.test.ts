import type * as THREE from 'three/webgpu';
import type { StreamedSplatMesh } from '@voluma/vlam/streaming';
import { describe, expect, it, vi } from 'vitest';
import { SessionEvents } from './test-utils';
import { useXrBudget } from '../xr-streamed-budget';

vi.mock('@voluma/vlam', async () => import('../../../../src/lib/core/splat-budget'));

function fixture(budget: number, presenting = false) {
  const xr = Object.assign(new SessionEvents(), { isPresenting: presenting });
  const mesh = {
    budget,
    // Deliberately allow headroom, so an accidental increase is observable.
    setBudget: vi.fn((next: number) => (mesh.budget = Math.min(next, 5_000_000))),
  };
  const cleanup = useXrBudget(
    { xr } as unknown as THREE.WebGPURenderer,
    mesh as unknown as StreamedSplatMesh,
  );
  return { xr, mesh, cleanup };
}

describe('streamed XR example budget', () => {
  it('never raises a smaller explicit budget and captures it at entry', () => {
    const { xr, mesh, cleanup } = fixture(1_000_000);
    mesh.setBudget(200_000);
    xr.emit('sessionstart');
    expect(mesh.budget).toBe(200_000);
    xr.emit('sessionend');
    expect(mesh.budget).toBe(200_000);
    cleanup();
  });

  it('restores each session budget, including after duplicate start events', () => {
    const { xr, mesh, cleanup } = fixture(1_500_000);
    xr.emit('sessionstart');
    expect(mesh.budget).toBe(600_000);
    xr.emit('sessionstart');
    xr.emit('sessionend');
    expect(mesh.budget).toBe(1_500_000);
    mesh.setBudget(900_000);
    xr.emit('sessionstart');
    xr.emit('sessionend');
    expect(mesh.budget).toBe(900_000);
    cleanup();
  });

  it('handles an existing session and removes listeners on cleanup', () => {
    const { xr, mesh, cleanup } = fixture(1_500_000, true);
    expect(mesh.budget).toBe(600_000);
    cleanup();
    expect(mesh.budget).toBe(1_500_000);
    mesh.setBudget.mockClear();
    xr.emit('sessionstart');
    xr.emit('sessionend');
    cleanup();
    expect(mesh.setBudget).not.toHaveBeenCalled();
  });
});
