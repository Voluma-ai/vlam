import { describe, expect, it, vi } from 'vitest';
import { buildLcc2Scene } from '../formats/lcc/lcc2';
import type { SplatDatasetSource } from '../streaming/dataset-source';

/**
 * Tests for the collision meshes an `.lcc2` manifest declares beside its
 * splats.
 *
 * Collision is optional, so the point of most of these is what *doesn't*
 * happen: a dataset missing its mesh files, or a manifest shaped slightly
 * differently than XGRIDS' exporter writes today, must still load its splats.
 */

const OPTIONS = { budget: 1000, lodBaseDistance: 10, lodMultiplier: 2 };

/** A dataset whose files all resolve, except those named in `missing`. */
function dataset(missing: string[] = []): SplatDatasetSource {
  return {
    manifestUrl: 'https://host/scene.lcc2',
    resolve: (path) => (missing.includes(path) ? null : `https://host/${path}`),
    size: () => Promise.resolve(null),
    directoryFiles: () => null,
    dispose: () => {},
  };
}

function box(
  min: number,
  max: number,
): { min: [number, number, number]; max: [number, number, number] } {
  return { min: [min, min, min], max: [max, max, max] };
}

/** A two-leaf octree; `mesh` decides what collision each leaf claims. */
function manifest(options: { meshFiles?: string[]; meshNames?: (number | undefined)[] }): unknown {
  const leaf = (index: number) => ({
    boundingBox: box(index, index + 1),
    data: {
      '3dgs': { name: 0, start: index * 10, count: 10 },
      ...(options.meshNames?.[index] !== undefined
        ? { mesh: { name: options.meshNames[index], vertex: 3, face: 1 } }
        : {}),
    },
  });
  return {
    version: '0.0.2',
    totalLevels: 2,
    lodSplats: [20],
    root: {
      boundingBox: box(0, 2),
      splatFiles: ['data/3dgs/0_0.sog'],
      ...(options.meshFiles ? { meshFiles: options.meshFiles } : {}),
      child: { '0': leaf(0), '1': leaf(1) },
    },
  };
}

describe('buildLcc2Scene collision', () => {
  it("resolves each node's mesh with the node's bounds", () => {
    const scene = buildLcc2Scene(
      manifest({
        meshFiles: ['data/mesh/a.ply', 'data/mesh/b.ply'],
        meshNames: [0, 1],
      }),
      dataset(),
      OPTIONS,
    );

    expect(scene.collision?.meshes).toHaveLength(2);
    expect(scene.collision?.meshes.map((mesh) => mesh.url)).toEqual([
      'https://host/data/mesh/a.ply',
      'https://host/data/mesh/b.ply',
    ]);
    // Source-local, like scene.bounds - the caller applies formatTransform.
    expect(scene.collision?.meshes[0]?.bounds?.min.toArray()).toEqual([0, 0, 0]);
    expect(scene.collision?.meshes[1]?.bounds?.min.toArray()).toEqual([1, 1, 1]);
  });

  it('loads a shared mesh file once', () => {
    const scene = buildLcc2Scene(
      manifest({ meshFiles: ['data/mesh/a.ply'], meshNames: [0, 0] }),
      dataset(),
      OPTIONS,
    );

    expect(scene.collision?.meshes).toHaveLength(1);
  });

  it('reports no collision for a dataset without mesh files', () => {
    const scene = buildLcc2Scene(manifest({}), dataset(), OPTIONS);

    expect(scene.collision).toBeUndefined();
  });

  it('skips a missing mesh but keeps the rest, and the splats', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = buildLcc2Scene(
      manifest({ meshFiles: ['data/mesh/a.ply', 'data/mesh/b.ply'], meshNames: [0, 1] }),
      dataset(['data/mesh/a.ply']),
      OPTIONS,
    );

    expect(scene.collision?.meshes.map((mesh) => mesh.url)).toEqual([
      'https://host/data/mesh/b.ply',
    ]);
    expect(scene.chunkUrls).toEqual(['https://host/data/3dgs/0_0.sog']);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('falls back to the file list when no node claims a mesh', () => {
    const scene = buildLcc2Scene(
      manifest({ meshFiles: ['data/mesh/a.ply', 'data/mesh/b.ply'] }),
      dataset(),
      OPTIONS,
    );

    expect(scene.collision?.meshes).toHaveLength(2);
    expect(scene.collision?.meshes[0]?.bounds).toBeUndefined();
  });

  it('skips a mesh index the manifest never lists', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = buildLcc2Scene(
      manifest({ meshFiles: ['data/mesh/a.ply'], meshNames: [0, 7] }),
      dataset(),
      OPTIONS,
    );

    expect(scene.collision?.meshes).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
