import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { MergedSplatMesh } from '../core/merged-splat-mesh';
import { SourceMatrixArray, worldBoundsOf, type SourceBounds } from '../core/source-transform';
import { writeCovariance, type SplatData } from '../core/splat-data';
import { RadixSorter } from '../core/radix-sorter';
import type { SplatSorter } from '../core/sorter';
import { exactSort, radixSort } from '../sorting/radix';

/** A `count`-splat cloud with all centers at `origin` (+x spread), optional format. */
function makeData(count: number, format?: SplatData['format'], x = 0): SplatData {
  const positions = new Float32Array(count * 3);
  const covariances = new Float32Array(count * 6);
  const colors = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    positions[i * 3 + 0] = x + i;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
    colors.set([255, 255, 255, 255], i * 4);
  }
  return { count, positions, colors, covariances, ...(format ? { format } : {}) };
}

interface Internals {
  channels: Map<string, { backing: Float32Array }>;
  matrices: SourceMatrixArray;
  perSourceSort: { columns: unknown } | null;
  materialInputs: { textures: unknown; sh: unknown };
  graphInputs(textures: unknown, sh: unknown): { sourcePlacement: { columns: unknown } | null };
  modifierList: readonly unknown[];
  graphRevision: number;
  boundingSphereLocal: THREE.Sphere;
  boundsDirty: boolean;
  refreshSortBounds(): void;
}
const peek = (s: MergedSplatMesh) => s as unknown as Internals;

