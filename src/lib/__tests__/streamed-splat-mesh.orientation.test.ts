import { httpDatasetSource } from '../streaming/dataset-source';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { StreamedSplatMesh } from '../streaming/streamed-splat-mesh';
import { createLcc2ToThreeMatrix } from '../formats/lcc/lcc2-transform';
import { createYUpTransform } from '../core/orientation';

// The mesh is built from the manifest only; no chunk actually streams here.
vi.mock('../loaders/chunk-loader', () => ({
  ChunkLoader: class {
    dispose(): void {}
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubManifest(manifest: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => manifest })),
  );
}

/** Minimal valid `.lcc2` tree: one root child that is a finest cell. */
function lcc2Manifest() {
  return {
    version: '0.0.2',
    totalLevels: 1,
    lodSplats: [10],
    root: {
      boundingBox: { min: [-1, -2, -3], max: [4, 5, 6] },
      splatFiles: ['chunk-0.sog'],
      child: {
        a: {
          boundingBox: { min: [-1, -2, -3], max: [4, 5, 6] },
          data: { '3dgs': { name: 0, start: 0, count: 10 } },
        },
      },
    },
  };
}

/** A one-leaf, two-chunk Streamed SOG manifest (mirrors sog-scene-shn.test). */
function sogManifest() {
  return {
    version: 1,
    counts: [20, 10],
    lodLevels: 2,
    filenames: ['0_0/meta.json', '0_1/meta.json'],
    tree: {
      bound: { min: [0, 0, 0], max: [1, 1, 1] },
      lods: {
        '0': { file: 0, offset: 0, count: 20 },
        '1': { file: 1, offset: 0, count: 10 },
      },
    },
  };
}

function expectMatrix(mesh: StreamedSplatMesh, expected: THREE.Matrix4): void {
  mesh.updateMatrix();
  for (let i = 0; i < 16; i++) {
    expect(mesh.matrix.elements[i]).toBeCloseTo(expected.elements[i] as number, 10);
  }
}

describe('StreamedSplatMesh orientation', () => {
  const identity = new THREE.Matrix4();
  const yUp = createYUpTransform();
  const lcc = createLcc2ToThreeMatrix();

  it('applies LCC2’s Z-up→Y-up matrix in the default y-up mode', async () => {
    stubManifest(lcc2Manifest());
    const mesh = await StreamedSplatMesh.load('https://x.test/scene.lcc2', { budget: 10 });
    expectMatrix(mesh, lcc);
    mesh.dispose();
  });

  it('keeps LCC2’s matrix even in source mode (format semantics, not cosmetic)', async () => {
    stubManifest(lcc2Manifest());
    const mesh = await StreamedSplatMesh.load('https://x.test/scene.lcc2', {
      budget: 10,
      orientation: 'source',
    });
    expectMatrix(mesh, lcc);
    mesh.dispose();
  });

  it('flips a streamed SOG 180° about X in the default y-up mode', async () => {
    stubManifest(sogManifest());
    const mesh = await StreamedSplatMesh.load('https://x.test/lod-meta.json', { budget: 10 });
    expectMatrix(mesh, yUp);
    mesh.dispose();
  });

  it('leaves a streamed SOG in its source frame in source mode', async () => {
    stubManifest(sogManifest());
    const mesh = await StreamedSplatMesh.load('https://x.test/lod-meta.json', {
      budget: 10,
      orientation: 'source',
    });
    expectMatrix(mesh, identity);
    mesh.dispose();
  });
});

describe('custom dataset source ownership', () => {
  it.each(['borrowed', 'owned'] as const)(
    'honors %s ownership on success, failure and abort',
    async (sourceOwnership) => {
      for (const outcome of ['success', 'failure', 'abort'] as const) {
        stubManifest(outcome === 'failure' ? {} : sogManifest());
        const source = httpDatasetSource('https://x.test/custom-manifest');
        const dispose = vi.spyOn(source, 'dispose');
        const controller = new AbortController();
        if (outcome === 'abort') controller.abort();
        const pending = StreamedSplatMesh.loadSource(source, {
          format: 'streamed-sog',
          sourceOwnership,
          budget: 10,
          shBands: 0,
          signal: controller.signal,
        });
        if (outcome === 'success') {
          const mesh = await pending;
          expect(dispose).not.toHaveBeenCalled();
          mesh.dispose();
          mesh.dispose();
        } else await expect(pending).rejects.toBeDefined();
        expect(dispose).toHaveBeenCalledTimes(sourceOwnership === 'owned' ? 1 : 0);
      }
    },
  );
});
