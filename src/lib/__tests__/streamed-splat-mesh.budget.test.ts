import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { StreamedSplatMesh, type StreamedSplatMeshOptions } from '../streamed-splat-mesh';
import { setVlamLogHandler } from '../logging';

/**
 * The governed-budget contract on the mesh itself: `maxBudget` reserves pool
 * headroom a governor can grow into, `setBudget` reports the clamp so the
 * governor can redistribute, and in page-table mode the governed budget reaches
 * the frontier's draw target and Spark's `lodScale` reaches its cut.
 *
 * Built through the private constructor with a scene stub, as the other
 * `streamed-splat-mesh.*` tests do - no GPU, no network.
 */

const WIDTH = 2048;

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

/** Records what the mesh posts to the frontier worker. */
class RecordingWorker {
  static last: RecordingWorker | undefined;
  readonly posted: Record<string, unknown>[] = [];
  onmessage: unknown = null;
  onerror: unknown = null;
  constructor() {
    RecordingWorker.last = this;
  }
  postMessage(msg: Record<string, unknown>): void {
    this.posted.push(msg);
  }
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  /** The most recent `reschedule` message, which carries limit and budget. */
  get lastReschedule(): Record<string, unknown> | undefined {
    return [...this.posted].reverse().find((m) => m['type'] === 'reschedule');
  }
}

interface MeshFixture {
  /** Initial active-splat budget handed to the constructor. */
  budget?: number;
  /** Pool capacity in splats. */
  capacity?: number;
  /** Whether the scene advertises foveation (drives page-table wiring). */
  foveated?: boolean;
  options?: StreamedSplatMeshOptions;
}

function makeMesh({
  budget = 4 * WIDTH,
  capacity = 4 * WIDTH,
  foveated = false,
  options = {},
}: MeshFixture = {}): StreamedSplatMesh {
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
    bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 100, 100)),
    pinnedFiles: new Set<number>(),
    maxResidentSplats: Math.max(capacity, budget),
    chunkSize: 65536,
    ...(foveated ? { foveation: { minScreenRadiusPx: 1.6, maxScreenRadiusPx: 4 } } : {}),
  };
  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: unknown,
    FrontierWorkerCtor?: unknown,
  ) => StreamedSplatMesh;
  return new Ctor(scene, budget, capacity, options, foveated ? RecordingWorker : undefined);
}

/** Drives one page-table reschedule, which is what posts to the worker. */
function reschedulePageTable(mesh: StreamedSplatMesh, now: number): void {
  const inner = mesh as unknown as {
    reschedule: (camera: THREE.Camera, now: number) => unknown;
    pageTableInFlight: boolean;
    pendingWork: boolean;
  };
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 0, 200);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  inner.pageTableInFlight = false; // no real worker replies, so un-coalesce
  inner.reschedule(camera, now);
}

describe('StreamedSplatMesh budget ceiling', () => {
  const meshes: StreamedSplatMesh[] = [];
  afterEach(() => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
    setVlamLogHandler(undefined);
  });
  function track(mesh: StreamedSplatMesh): StreamedSplatMesh {
    meshes.push(mesh);
    return mesh;
  }

  it('lets setBudget climb to maxBudget when pool headroom was reserved', () => {
    const mesh = track(
      makeMesh({
        budget: WIDTH,
        capacity: 4 * WIDTH,
        options: { maxBudget: 4 * WIDTH },
      }),
    );
    expect(mesh.budget).toBe(WIDTH);
    expect(mesh.maxBudget).toBe(4 * WIDTH);
    expect(mesh.capacity).toBeGreaterThanOrEqual(4 * WIDTH);

    // The whole point: a governor can grow this mesh above its start budget.
    expect(mesh.setBudget(3 * WIDTH)).toBe(3 * WIDTH);
    expect(mesh.budget).toBe(3 * WIDTH);
    expect(mesh.setBudget(4 * WIDTH)).toBe(4 * WIDTH);
  });

  it('clamps at the construction budget when no maxBudget was given', () => {
    const mesh = track(makeMesh({ budget: WIDTH, capacity: 4 * WIDTH }));
    expect(mesh.maxBudget).toBe(WIDTH);
    // Unchanged behavior: asking for more reports the clamp rather than growing,
    // which is the signal BudgetGovernor redistributes on.
    expect(mesh.setBudget(10 * WIDTH)).toBe(WIDTH);
    expect(mesh.budget).toBe(WIDTH);
  });

  it('never lets maxBudget sit below the starting budget', () => {
    // Defence in depth: `fromSource` rejects this combination outright, but the
    // constructor must not produce an unreachable budget if it is reached.
    const mesh = track(
      makeMesh({ budget: 4 * WIDTH, capacity: 4 * WIDTH, options: { maxBudget: WIDTH } }),
    );
    expect(mesh.maxBudget).toBe(4 * WIDTH);
    expect(mesh.budget).toBe(4 * WIDTH);
  });

  it('still rejects a non-positive budget', () => {
    const mesh = track(makeMesh());
    expect(() => mesh.setBudget(0)).toThrow(RangeError);
    expect(() => mesh.setBudget(-1)).toThrow(RangeError);
  });

  it('reports 0 drawBudget outside page-table mode', () => {
    const mesh = track(makeMesh());
    expect(mesh.drawBudget).toBe(0);
  });
});