describe('MergedSplatMesh', () => {
  const scenes: MergedSplatMesh[] = [];
  afterEach(() => {
    for (const s of scenes) s.dispose();
    scenes.length = 0;
  });
  const make = (capacity = 8192): MergedSplatMesh => {
    const scene = new MergedSplatMesh({ capacity });
    scenes.push(scene);
    return scene;
  };

  it.each([
    ['radix', radixSort(), false],
    ['exact', exactSort(), true],
  ] as const)(
    'honors %s sorting for independently placed sources',
    async (_label, sortStrategy, exactDepth) => {
      const scene = new MergedSplatMesh({ capacity: 4096, sortStrategy });
      scenes.push(scene);
      scene.addSource(makeData(1), new THREE.Matrix4().makeTranslation(0, 0, 2));
      scene.addSource(makeData(1), new THREE.Matrix4().makeTranslation(0, 0, -2));
      const state = scene as unknown as {
        createSorter(renderer: THREE.WebGPURenderer): SplatSorter;
      };
      const sorter = state.createSorter({
        backend: { isWebGPUBackend: true },
        compute: vi.fn(),
      } as unknown as THREE.WebGPURenderer);
      try {
        // Regression: source placements used to silently force counting sort.
        expect(sorter).toBeInstanceOf(RadixSorter);
        expect((sorter as unknown as { exactDepth: boolean }).exactDepth).toBe(exactDepth);
      } finally {
        sorter.dispose();
      }
    },
  );

  it('wires the sourceId channel and the world-depth sorter, with no modifiers of its own', () => {
    const scene = make();
    const internals = peek(scene);
    expect(internals.channels.has('sourceId')).toBe(true);
    expect(internals.perSourceSort).not.toBeNull();
    expect(scene.getUnifiedSourceView().hasSourcePlacement).toBe(true);
    // Placement is structural (applied by the material graph ahead of the fold),
    // not a modifier, so an untouched scene compiles the unhooked graph.
    expect(internals.modifierList).toHaveLength(0);
  });

  it('rebuilds the graph so the material actually carries the source placement', () => {
    // The guard for the constructor's `rebuildGraph()`. `SplatMesh`'s
    // constructor builds a material before `perSourceSort` exists; skip the
    // rebuild and every source silently renders at its pool-local position
    // while every other test still passes.
    const scene = make();
    const internals = peek(scene);
    const built = internals.graphInputs(
      internals.materialInputs.textures,
      internals.materialInputs.sh,
    );
    expect(built.sourcePlacement).not.toBeNull();
    expect(built.sourcePlacement?.columns).toBe(internals.matrices.node);
    expect(internals.graphRevision).toBeGreaterThan(0);
  });

  it('passes host modifiers to the material unwrapped', () => {
    const scene = make();
    const effect = () => ({});
    scene.modifiers = [effect];
    expect(scene.modifiers).toEqual([effect]);
    expect(peek(scene).modifierList).toHaveLength(1);
  });

  it('survives a host modifier that writes offset', () => {
    // Regression guard: placement used to be modifier #0 writing `offset`, and
    // the fold *replaces* that field rather than accumulating it - so any host
    // modifier returning an `offset` collapsed every source back to pool-local
    // space. Placement is now applied outside the fold and cannot be clobbered.
    const scene = make();
    scene.addSource(makeData(2), new THREE.Matrix4().makeTranslation(5, 0, 0), {
      orientation: 'source',
    });
    expect(() => {
      scene.modifiers = [(ctx) => ({ offset: ctx.localCenter.mul(0) })];
    }).not.toThrow();
    expect(peek(scene).modifierList).toHaveLength(1);
  });

  it('reports bounds at the sources current placement', () => {
    const scene = make();
    const a = scene.addSource(makeData(1), new THREE.Matrix4().makeTranslation(-50, 0, 0), {
      orientation: 'source',
    });
    scene.addSource(makeData(1), new THREE.Matrix4().makeTranslation(50, 0, 0), {
      orientation: 'source',
    });
    const bounds = scene.computeSplatBounds();
    expect(bounds.min.x).toBeCloseTo(-50, 5);
    expect(bounds.max.x).toBeCloseTo(50, 5);
    // Hosts place effects with this, so it has to follow a moved source.
    scene.setSourceTransform(a, new THREE.Matrix4().makeTranslation(-120, 0, 0));
    expect(scene.computeSplatBounds().min.x).toBeCloseTo(-120, 5);
  });

  it('assigns incrementing ids and stamps each splat with its source id', () => {
    const scene = make();
    const a = scene.addSource(makeData(3), new THREE.Matrix4(), { orientation: 'source' });
    const b = scene.addSource(makeData(2), new THREE.Matrix4(), { orientation: 'source' });
    expect(a).toBe(0);
    expect(b).toBe(1);
    expect(scene.sourceCount).toBe(2);

    const backing = peek(scene).channels.get('sourceId')!.backing;
    // Source 0 occupies pool row 0; source 1 starts at the next row (width 2048).
    expect(backing[0]).toBe(0);
    expect(backing[2]).toBe(0);
    expect(backing[2048]).toBe(1);
  });

  it('bakes the y-up correction into a source matrix, and places without it in source mode', () => {
    const scene = make();
    const place = new THREE.Matrix4().makeTranslation(5, 0, 0);

    scene.addSource(makeData(1, 'ply'), place, { orientation: 'y-up' });
    const yUp = scene.getSourceTransform(0)!;
    const expected = place.clone().multiply(new THREE.Matrix4().makeRotationX(Math.PI));
    for (let i = 0; i < 16; i++) {
      expect(yUp.elements[i]).toBeCloseTo(expected.elements[i] as number, 6);
    }

    scene.addSource(makeData(1, 'ply'), place, { orientation: 'source' });
    const raw = scene.getSourceTransform(1)!;
    for (let i = 0; i < 16; i++)
      expect(raw.elements[i]).toBeCloseTo(place.elements[i] as number, 6);
  });

  it('publishes a source matrix into the shared uniform columns (column-major)', () => {
    const scene = make();
    const place = new THREE.Matrix4().makeTranslation(7, -2, 3);
    scene.addSource(makeData(1), place, { orientation: 'source' });

    const columns = peek(scene).matrices as unknown as { columns: THREE.Vector4[] };
    // Column 3 (translation) of an identity-rotation placement.
    const c3 = columns.columns[3] as THREE.Vector4;
    expect([c3.x, c3.y, c3.z]).toEqual([7, -2, 3]);
  });

  it('setSourceTransform updates the matrix and forces a re-sort', () => {
    const scene = make();
    scene.addSource(makeData(1), new THREE.Matrix4(), { orientation: 'source' });
    peek(scene).boundsDirty = false; // simulate a settled frame

    scene.setSourceTransform(0, new THREE.Matrix4().makeTranslation(0, 10, 0));
    expect(scene.getSourceTransform(0)!.elements[13]).toBe(10);
    expect(peek(scene).boundsDirty).toBe(true); // invalidateSort re-dirtied bounds
  });

  it('removeSource reports whether a live source was removed, idempotently', () => {
    const scene = make();
    const id = scene.addSource(makeData(2), new THREE.Matrix4(), { orientation: 'source' });
    expect(scene.removeSource(id)).toBe(true);
    expect(scene.sourceCount).toBe(0);
    expect(scene.removeSource(id)).toBe(false); // already removed
    expect(scene.removeSource(999)).toBe(false); // never existed
    expect(scene.getSourceTransform(id)).toBeUndefined();
    expect(() => scene.setSourceTransform(id, new THREE.Matrix4())).toThrow(/no live source/);
  });

  it('sorts over a world bound that spans every source', () => {
    const scene = make();
    scene.addSource(makeData(1), new THREE.Matrix4().makeTranslation(-50, 0, 0), {
      orientation: 'source',
    });
    scene.addSource(makeData(1), new THREE.Matrix4().makeTranslation(50, 0, 0), {
      orientation: 'source',
    });
    const internals = peek(scene);
    internals.boundsDirty = true;
    internals.refreshSortBounds();
    // The two lone splats sit near x = ±50, so the span must reach both.
    expect(internals.boundingSphereLocal.radius).toBeGreaterThan(45);
    expect(internals.boundingSphereLocal.center.x).toBeCloseTo(0, 0);
  });
});

