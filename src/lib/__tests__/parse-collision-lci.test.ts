import { describe, expect, it } from 'vitest';
import { parseCollisionLci } from '../formats/lcc/parse-collision-lci';

/**
 * Builds a minimal version-2 `collision.lci` for unit tests.
 *
 * Layout matches live captures: 48-byte global header, 40-byte mesh headers,
 * then per-mesh vertex / face / BVH payloads with
 * `verts*12 + faces*12 + bvh == dataSize`.
 */
function buildLci(options: {
  meshes: {
    cellX: number;
    cellY: number;
    positions: number[];
    indices: number[];
    bvhBytes?: number;
  }[];
  bounds?: { min: [number, number, number]; max: [number, number, number] };
  cellLengthX?: number;
  cellLengthY?: number;
  /** Override header fields after the buffer is built (for negative tests). */
  mutate?: (view: DataView, buffer: ArrayBuffer) => void;
}): ArrayBuffer {
  const meshCount = options.meshes.length;
  const headerLen = 48 + meshCount * 40;
  let payload = 0;
  for (const mesh of options.meshes) {
    const verts = mesh.positions.length / 3;
    const faces = mesh.indices.length / 3;
    payload += verts * 12 + faces * 12 + (mesh.bvhBytes ?? 0);
  }
  const buffer = new ArrayBuffer(headerLen + payload);
  const view = new DataView(buffer);
  const min = options.bounds?.min ?? [0, 0, 0];
  const max = options.bounds?.max ?? [30, 30, 10];

  view.setUint32(0, 0x6c6c6f63, true); // 'coll'
  view.setUint32(4, 2, true);
  view.setUint32(8, headerLen, true);
  view.setFloat32(12, min[0], true);
  view.setFloat32(16, min[1], true);
  view.setFloat32(20, min[2], true);
  view.setFloat32(24, max[0], true);
  view.setFloat32(28, max[1], true);
  view.setFloat32(32, max[2], true);
  view.setFloat32(36, options.cellLengthX ?? 30, true);
  view.setFloat32(40, options.cellLengthY ?? 30, true);
  view.setUint32(44, meshCount, true);

  let dataOffset = headerLen;
  for (let i = 0; i < meshCount; i++) {
    const mesh = options.meshes[i]!;
    const vertexCount = mesh.positions.length / 3;
    const faceCount = mesh.indices.length / 3;
    const bvh = mesh.bvhBytes ?? 0;
    const dataSize = vertexCount * 12 + faceCount * 12 + bvh;
    const at = 48 + i * 40;
    view.setUint32(at, mesh.cellX, true);
    view.setUint32(at + 4, mesh.cellY, true);
    view.setBigUint64(at + 8, BigInt(dataOffset), true);
    view.setBigUint64(at + 16, BigInt(dataSize), true);
    view.setUint32(at + 24, vertexCount, true);
    view.setUint32(at + 28, faceCount, true);
    view.setUint32(at + 32, bvh, true);
    view.setUint32(at + 36, 0, true);

    for (let p = 0; p < mesh.positions.length; p++) {
      view.setFloat32(dataOffset + p * 4, mesh.positions[p]!, true);
    }
    const indexAt = dataOffset + vertexCount * 12;
    for (let f = 0; f < mesh.indices.length; f++) {
      view.setUint32(indexAt + f * 4, mesh.indices[f]!, true);
    }
    dataOffset += dataSize;
  }

  options.mutate?.(view, buffer);
  return buffer;
}

const TRI = {
  cellX: 1,
  cellY: 0,
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  indices: [0, 1, 2],
};

describe('parseCollisionLci', () => {
  it('parses a one-mesh file into triangle data and cell bounds', () => {
    const parsed = parseCollisionLci(
      buildLci({
        meshes: [TRI],
        bounds: { min: [0, 0, -1], max: [60, 60, 5] },
      }),
    );

    expect(parsed.version).toBe(2);
    expect(parsed.cellLengthX).toBe(30);
    expect(parsed.tiles).toHaveLength(1);
    const tile = parsed.tiles[0]!;
    expect(tile.cellX).toBe(1);
    expect(tile.cellY).toBe(0);
    expect(tile.data.vertexCount).toBe(3);
    expect(tile.data.triangleCount).toBe(1);
    expect([...tile.data.positions]).toEqual(TRI.positions);
    expect([...tile.data.indices]).toEqual(TRI.indices);
    // Cell (1,0) on a 30 m grid from (0,0,-1)..(60,60,5).
    expect(tile.bounds.min.toArray()).toEqual([30, 0, -1]);
    expect(tile.bounds.max.toArray()).toEqual([60, 30, 5]);
  });

  it('parses multiple meshes and skips BVH padding', () => {
    const parsed = parseCollisionLci(
      buildLci({
        meshes: [
          TRI,
          {
            cellX: 0,
            cellY: 0,
            positions: [2, 2, 2, 3, 2, 2, 2, 3, 2, 3, 3, 2],
            indices: [0, 1, 2, 0, 2, 3],
            bvhBytes: 32,
          },
        ],
      }),
    );

    expect(parsed.tiles).toHaveLength(2);
    expect(parsed.tiles[1]?.data.triangleCount).toBe(2);
    expect(parsed.tiles[1]?.data.vertexCount).toBe(4);
  });

  it('rejects a bad magic', () => {
    expect(() =>
      parseCollisionLci(
        buildLci({
          meshes: [TRI],
          mutate: (view) => view.setUint32(0, 0xdeadbeef, true),
        }),
      ),
    ).toThrow(/magic/);
  });

  it('rejects an unsupported version', () => {
    expect(() =>
      parseCollisionLci(
        buildLci({
          meshes: [TRI],
          mutate: (view) => view.setUint32(4, 99, true),
        }),
      ),
    ).toThrow(/version 99/);
  });

  it('rejects a truncated payload', () => {
    const full = buildLci({ meshes: [TRI] });
    expect(() => parseCollisionLci(full.slice(0, full.byteLength - 4))).toThrow(
      /truncated|past file/,
    );
  });

  it('rejects an out-of-range face index', () => {
    expect(() =>
      parseCollisionLci(
        buildLci({
          meshes: [{ ...TRI, indices: [0, 1, 99] }],
        }),
      ),
    ).toThrow(/out of range/);
  });

  it('rejects a size field that does not match geometry + BVH', () => {
    expect(() =>
      parseCollisionLci(
        buildLci({
          meshes: [TRI],
          mutate: (view) => {
            // Inflate dataSize without matching geometry/BVH fields.
            view.setBigUint64(48 + 16, 9999n, true);
          },
        }),
      ),
    ).toThrow(/size/);
  });
});