describe('StreamedSplatMesh page-table governance', () => {
  const meshes: StreamedSplatMesh[] = [];
  afterEach(() => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
    RecordingWorker.last = undefined;
    setVlamLogHandler(undefined);
  });
  function track(mesh: StreamedSplatMesh): StreamedSplatMesh {
    meshes.push(mesh);
    return mesh;
  }

  it('drives the frontier draw target from the governed budget', () => {
    const mesh = track(
      makeMesh({
        budget: WIDTH,
        capacity: 8 * WIDTH,
        foveated: true,
        options: { foveationMode: 'page-table', maxBudget: 8 * WIDTH },
      }),
    );
    expect(mesh.drawBudget).toBe(WIDTH);

    // A governor grows the mesh; the drawn frontier target must follow, and the
    // slab must be able to hold it (otherwise the pager drops frontier splats).
    mesh.setBudget(6 * WIDTH);
    expect(mesh.drawBudget).toBe(6 * WIDTH);
    expect(mesh.capacity).toBeGreaterThanOrEqual(mesh.drawBudget);

    reschedulePageTable(mesh, 1000);
    expect(RecordingWorker.last?.lastReschedule?.['budget']).toBe(6 * WIDTH);
  });

  it('treats deprecated pagetable spelling as page-table', () => {
    const canonical = track(
      makeMesh({
        budget: WIDTH,
        capacity: 8 * WIDTH,
        foveated: true,
        options: { foveationMode: 'page-table', maxBudget: 8 * WIDTH },
      }),
    );
    const deprecated = track(
      makeMesh({
        budget: WIDTH,
        capacity: 8 * WIDTH,
        foveated: true,
        options: { foveationMode: 'pagetable', maxBudget: 8 * WIDTH },
      }),
    );
    expect(deprecated.drawBudget).toBe(canonical.drawBudget);
    expect(canonical.drawBudget).toBe(WIDTH);
  });

  it('pages a slab whose capacity is not a whole number of pages', () => {
    // The slab is reserved as fixed-size pages (65,536 splats) so a mesh's
    // storage need not be contiguous. A capacity larger than one page and not a
    // multiple of it must give the *final* page the remainder: rounding it up
    // reserves more than the pool holds and the allocation fails. Real `.rad`
    // meshes land here routinely - a 261-row pool asked for a 32-row page it
    // did not have, and every page-table mesh in the scene failed to load.
    const capacity = 65_536 + WIDTH; // one full page plus one row
    const mesh = track(
      makeMesh({
        budget: WIDTH,
        capacity,
        foveated: true,
        options: { foveationMode: 'page-table', maxBudget: capacity },
      }),
    );
    expect(mesh.capacity).toBeGreaterThanOrEqual(capacity);

    // Storage follows the budget, so only the first page is reserved up front -
    // the ceiling is permission to grow, not an up-front claim. That is what
    // lets several meshes share a pool.
    expect(RecordingWorker.last?.posted[0]?.['capacity']).toBe(65_536);

    // Growing to the ceiling adds the short final page: rounding it up to a
    // whole page would ask the pool for more than it holds, which is how every
    // page-table mesh in a real scene failed to load.
    mesh.setBudget(capacity);
    const resize = [...(RecordingWorker.last?.posted ?? [])]
      .reverse()
      .find((m) => m['type'] === 'resize');
    expect(resize?.['capacity']).toBe(capacity);

    // And the frontier still resolves slots across the page boundary.
    reschedulePageTable(mesh, 1000);
    expect(RecordingWorker.last?.lastReschedule).toBeDefined();
  });

  it('keeps the draw target under an explicit foveationDrawBudget, and warns', () => {
    const warnings: string[] = [];
    setVlamLogHandler((level, message) => {
      if (level === 'warn') warnings.push(message);
    });
    const mesh = track(
      makeMesh({
        budget: WIDTH,
        capacity: 8 * WIDTH,
        foveated: true,
        options: {
          foveationMode: 'page-table',
          maxBudget: 8 * WIDTH,
          foveationDrawBudget: 2 * WIDTH,
        },
      }),
    );
    mesh.setBudget(6 * WIDTH);

    // The caller's cap outranks the budget - say so rather than stay quietly coarse.
    expect(mesh.drawBudget).toBe(2 * WIDTH);
    expect(warnings.join('\n')).toMatch(/foveationDrawBudget caps the drawn frontier/);

    // Warned once, not once per reallocation.
    const count = warnings.length;
    mesh.setBudget(7 * WIDTH);
    expect(warnings.length).toBe(count);
  });

  it('scales the posted cut limit by lodScale (Spark parity)', () => {
    const mesh = track(
      makeMesh({
        budget: 4 * WIDTH,
        capacity: 4 * WIDTH,
        foveated: true,
        options: { foveationMode: 'page-table' },
      }),
    );
    expect(mesh.lodScale).toBe(1);
    reschedulePageTable(mesh, 1000);
    const unscaled = RecordingWorker.last?.lastReschedule?.['limit'] as number;
    expect(unscaled).toBeGreaterThan(0);

    // `pixel_scale × lodScale ≤ limit` is the same test as `pixel_scale ≤
    // limit / lodScale`, so doubling the scale halves the posted limit.
    mesh.lodScale = 2;
    reschedulePageTable(mesh, 2000);
    expect(RecordingWorker.last?.lastReschedule?.['limit']).toBeCloseTo(unscaled / 2, 12);

    mesh.lodScale = 0.5;
    reschedulePageTable(mesh, 3000);
    expect(RecordingWorker.last?.lastReschedule?.['limit']).toBeCloseTo(unscaled * 2, 12);
  });

  it('validates lodScale', () => {
    expect(() => makeMesh({ options: { lodScale: 0 } })).toThrow(RangeError);
    expect(() => makeMesh({ options: { lodScale: -1 } })).toThrow(RangeError);
    const mesh = track(makeMesh({ options: { lodScale: 2 } }));
    expect(mesh.lodScale).toBe(2);
    expect(() => {
      mesh.lodScale = Number.NaN;
    }).toThrow(RangeError);
  });
});
