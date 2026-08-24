import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { loadCollisionMeshTiles } from '../formats/lcc/collision-mesh';

/**
 * Tests for fetching an `.lcc2` / classic-LCC capture's collision tiles.
 *
 * The behavior worth pinning is the degradation: one bad tile must cost the
 * host that tile's geometry, not the whole set - the same bargain the chunk
 * pipeline makes with a splat tile it cannot decode.
 */

/** A minimal single-triangle mesh PLY. */
function triangle(): ArrayBuffer {
  const header = new TextEncoder().encode(
    'ply\nformat binary_little_endian 1.0\nelement vertex 3\n' +
      'property float x\nproperty float y\nproperty float z\n' +
      'element face 1\nproperty list uchar int vertex_indices\nend_header\n',
  );
  const buffer = new ArrayBuffer(header.length + 36 + 13);
  new Uint8Array(buffer).set(header);
  const view = new DataView(buffer);
  const coordinates = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  coordinates.forEach((value, i) => view.setFloat32(header.length + i * 4, value, true));
  let offset = header.length + 36;
  view.setUint8(offset, 3);
  offset += 1;
  for (const index of [0, 1, 2]) {
    view.setInt32(offset, index, true);
    offset += 4;
  }
  return buffer;
}

/** A two-mesh classic-LCC `collision.lci` (version 2). */
function collisionLci(): ArrayBuffer {
  const meshes = [
    { cellX: 0, cellY: 0, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
    {
      cellX: 1,
      cellY: 0,
      positions: [2, 0, 0, 3, 0, 0, 2, 1, 0, 3, 1, 0],
      indices: [0, 1, 2, 0, 2, 3],
    },
  ];
  const headerLen = 48 + meshes.length * 40;
  let payload = 0;
  for (const mesh of meshes) {
    payload += (mesh.positions.length / 3) * 12 + (mesh.indices.length / 3) * 12;
  }
  const buffer = new ArrayBuffer(headerLen + payload);
  const view = new DataView(buffer);
  view.setUint32(0, 0x6c6c6f63, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, headerLen, true);
  view.setFloat32(12, 0, true);
  view.setFloat32(16, 0, true);
  view.setFloat32(20, -1, true);
  view.setFloat32(24, 60, true);
  view.setFloat32(28, 30, true);
  view.setFloat32(32, 5, true);
  view.setFloat32(36, 30, true);
  view.setFloat32(40, 30, true);
  view.setUint32(44, meshes.length, true);
  let dataOffset = headerLen;
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i]!;
    const vertexCount = mesh.positions.length / 3;
    const faceCount = mesh.indices.length / 3;
    const dataSize = vertexCount * 12 + faceCount * 12;
    const at = 48 + i * 40;
    view.setUint32(at, mesh.cellX, true);
    view.setUint32(at + 4, mesh.cellY, true);
    view.setBigUint64(at + 8, BigInt(dataOffset), true);
    view.setBigUint64(at + 16, BigInt(dataSize), true);
    view.setUint32(at + 24, vertexCount, true);
    view.setUint32(at + 28, faceCount, true);
    view.setUint32(at + 32, 0, true);
    for (let p = 0; p < mesh.positions.length; p++) {
      view.setFloat32(dataOffset + p * 4, mesh.positions[p]!, true);
    }
    const indexAt = dataOffset + vertexCount * 12;
    for (let f = 0; f < mesh.indices.length; f++) {
      view.setUint32(indexAt + f * 4, mesh.indices[f]!, true);
    }
    dataOffset += dataSize;
  }
  return buffer;
}

/** Serves triangle PLYs / LCI bodies, except URLs given a canned failure. */
function stubFetch(failures: Record<string, 'http' | 'corrupt'> = {}): void {
  vi.stubGlobal('fetch', (input: string | URL) => {
    const url = String(input);
    const failure = failures[url];
    if (failure === 'http') return Promise.resolve(new Response('', { status: 404 }));
    if (failure === 'corrupt') {
      return Promise.resolve(new Response(new TextEncoder().encode('not a mesh'), { status: 200 }));
    }
    const body = url.toLowerCase().includes('.lci') ? collisionLci() : triangle();
    return Promise.resolve(new Response(body, { status: 200 }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const meshes = [{ url: 'https://host/a.ply' }, { url: 'https://host/b.ply' }];

describe('loadCollisionMeshTiles', () => {
  it('fetches and parses every tile, passing bounds through', async () => {
    stubFetch();
    const bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1));

    const tiles = await loadCollisionMeshTiles({ meshes: [{ url: 'https://host/a.ply', bounds }] });

    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.url).toBe('https://host/a.ply');
    expect(tiles[0]?.data.triangleCount).toBe(1);
    expect(tiles[0]?.bounds).toBe(bounds);
  });

  it('expands a collision.lci into per-cell tiles', async () => {
    stubFetch();
    const tiles = await loadCollisionMeshTiles({
      meshes: [{ url: 'https://host/capture/collision.lci' }],
    });

    expect(tiles).toHaveLength(2);
    expect(tiles.map((tile) => tile.url)).toEqual([
      'https://host/capture/collision.lci#c0_0',
      'https://host/capture/collision.lci#c1_0',
    ]);
    expect(tiles[0]?.data.triangleCount).toBe(1);
    expect(tiles[1]?.data.triangleCount).toBe(2);
    expect(tiles[0]?.bounds?.min.toArray()).toEqual([0, 0, -1]);
    expect(tiles[0]?.bounds?.max.toArray()).toEqual([30, 30, 5]);
  });

  it('skips tiles that 404 or fail to parse, keeping the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch({ 'https://host/a.ply': 'http' });

    const tiles = await loadCollisionMeshTiles({ meshes });

    expect(tiles.map((tile) => tile.url)).toEqual(['https://host/b.ply']);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('skips a corrupt tile', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch({ 'https://host/b.ply': 'corrupt' });

    const tiles = await loadCollisionMeshTiles({ meshes });

    expect(tiles.map((tile) => tile.url)).toEqual(['https://host/a.ply']);
    warn.mockRestore();
  });

  it('rejects when aborted', async () => {
    stubFetch();
    const controller = new AbortController();
    controller.abort();

    await expect(
      loadCollisionMeshTiles({ meshes }, { signal: controller.signal }),
    ).rejects.toThrow();
  });
});
