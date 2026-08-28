import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { applyLcc2ToThreeTransform, createLcc2ToThreeMatrix } from '../formats/lcc/lcc2-transform';
import { buildLcc2Scene } from '../formats/lcc/lcc2';
import { httpDatasetSource } from '../streaming/dataset-source';
import { StreamedSplatMesh } from '../streaming/streamed-splat-mesh';

vi.mock('../loaders/chunk-loader', () => ({
  ChunkLoader: class {
    dispose(): void {}
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal valid `.lcc2` tree: one root child that is a finest cell. */
function minimalLcc2Manifest() {
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

function minimalClassicLccManifest() {
  return {
    version: '5.0',
    totalSplats: 10,
    totalLevel: 1,
    cellLengthX: 10,
    cellLengthY: 10,
    indexDataSize: 20,
    offset: [0, 0, 0],
    shift: [0, 0, 0],
    scale: [1, 1, 1],
    epsg: 0,
    splats: [10],
    boundingBox: { min: [0, 0, 0], max: [10, 10, 10] },
    encoding: 'COMPRESS',
    fileType: 'Portable',
    attributes: [{ name: 'scale', min: [0.1, 0.1, 0.1], max: [1, 1, 1] }],
  };
}

function classicLccIndex(): ArrayBuffer {
  const index = new ArrayBuffer(20);
  const view = new DataView(index);
  view.setUint32(4, 10, true);
  view.setBigUint64(8, 0n, true);
  view.setUint32(16, 320, true);
  return index;
}

function stubClassicLccFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.endsWith('.lcc')) {
        return Promise.resolve(
          new Response(JSON.stringify(minimalClassicLccManifest()), { status: 200 }),
        );
      }
      if (url.endsWith('index.bin')) return Promise.resolve(new Response(classicLccIndex()));
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );
}

describe('createLcc2ToThreeMatrix', () => {
  it('maps basis axes: +X→−X, +Y→+Z, +Z→+Y', () => {
    const m = createLcc2ToThreeMatrix();
    const x = new THREE.Vector3(1, 0, 0).applyMatrix4(m);
    const y = new THREE.Vector3(0, 1, 0).applyMatrix4(m);
    const z = new THREE.Vector3(0, 0, 1).applyMatrix4(m);

    expect(x.toArray()).toEqual([-1, 0, 0]);
    expect(y.toArray()).toEqual([0, 0, 1]);
    expect(z.toArray()).toEqual([0, 1, 0]);
  });
});

describe('applyLcc2ToThreeTransform', () => {
  it('writes the correction onto an Object3D once', () => {
    const target = new THREE.Object3D();
    applyLcc2ToThreeTransform(target);
    target.updateMatrixWorld(true);

    const local = new THREE.Vector3(1, 2, 3);
    const world = local.clone().applyMatrix4(target.matrixWorld);
    expect(world.x).toBeCloseTo(-1);
    expect(world.y).toBeCloseTo(3);
    expect(world.z).toBeCloseTo(2);
  });
});

describe('buildLcc2Scene format transform', () => {
  it('tags every tile as SOG so blob: URLs still decode', () => {
    const scene = buildLcc2Scene(
      minimalLcc2Manifest(),
      httpDatasetSource('https://example.test/scene.lcc2'),
      {
        budget: 100,
        lodBaseDistance: 10,
        lodMultiplier: 2,
      },
    );
    expect(scene.chunkOptions).toEqual([{ format: 'sog' }]);
  });

  it('provides the established LCC2-to-viewer matrix and keeps bounds source-local', () => {
    const scene = buildLcc2Scene(
      minimalLcc2Manifest(),
      httpDatasetSource('https://example.test/scene.lcc2'),
      {
        budget: 100,
        lodBaseDistance: 10,
        lodMultiplier: 2,
      },
    );

    const expected = createLcc2ToThreeMatrix();
    expect(scene.formatTransform).toBeDefined();
    for (let i = 0; i < 16; i++) {
      expect(scene.formatTransform!.elements[i]).toBeCloseTo(expected.elements[i] as number, 10);
    }
    expect(scene.bounds.min.toArray()).toEqual([-1, -2, -3]);
    expect(scene.bounds.max.toArray()).toEqual([4, 5, 6]);
  });

  it('produces viewer-space world bounds after the format transform', () => {
    const scene = buildLcc2Scene(
      minimalLcc2Manifest(),
      httpDatasetSource('https://example.test/scene.lcc2'),
      {
        budget: 100,
        lodBaseDistance: 10,
        lodMultiplier: 2,
      },
    );
    const mesh = new THREE.Object3D();
    mesh.matrix.copy(scene.formatTransform!);
    mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    mesh.updateMatrixWorld(true);

    const worldBounds = scene.bounds.clone().applyMatrix4(mesh.matrixWorld);
    expect(worldBounds.min.x).toBeCloseTo(-4);
    expect(worldBounds.min.y).toBeCloseTo(-3);
    expect(worldBounds.min.z).toBeCloseTo(-2);
    expect(worldBounds.max.x).toBeCloseTo(1);
    expect(worldBounds.max.y).toBeCloseTo(6);
    expect(worldBounds.max.z).toBeCloseTo(5);
  });
});

describe('StreamedSplatMesh.load LCC2 orientation', () => {
  it('returns a mesh normalized to the established LCC and Spark viewer frame', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => minimalLcc2Manifest(),
      })),
    );

    const mesh = await StreamedSplatMesh.load('https://example.test/scene.lcc2', { budget: 10 });

    const expected = createLcc2ToThreeMatrix();
    mesh.updateMatrix();
    for (let i = 0; i < 16; i++) {
      expect(mesh.matrix.elements[i]).toBeCloseTo(expected.elements[i] as number, 10);
    }
    expect(mesh.scale.toArray()).toEqual([1, 1, 1]);
    expect(mesh.computeSplatBounds().min.toArray()).toEqual([-1, -2, -3]);
    expect(mesh.computeSplatBounds().max.toArray()).toEqual([4, 5, 6]);
    mesh.dispose();
  });
});

describe('StreamedSplatMesh.load classic LCC initial reveal', () => {
  it('holds the nearby-detail set by default', async () => {
    stubClassicLccFetch();
    const mesh = await StreamedSplatMesh.load('https://example.test/scene.lcc', { budget: 10 });

    expect(mesh.initialRevealState.status).toBe('pending');
    mesh.dispose();
  });

  it('keeps progressive reveal as an explicit classic-LCC opt-out', async () => {
    stubClassicLccFetch();
    const mesh = await StreamedSplatMesh.load('https://example.test/scene.lcc', {
      budget: 10,
      initialReveal: 'progressive',
    });

    expect(mesh.initialRevealState.status).toBe('disabled');
    mesh.dispose();
  });
});

function stubLcc2Fetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => minimalLcc2Manifest(),
    })),
  );
}

describe('StreamedSplatMesh.load LCC2 initial reveal', () => {
  it('holds in-view coarsest coverage by default', async () => {
    stubLcc2Fetch();
    const mesh = await StreamedSplatMesh.load('https://example.test/scene.lcc2', { budget: 10 });

    expect(mesh.initialRevealState.status).toBe('pending');
    mesh.dispose();
  });

  it('keeps progressive reveal as an explicit LCC2 opt-out', async () => {
    stubLcc2Fetch();
    const mesh = await StreamedSplatMesh.load('https://example.test/scene.lcc2', {
      budget: 10,
      initialReveal: 'progressive',
    });

    expect(mesh.initialRevealState.status).toBe('disabled');
    mesh.dispose();
  });
});
