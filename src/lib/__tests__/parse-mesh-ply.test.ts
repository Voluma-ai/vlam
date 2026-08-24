import { describe, expect, it } from 'vitest';
import { parseMeshPly } from '../formats/lcc/parse-mesh-ply';
import { parsePlyHeader } from '../ply-header';

/**
 * Tests for the plain triangle-mesh PLY parser, against synthetic files.
 *
 * The face element is the interesting part: its records are variable-size, so
 * every read is a cursor walk with nothing to check it against - a miscounted
 * record silently shifts every face after it. The cases below pin the cursor
 * arithmetic (odd polygon sizes, degenerate faces, mixed index types) rather
 * than just the happy path.
 */

interface MeshSpec {
  vertices?: number[][];
  /** Vertex-index lists, one per face; any length. */
  faces?: number[][];
  vertexProperties?: string[];
  countType?: string;
  itemType?: string;
  faceProperty?: string;
  format?: string;
  /** Bytes to cut from the end, to make a truncated file. */
  truncateBy?: number;
}

const INT_WRITERS: Record<
  string,
  { size: number; write: (v: DataView, o: number, x: number) => void }
> = {
  uchar: { size: 1, write: (v, o, x) => v.setUint8(o, x) },
  ushort: { size: 2, write: (v, o, x) => v.setUint16(o, x, true) },
  int: { size: 4, write: (v, o, x) => v.setInt32(o, x, true) },
  uint16: { size: 2, write: (v, o, x) => v.setUint16(o, x, true) },
};

/** Builds a binary PLY from a spec, so each test states only what it varies. */
function meshPly(spec: MeshSpec = {}): ArrayBuffer {
  const vertices = spec.vertices ?? [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ];
  const faces = spec.faces ?? [
    [0, 1, 2],
    [0, 2, 3],
  ];
  const vertexProperties = spec.vertexProperties ?? ['x', 'y', 'z'];
  const countType = spec.countType ?? 'uchar';
  const itemType = spec.itemType ?? 'int';
  const faceProperty = spec.faceProperty ?? 'vertex_indices';

  const header =
    'ply\n' +
    `format ${spec.format ?? 'binary_little_endian 1.0'}\n` +
    `element vertex ${vertices.length}\n` +
    vertexProperties.map((name) => `property float ${name}\n`).join('') +
    `element face ${faces.length}\n` +
    `property list ${countType} ${itemType} ${faceProperty}\n` +
    'end_header\n';

  const count = INT_WRITERS[countType];
  const item = INT_WRITERS[itemType];
  if (!count || !item) throw new Error(`test helper cannot write ${countType}/${itemType}`);

  const headerBytes = new TextEncoder().encode(header);
  const vertexBytes = vertices.length * vertexProperties.length * 4;
  const faceBytes = faces.reduce((sum, face) => sum + count.size + face.length * item.size, 0);
  const buffer = new ArrayBuffer(headerBytes.length + vertexBytes + faceBytes);
  new Uint8Array(buffer).set(headerBytes);
  const view = new DataView(buffer);

  let offset = headerBytes.length;
  for (const vertex of vertices) {
    for (let i = 0; i < vertexProperties.length; i++) {
      view.setFloat32(offset, vertex[i] ?? 0, true);
      offset += 4;
    }
  }
  for (const face of faces) {
    count.write(view, offset, face.length);
    offset += count.size;
    for (const index of face) {
      item.write(view, offset, index);
      offset += item.size;
    }
  }

  return spec.truncateBy ? buffer.slice(0, buffer.byteLength - spec.truncateBy) : buffer;
}