describe('worldBoundsOf', () => {
  it('unions translated and scaled source spheres', () => {
    const sources: SourceBounds[] = [
      {
        center: new THREE.Vector3(0, 0, 0),
        radius: 1,
        matrix: new THREE.Matrix4().makeTranslation(-10, 0, 0),
      },
      {
        center: new THREE.Vector3(0, 0, 0),
        radius: 1,
        matrix: new THREE.Matrix4().makeScale(4, 4, 4), // radius → 4 at origin
      },
    ];
    const out = worldBoundsOf(sources, new THREE.Sphere());
    // Must enclose the sphere at x=-10 (r=1) and the r=4 sphere at the origin.
    expect(out.containsPoint(new THREE.Vector3(-11, 0, 0))).toBe(true);
    expect(out.containsPoint(new THREE.Vector3(4, 0, 0))).toBe(true);
  });
});

describe('merged CPU queries', () => {
  it('follows source and parent movement, orientation, scale and compaction', () => {
    const mesh = new MergedSplatMesh({ capacity: 8192 });
    const parent = new THREE.Group();
    parent.add(mesh);
    const removed = mesh.addSource(makeData(1));
    const id = mesh.addSource(makeData(2, 'ply'), new THREE.Matrix4().makeTranslation(4, 3, -2));
    const transform = new THREE.Matrix4().compose(
      new THREE.Vector3(4, 3, -2),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.5, 0.2)),
      new THREE.Vector3(-2, 0.5, 3),
    );
    parent.position.set(10, 2, -3);
    parent.rotation.y = 0.4;
    parent.scale.set(0.5, 2, 3);
    mesh.setSourceTransform(id, transform);
    mesh.updateWorldMatrix(true, false);
    const expected = new THREE.Vector3(1, 0, 0)
      .applyMatrix4(mesh.getSourceTransform(id)!)
      .applyMatrix4(mesh.matrixWorld);
    expect(mesh.queryNearest(expected, 0.01)?.point.distanceTo(expected)).toBeLessThan(1e-5);
    expect(
      mesh.queryHeight(expected.clone().add(new THREE.Vector3(0, 1, 0)), 1.1, 0.01)?.drop,
    ).toBeCloseTo(1);
    expect(
      mesh
        .queryRay(
          new THREE.Ray(
            expected.clone().add(new THREE.Vector3(0, 0, 1)),
            new THREE.Vector3(0, 0, -1),
          ),
          0,
          0.01,
        )
        ?.point.distanceTo(expected),
    ).toBeLessThan(1e-5);
    mesh.removeSource(removed);
    mesh.compact();
    expect(mesh.queryNearest(expected, 0.01)?.point.distanceTo(expected)).toBeLessThan(1e-5);
    mesh.setSourceTransform(id, new THREE.Matrix4().makeTranslation(20, 0, 0));
    expect(mesh.queryNearest(expected, 0.01)).toBeNull();
    mesh.removeSource(id);
    expect(mesh.queryNearest(new THREE.Vector3(), 100)).toBeNull();
    mesh.dispose();
    expect(mesh.queryNearest(expected, 100)).toBeNull();
  });

  it('ranks by world distance and handles a singular placement without inversion', () => {
    const mesh = new MergedSplatMesh({ capacity: 8192 });
    mesh.addSource(makeData(1, undefined, 1), new THREE.Matrix4().makeScale(10, 1, 1));
    mesh.addSource(makeData(1, undefined, 2), new THREE.Matrix4().makeScale(0.1, 1, 1));
    expect(mesh.queryNearest(new THREE.Vector3(), 20)?.distance).toBeCloseTo(0.2);
    const singular = mesh.addSource(makeData(1), new THREE.Matrix4().makeScale(0, 0, 0));
    expect(mesh.queryNearest(new THREE.Vector3(), 0)?.distance).toBe(0);
    expect(mesh.queryHeight(new THREE.Vector3(0, 1, 0), 2, 0)?.drop).toBe(1);
    mesh.removeSource(singular);
    mesh.dispose();
  });
});

