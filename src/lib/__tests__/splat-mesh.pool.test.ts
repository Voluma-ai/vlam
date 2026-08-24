import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { SplatMesh } from '../splat-mesh';
import { writeCovariance } from '../splat-data';

/**
 * Tests for the dynamic-capacity pool's row allocator: free-list reuse,
 * capacity exhaustion, row-alignment fragmentation, and compaction.
 * Everything goes through the public pool API (appendRange / removeRange /
 * compact / freeSplatCapacity / activeSplatCount); the private active-list
 * rebuild is invoked directly because its public trigger, update(), needs a
 * live renderer (same internal-reach style as splat-mesh.channels.test.ts).
 */

const WIDTH = 2048; // SplatMesh.DATA_TEXTURE_WIDTH

function makeSplatData(
  count: number,
  xBase = 0,
): {
  count: number;
  positions: Float32Array;
  colors: Uint8Array;
  covariances: Float32Array;
} {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = xBase + i;
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

/** Rebuilds the active list the way update() does once per frame. */
function refreshActiveList(mesh: SplatMesh): void {
  (mesh as unknown as { rebuildActiveList(): void }).rebuildActiveList();
}

/** The first `count` active pool indices, in active-list order. */
function activeIndices(mesh: SplatMesh, count: number): number[] {
  const attr = (mesh as unknown as { sourceIndexAttribute: { array: Uint32Array } })
    .sourceIndexAttribute;
  return Array.from(attr.array.subarray(0, count));
}

/** The source-index attribute API needed to verify partial active-list uploads. */
function sourceIndexAttribute(mesh: SplatMesh): THREE.StorageBufferAttribute {
  return (mesh as unknown as { sourceIndexAttribute: THREE.StorageBufferAttribute })
    .sourceIndexAttribute;
}

/** The pool's CPU centers backing (x at stride 4), for relocation checks. */
function centersBacking(mesh: SplatMesh): Float32Array {
  return (mesh as unknown as { backing: { centers: Float32Array } }).backing.centers;
}

/** Acquires the private reusable staging texture without needing a renderer. */
function acquireUploadStaging(
  mesh: SplatMesh,
  key: string,
  data: Float32Array,
  width: number,
  height: number,
): THREE.DataTexture {
  return (
    mesh as unknown as {
      acquireUploadStaging(
        key: string,
        data: Float32Array,
        width: number,
        height: number,
        format: THREE.PixelFormat,
        type: THREE.TextureDataType,
      ): THREE.DataTexture;
    }
  ).acquireUploadStaging(key, data, width, height, THREE.RGBAFormat, THREE.FloatType);
}

describe('SplatMesh pool row allocator', () => {
  const meshes: SplatMesh[] = [];
  afterEach(() => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
  });

  function dynamicMesh(capacity = 4 * WIDTH): SplatMesh {
    const mesh = new SplatMesh({ capacity });
    meshes.push(mesh);
    return mesh;
  }

  it('reuses freed rows: append, remove, append of the same size leaves capacity unchanged', () => {
    const mesh = dynamicMesh(4 * WIDTH);
    const a = mesh.appendRange(makeSplatData(WIDTH));
    const freeAfterA = mesh.freeSplatCapacity;
    expect(freeAfterA).toBe(3 * WIDTH);

    mesh.removeRange(a);
    expect(mesh.freeSplatCapacity).toBe(4 * WIDTH);

    const b = mesh.appendRange(makeSplatData(WIDTH));
    expect(mesh.freeSplatCapacity).toBe(freeAfterA);
    expect(mesh.capacity).toBe(4 * WIDTH);

    // A full-pool append still fits after the churn (rows fully recycled).
    mesh.removeRange(b);
    mesh.appendRange(makeSplatData(4 * WIDTH));
    expect(mesh.freeSplatCapacity).toBe(0);
  });

  it('throws the documented capacity error when the pool cannot fit a range', () => {
    const mesh = dynamicMesh(4 * WIDTH);
    expect(() => mesh.appendRange(makeSplatData(4 * WIDTH + 1))).toThrow(/capacity exceeded/);

    // A failed append must not consume rows: the full pool still fits.
    mesh.appendRange(makeSplatData(4 * WIDTH));
    expect(() => mesh.appendRange(makeSplatData(1))).toThrow(/capacity exceeded/);
  });

  it('fragmentation: enough total free space but no contiguous hole throws until compact()', () => {
    const mesh = dynamicMesh(4 * WIDTH);
    mesh.appendRange(makeSplatData(WIDTH)); // row 0
    const b = mesh.appendRange(makeSplatData(WIDTH)); // row 1
    mesh.appendRange(makeSplatData(WIDTH)); // row 2

    mesh.removeRange(b); // free rows: 1 and 3 - 2 rows total, not contiguous
    expect(mesh.freeSplatCapacity).toBe(2 * WIDTH);

    // Needs 2 contiguous rows; only 1-row holes exist despite the total.
    expect(() => mesh.appendRange(makeSplatData(WIDTH + 1))).toThrow(/capacity exceeded/);

    mesh.compact(); // survivors pack to rows 0-1, free rows 2-3 merge
    expect(mesh.freeSplatCapacity).toBe(2 * WIDTH);
    mesh.appendRange(makeSplatData(WIDTH + 1));
    expect(mesh.freeSplatCapacity).toBe(0);
  });

  it('uses the smallest fitting hole so later large allocations avoid compaction', () => {
    const mesh = dynamicMesh(7 * WIDTH);
    const large = mesh.appendRange(makeSplatData(3 * WIDTH));
    mesh.appendRange(makeSplatData(2 * WIDTH));
    const exact = mesh.appendRange(makeSplatData(2 * WIDTH));
    mesh.removeRange(large);
    mesh.removeRange(exact);

    // Free holes are three rows and two rows. Best-fit consumes the exact
    // two-row hole, preserving the only three-row span for the next request.
    mesh.appendRange(makeSplatData(2 * WIDTH));
    expect(() => mesh.appendRange(makeSplatData(3 * WIDTH))).not.toThrow();
    expect(mesh.freeSplatCapacity).toBe(0);
  });

  it('compacts multiple interleaved holes, relocating data and preserving the active count', () => {
    const mesh = dynamicMesh(6 * WIDTH);
    const ranges = [0, 1, 2, 3, 4, 5].map((i) =>
      mesh.appendRange(makeSplatData(WIDTH, i * 100_000)),
    );
    // Remove B, D, F: three interleaved single-row holes (rows 1, 3, 5).
    mesh.removeRange(ranges[1]!);
    mesh.removeRange(ranges[3]!);
    mesh.removeRange(ranges[5]!);
    refreshActiveList(mesh);
    expect(mesh.activeSplatCount).toBe(3 * WIDTH);
    expect(mesh.freeSplatCapacity).toBe(3 * WIDTH);

    mesh.compact();

    // Survivors A, C, E pack into rows 0..2 in ascending original row order,
    // carrying their splat data with them.
    const centers = centersBacking(mesh);
    const survivorBases = [0, 200_000, 400_000]; // xBase of A, C, E
    for (let row = 0; row < 3; row++) {
      for (const k of [0, 1, WIDTH - 1]) {
        expect(centers[(row * WIDTH + k) * 4]).toBe((survivorBases[row] as number) + k);
      }
    }

    refreshActiveList(mesh);
    expect(mesh.activeSplatCount).toBe(3 * WIDTH);

    // The three former holes are now one contiguous span.
    mesh.appendRange(makeSplatData(3 * WIDTH));
    expect(mesh.freeSplatCapacity).toBe(0);
  });

  it('activeSplatCount tracks churn and the active list keeps append order', () => {
    const mesh = dynamicMesh(4 * WIDTH);
    const a = mesh.appendRange(makeSplatData(100));
    const b = mesh.appendRange(makeSplatData(300));
    const c = mesh.appendRange(makeSplatData(50));
    refreshActiveList(mesh);
    expect(mesh.activeSplatCount).toBe(450);

    mesh.removeRange(b);
    refreshActiveList(mesh);
    expect(mesh.activeSplatCount).toBe(150);

    // D reuses B's freed row (first-fit), but appends after A and C in the
    // active list - pool position and append order are independent.
    const d = mesh.appendRange(makeSplatData(70));
    refreshActiveList(mesh);
    expect(mesh.activeSplatCount).toBe(220);

    const expected = [
      ...Array.from({ length: 100 }, (_, i) => i), // A at row 0
      ...Array.from({ length: 50 }, (_, i) => 2 * WIDTH + i), // C at row 2
      ...Array.from({ length: 70 }, (_, i) => WIDTH + i), // D reused row 1
    ];
    expect(activeIndices(mesh, 220)).toEqual(expected);

    mesh.removeRange(a);
    mesh.removeRange(c);
    mesh.removeRange(d);
    refreshActiveList(mesh);
    expect(mesh.activeSplatCount).toBe(0);
    expect(mesh.freeSplatCapacity).toBe(4 * WIDTH);
  });

  it('incrementally backfills removed slots and uploads only changed spans', () => {
    const mesh = dynamicMesh(4 * WIDTH);
    mesh.appendRange(makeSplatData(100));
    const removed = mesh.appendRange(makeSplatData(300));
    mesh.appendRange(makeSplatData(50));
    const source = sourceIndexAttribute(mesh);
    source.clearUpdateRanges();

    mesh.removeRange(removed);

    expect(mesh.activeSplatCount).toBe(150);
    expect(activeIndices(mesh, 150)).toEqual([
      ...Array.from({ length: 100 }, (_, index) => index),
      ...Array.from({ length: 50 }, (_, index) => 2 * WIDTH + index),
    ]);
    expect(source.updateRanges).toEqual([{ start: 100, count: 50 }]);

    source.clearUpdateRanges();
    mesh.appendRange(makeSplatData(70));
    expect(mesh.activeSplatCount).toBe(220);
    expect(source.updateRanges).toEqual([{ start: 150, count: 70 }]);
  });

  it('coalesces touching active-list mutations into one WebGPU upload range', () => {
    const mesh = dynamicMesh(4 * WIDTH);
    const source = sourceIndexAttribute(mesh);
    source.clearUpdateRanges();

    mesh.appendRange(makeSplatData(50));
    mesh.appendRange(makeSplatData(70));
    mesh.appendRange(makeSplatData(30));

    expect(source.updateRanges).toEqual([{ start: 0, count: 150 }]);
  });

  it('caches recent exact-size staging textures across varying upload heights', () => {
    const mesh = dynamicMesh();
    const data = new Float32Array(4 * WIDTH * 3);
    const first = acquireUploadStaging(mesh, 'test', data, WIDTH, 2);
    const exactReuse = acquireUploadStaging(mesh, 'test', data, WIDTH, 2);
    const smaller = acquireUploadStaging(mesh, 'test', data, WIDTH, 1);
    const larger = acquireUploadStaging(mesh, 'test', data, WIDTH, 3);
    const firstAgain = acquireUploadStaging(mesh, 'test', data, WIDTH, 2);

    expect(exactReuse).toBe(first);
    expect(smaller).not.toBe(first);
    expect(smaller.image.height).toBe(1);
    expect(larger).not.toBe(smaller);
    expect(larger.image.height).toBe(3);
    expect(firstAgain).toBe(first);
  });

  it('bounds each staging cache and evicts the least recently used height', () => {
    const mesh = dynamicMesh();
    const data = new Float32Array(4 * WIDTH * 5);
    const first = acquireUploadStaging(mesh, 'test', data, WIDTH, 1);
    const dispose = vi.spyOn(first, 'dispose');
    for (let height = 2; height <= 5; height++) {
      acquireUploadStaging(mesh, 'test', data, WIDTH, height);
    }

    expect(dispose).toHaveBeenCalledOnce();
    expect(acquireUploadStaging(mesh, 'test', data, WIDTH, 1)).not.toBe(first);
  });

  it('removeRange rejects an unknown handle', () => {
    const mesh = dynamicMesh();
    expect(() => mesh.removeRange({ count: 1 })).toThrow(/unknown range/);
  });
});

