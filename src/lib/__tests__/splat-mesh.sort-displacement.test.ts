import * as THREE from 'three/webgpu';
import { float, int, ivec2, vec3 } from 'three/tsl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SplatMesh, getSplatSortDisplacementRevision } from '../core/splat-mesh';
import { writeCovariance } from '../core/splat-data';
import { ComputeSorter } from '../core/compute-sorter';
import { RadixSorter } from '../core/radix-sorter';
import type { SplatSortCenterAdapter, SplatSorter, SplatSorterOptions } from '../core/sorter';
import type { SplatSortStrategyFactory } from '../core/strategy-types';
import type { SplatModifier } from '../core/splat-modifier';

interface SplatMeshInternals {
  sorter: SplatSorter | null;
  rebuildActiveList(): void;
  requestSortIfNeeded(camera: THREE.Camera, renderer: THREE.WebGPURenderer): boolean;
}

function internals(mesh: SplatMesh): SplatMeshInternals {
  return mesh as unknown as SplatMeshInternals;
}

function makeSplatData(count: number) {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

function renderer(webGpu: boolean): THREE.WebGPURenderer {
  return { backend: { isWebGPUBackend: webGpu } } as unknown as THREE.WebGPURenderer;
}

function cameraAt(x: number): THREE.Camera {
  const camera = new THREE.Camera();
  camera.position.set(x, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

/** Carries every splat 2 units along -z: the shape of a transform volume. */
const carry: SplatModifier = (ctx) => ({ offset: ctx.offset.add(vec3(0, 0, float(-2))) });

function fakeSorter(): SplatSorter & { sort: ReturnType<typeof vi.fn> } {
  return { kind: 'counting', sort: vi.fn(() => true), dispose: vi.fn() };
}

function textureSorterOptions(): Omit<SplatSorterOptions, 'renderer'> & {
  renderer: THREE.WebGPURenderer;
} {
  return {
    renderer: { compute: vi.fn() } as unknown as THREE.WebGPURenderer,
    capacity: 256,
    centersTexture: new THREE.DataTexture(
      new Float32Array(256 * 4),
      256,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    ),
    dataTextureWidth: 256,
    splatIndexAttribute: new THREE.StorageInstancedBufferAttribute(new Float32Array(256), 1),
    sourceIndexAttribute: new THREE.StorageBufferAttribute(new Uint32Array(256), 1),
  };
}

describe('SplatMesh.sortDisplacement', () => {
  const meshes: SplatMesh[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
  });

  function mesh(options: { sortIntervalMs?: number } = {}): SplatMesh {
    const result = new SplatMesh({ capacity: 4096 }, options);
    result.appendRange(makeSplatData(4));
    internals(result).rebuildActiveList();
    meshes.push(result);
    return result;
  }

  function capturingStrategy(): {
    strategy: SplatSortStrategyFactory;
    created: SplatSorterOptions[];
  } {
    const created: SplatSorterOptions[] = [];
    return {
      created,
      strategy: {
        kind: 'radix',
        exactDepth: false,
        create: (options) => {
          created.push(options);
          return fakeSorter();
        },
      },
    };
  }

  it('builds the GPU sorter without a center adapter by default', async () => {
    const target = mesh();
    const { strategy, created } = capturingStrategy();
    await target.setSortStrategy(strategy);
    internals(target).requestSortIfNeeded(cameraAt(0), renderer(true));
    expect(created).toHaveLength(1);
    expect(created[0]).not.toHaveProperty('sortCenter');
  });

  it('rebuilds the GPU sorter with a center adapter when the list changes', async () => {
    const target = mesh();
    const { strategy, created } = capturingStrategy();
    await target.setSortStrategy(strategy);
    internals(target).requestSortIfNeeded(cameraAt(0), renderer(true));
    const first = internals(target).sorter!;

    target.sortDisplacement = [carry];
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(internals(target).sorter).toBeNull();
    // The list change forces a sort even with the camera where it was.
    expect(internals(target).requestSortIfNeeded(cameraAt(0), renderer(true))).toBe(true);
    expect(created).toHaveLength(2);
    expect(created[1]!.sortCenter).toBeTypeOf('function');

    // Re-assigning the same modifiers is a no-op.
    const second = internals(target).sorter!;
    target.sortDisplacement = [carry];
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it('folds only the listed modifiers into a displaced sort center', () => {
    const target = mesh();
    const listed = vi.fn(carry);
    const unlisted = vi.fn(carry);
    target.modifiers = [unlisted, listed];
    unlisted.mockClear();
    target.sortDisplacement = [listed];
    const adapter = (
      target as unknown as { sortCenterAdapter(): SplatSortCenterAdapter | null }
    ).sortCenterAdapter()!;
    const center = vec3(1, 2, 3);
    const result = adapter({ center, poolIndex: int(0), texel: ivec2(0, 0) });
    expect(listed).toHaveBeenCalled();
    expect(unlisted).not.toHaveBeenCalled();
    expect(result).not.toBe(center);
  });

  it('rejects camera-relative fields in a sort displacement modifier', () => {
    const target = mesh();
    target.sortDisplacement = [(ctx) => ({ offset: ctx.worldCenter })];
    const adapter = (
      target as unknown as { sortCenterAdapter(): SplatSortCenterAdapter | null }
    ).sortCenterAdapter()!;
    expect(() => adapter({ center: vec3(0), poolIndex: int(0), texel: ivec2(0, 0) })).toThrow(
      /worldCenter/,
    );
  });

  it('rejects ctx.cameraWorld in a sort displacement modifier', () => {
    const target = mesh();
    target.sortDisplacement = [(ctx) => ({ offset: ctx.cameraWorld! })];
    const adapter = (
      target as unknown as { sortCenterAdapter(): SplatSortCenterAdapter | null }
    ).sortCenterAdapter()!;
    expect(() => adapter({ center: vec3(0), poolIndex: int(0), texel: ivec2(0, 0) })).toThrow(
      /cameraWorld/,
    );
  });

  it('re-sorts a stationary camera after invalidateSortDisplacement, once per change', () => {
    const target = mesh({ sortIntervalMs: 0 });
    target.sortDisplacement = [carry];
    const sorter = fakeSorter();
    internals(target).sorter = sorter;
    const camera = cameraAt(0);

    internals(target).requestSortIfNeeded(camera, renderer(true));
    internals(target).requestSortIfNeeded(camera, renderer(true));
    expect(sorter.sort).toHaveBeenCalledTimes(1);

    target.invalidateSortDisplacement();
    internals(target).requestSortIfNeeded(camera, renderer(true));
    internals(target).requestSortIfNeeded(camera, renderer(true));
    expect(sorter.sort).toHaveBeenCalledTimes(2);
  });

  it('keeps a displacement re-sort on the sort cadence', () => {
    const target = mesh({ sortIntervalMs: 100 });
    target.sortDisplacement = [carry];
    const sorter = fakeSorter();
    internals(target).sorter = sorter;
    const camera = cameraAt(0);
    const now = vi.spyOn(performance, 'now');

    now.mockReturnValue(0);
    internals(target).requestSortIfNeeded(camera, renderer(true));
    target.invalidateSortDisplacement();
    now.mockReturnValue(50);
    internals(target).requestSortIfNeeded(camera, renderer(true));
    expect(sorter.sort).toHaveBeenCalledTimes(1);
    now.mockReturnValue(100);
    internals(target).requestSortIfNeeded(camera, renderer(true));
    expect(sorter.sort).toHaveBeenCalledTimes(2);
  });

  it('ignores invalidateSortDisplacement without a displacement list', () => {
    const target = mesh({ sortIntervalMs: 0 });
    const sorter = fakeSorter();
    internals(target).sorter = sorter;
    const camera = cameraAt(0);

    internals(target).requestSortIfNeeded(camera, renderer(true));
    target.invalidateSortDisplacement();
    internals(target).requestSortIfNeeded(camera, renderer(true));
    expect(sorter.sort).toHaveBeenCalledTimes(1);
    // A unified owner still reads the revision.
    expect(getSplatSortDisplacementRevision(target)).toBe(1);
  });

  it('leaves the WebGL worker path to camera motion', () => {
    const target = mesh({ sortIntervalMs: 0 });
    target.sortDisplacement = [carry];
    const sorter = fakeSorter();
    internals(target).sorter = sorter;
    const camera = cameraAt(0);

    internals(target).requestSortIfNeeded(camera, renderer(false));
    target.invalidateSortDisplacement();
    internals(target).requestSortIfNeeded(camera, renderer(false));
    expect(sorter.sort).toHaveBeenCalledTimes(1);
  });
});

describe('GPU sorter sortCenter inputs', () => {
  const adapter: SplatSortCenterAdapter = ({ center }) => center;

  it.each([
    ['ComputeSorter', (options: SplatSorterOptions) => new ComputeSorter(options)],
    ['RadixSorter', (options: SplatSorterOptions) => new RadixSorter(options)],
  ])('%s accepts an adapter on texture-read centers', (_name, create) => {
    const sorter = create({ ...textureSorterOptions(), sortCenter: adapter });
    sorter.dispose();
  });

  it.each([
    ['ComputeSorter', (options: SplatSorterOptions) => new ComputeSorter(options)],
    ['RadixSorter', (options: SplatSorterOptions) => new RadixSorter(options)],
  ])('%s rejects an adapter on already-gathered work-buffer centers', (name, create) => {
    const { centersTexture: _texture, dataTextureWidth: _width, ...rest } = textureSorterOptions();
    expect(() =>
      create({
        ...rest,
        centersBuffer: new THREE.StorageBufferAttribute(new Float32Array(256 * 4), 4),
        sortCenter: adapter,
      }),
    ).toThrow(new RegExp(`${name}: sortCenter`));
  });
});