it('keeps raw query grids while a source moves and rebuilds them only after relocation', () => {
  const mesh = new MergedSplatMesh({ capacity: 8192 });
  const removed = mesh.addSource(makeData(1));
  const id = mesh.addSource(makeData(2, undefined, 2));
  mesh.queryNearest(new THREE.Vector3(2, 0, 0), 1);
  const inner = mesh as unknown as { sources: Array<{ grid?: unknown; gridStart?: number }> };
  const grid = inner.sources[id]!.grid;
  const start = inner.sources[id]!.gridStart;
  expect(grid).toBeDefined();
  mesh.setSourceTransform(id, new THREE.Matrix4().makeTranslation(3, 0, 0));
  expect(mesh.queryNearest(new THREE.Vector3(5, 0, 0), 0.1)?.point.x).toBe(5);
  expect(inner.sources[id]!.grid).toBe(grid);
  mesh.removeSource(removed);
  mesh.compact();
  expect(mesh.queryNearest(new THREE.Vector3(5, 0, 0), 0.1)?.point.x).toBe(5);
  expect(inner.sources[id]!.gridStart).not.toBe(start);
  expect(inner.sources[id]!.grid).not.toBe(grid);
  mesh.dispose();
});

it('applies the per-format orientation correction to CPU query centers', () => {
  const mesh = new MergedSplatMesh({ capacity: 4096 });
  const data = makeData(1, 'ply');
  data.positions.set([0, 1, 2]);
  const id = mesh.addSource(data);
  const expected = new THREE.Vector3(0, 1, 2).applyMatrix4(mesh.getSourceTransform(id)!);
  expect(mesh.queryNearest(expected, 0.001)?.point.distanceTo(expected)).toBeLessThan(1e-6);
  expect(
    mesh.queryHeight(expected.clone().add(new THREE.Vector3(0, 1, 0)), 2, 0.001)?.drop,
  ).toBeCloseTo(1);
  expect(
    mesh.queryRay(
      new THREE.Ray(expected.clone().add(new THREE.Vector3(0, 0, 1)), new THREE.Vector3(0, 0, -1)),
      0,
      0.001,
    )?.distance,
  ).toBeCloseTo(1);
  mesh.dispose();
});

it('releases every source query grid on repeated disposal', () => {
  const mesh = new MergedSplatMesh({ capacity: 8192 });
  mesh.addSource(makeData(4));
  mesh.addSource(makeData(4, undefined, 10));
  mesh.queryNearest(new THREE.Vector3(), 20);
  const inner = mesh as unknown as { sources: Array<{ grid?: unknown; gridStart?: number }> };
  expect(inner.sources.every((source) => source.grid !== undefined)).toBe(true);
  mesh.dispose();
  mesh.dispose();
  expect(inner.sources.every((source) => source.grid === undefined)).toBe(true);
  expect(inner.sources.every((source) => source.gridStart === undefined)).toBe(true);
  expect(mesh.queryNearest(new THREE.Vector3(), 20)).toBeNull();
});