describe('SplatMesh poolFloatTextures float16', () => {
  const meshes: SplatMesh[] = [];
  afterEach(() => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
  });

  it('allocates HalfFloatType centers/covA and keeps covarianceB float32', () => {
    const mesh = new SplatMesh({ capacity: WIDTH }, { poolFloatTextures: 'float16' });
    meshes.push(mesh);
    const textures = (
      mesh as unknown as {
        dataTextures: THREE.DataTexture[];
        poolFloatTextures: 'float32' | 'float16';
      }
    ).dataTextures;
    expect((mesh as unknown as { poolFloatTextures: string }).poolFloatTextures).toBe('float16');
    expect(textures[0]!.type).toBe(THREE.HalfFloatType);
    expect(textures[0]!.image.data).toBeInstanceOf(Uint16Array);
    expect(textures[2]!.type).toBe(THREE.HalfFloatType);
    expect(textures[2]!.image.data).toBeInstanceOf(Uint16Array);
    expect(textures[3]!.type).toBe(THREE.FloatType);
    expect(textures[3]!.image.data).toBeInstanceOf(Float32Array);
    // CPU backing stays float32 for sorter/query.
    expect(centersBacking(mesh)).toBeInstanceOf(Float32Array);
  });

  it('default path still uses FloatType for all float pool textures', () => {
    const mesh = new SplatMesh({ capacity: WIDTH });
    meshes.push(mesh);
    const textures = (mesh as unknown as { dataTextures: THREE.DataTexture[] }).dataTextures;
    expect(textures[0]!.type).toBe(THREE.FloatType);
    expect(textures[2]!.type).toBe(THREE.FloatType);
    expect(textures[3]!.type).toBe(THREE.FloatType);
  });

  it('flushPendingUploads stages half-encoded centers/covA', () => {
    const mesh = new SplatMesh({ capacity: WIDTH }, { poolFloatTextures: 'float16' });
    meshes.push(mesh);
    mesh.appendRange(makeSplatData(4, 12.5));

    const stagingTypes: THREE.TextureDataType[] = [];
    const stagingDataKinds: string[] = [];
    const renderer = {
      copyTextureToTexture: vi.fn((src: THREE.DataTexture) => {
        stagingTypes.push(src.type);
        stagingDataKinds.push(Object.prototype.toString.call(src.image.data));
      }),
    } as unknown as THREE.WebGPURenderer;

    (mesh as unknown as { flushPendingUploads(r: THREE.WebGPURenderer): void }).flushPendingUploads(
      renderer,
    );

    // Four core textures: centers (half), colors (byte), covA (half), covB (float).
    expect(stagingTypes).toEqual([
      THREE.HalfFloatType,
      THREE.UnsignedByteType,
      THREE.HalfFloatType,
      THREE.FloatType,
    ]);
    expect(stagingDataKinds[0]).toBe('[object Uint16Array]');
    expect(stagingDataKinds[2]).toBe('[object Uint16Array]');
    expect(stagingDataKinds[3]).toBe('[object Float32Array]');
  });

  it('static constructor packs half images before the initial upload', () => {
    const data = makeSplatData(3, 7);
    const mesh = new SplatMesh(data, { poolFloatTextures: 'float16' });
    meshes.push(mesh);
    const centersImg = (mesh as unknown as { dataTextures: THREE.DataTexture[] }).dataTextures[0]!
      .image.data as Uint16Array;
    // x of splat 0 was written as 7; half bits must be non-zero after sync.
    expect(centersImg[0]).not.toBe(0);
    expect((mesh as unknown as { pendingUploadRows: unknown[] }).pendingUploadRows).toHaveLength(0);
  });
});