describe('parseMeshPly', () => {
  it('decodes vertices and triangles', () => {
    const mesh = parseMeshPly(meshPly());

    expect(mesh.vertexCount).toBe(4);
    expect(mesh.triangleCount).toBe(2);
    expect([...mesh.positions]).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    expect([...mesh.indices]).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('fan-triangulates a polygon face', () => {
    const mesh = parseMeshPly(meshPly({ faces: [[0, 1, 2, 3]] }));

    expect(mesh.triangleCount).toBe(2);
    expect([...mesh.indices]).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('skips a degenerate face without losing the ones after it', () => {
    const mesh = parseMeshPly(
      meshPly({
        faces: [
          [0, 1],
          [1, 2, 3],
        ],
      }),
    );

    expect(mesh.triangleCount).toBe(1);
    expect([...mesh.indices]).toEqual([1, 2, 3]);
  });

  it('reads a uint16 index list named vertex_index', () => {
    const mesh = parseMeshPly(meshPly({ itemType: 'uint16', faceProperty: 'vertex_index' }));

    expect([...mesh.indices]).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('honors vertex stride when the file carries extra properties', () => {
    const mesh = parseMeshPly(
      meshPly({
        vertexProperties: ['x', 'y', 'z', 'nx', 'ny', 'nz'],
        vertices: [
          [0, 0, 0, 9, 9, 9],
          [2, 0, 0, 9, 9, 9],
          [2, 3, 0, 9, 9, 9],
        ],
        faces: [[0, 1, 2]],
      }),
    );

    expect([...mesh.positions]).toEqual([0, 0, 0, 2, 0, 0, 2, 3, 0]);
  });

  it('accepts a mesh with no faces', () => {
    const mesh = parseMeshPly(meshPly({ faces: [] }));

    expect(mesh.vertexCount).toBe(4);
    expect(mesh.triangleCount).toBe(0);
    expect(mesh.indices.length).toBe(0);
  });

  it('rejects a file truncated inside the face data', () => {
    expect(() => parseMeshPly(meshPly({ truncateBy: 6 }))).toThrow(/Truncated/);
  });

  it('rejects an index past the end of the vertex list', () => {
    expect(() => parseMeshPly(meshPly({ faces: [[0, 1, 9]] }))).toThrow(/references vertex 9/);
  });

  it('rejects a negative face vertex count instead of walking backwards', () => {
    // Signed count type: patch the single face's count to -1. Unchecked, the
    // cursor steps backwards and misaligns every following read.
    const buffer = meshPly({ countType: 'int', faces: [[0, 1, 2]] });
    const view = new DataView(buffer);
    view.setInt32(buffer.byteLength - 16, -1, true);
    expect(() => parseMeshPly(buffer)).toThrow(/negative vertex count \(-1\)/);
  });

  it('rejects an ASCII PLY', () => {
    expect(() => parseMeshPly(meshPly({ format: 'ascii 1.0' }))).toThrow(/binary_little_endian/);
  });

  it('rejects a splat PLY, which has no faces', () => {
    const header = new TextEncoder().encode(
      'ply\nformat binary_little_endian 1.0\nelement vertex 1\n' +
        'property float x\nproperty float y\nproperty float z\nend_header\n',
    );
    const buffer = new ArrayBuffer(header.length + 12);
    new Uint8Array(buffer).set(header);

    expect(() => parseMeshPly(buffer)).toThrow(/no "face" element/);
  });
});

describe('parsePlyHeader list properties', () => {
  it("records a list property's count and item types", () => {
    const header = parsePlyHeader(meshPly({ countType: 'uchar', itemType: 'int' }));
    const face = header.element('face');

    expect(face?.hasListProperty).toBe(true);
    expect(face?.listProperties.get('vertex_indices')).toEqual({
      countType: 'uchar',
      itemType: 'int',
    });
  });

  it('rejects a list property declaring an unsizable type', () => {
    const text =
      'ply\nformat binary_little_endian 1.0\nelement face 1\n' +
      'property list uchar banana vertex_indices\nend_header\n';
    const bytes = new TextEncoder().encode(text);

    expect(() => parsePlyHeader(bytes.buffer)).toThrow(/Unsupported PLY property/);
  });
});
