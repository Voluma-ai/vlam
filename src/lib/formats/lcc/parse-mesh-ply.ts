import {
  assertPlyElementFits,
  assertPlyPropertyTypes,
  parsePlyHeader,
  plyPropertyOffset,
  plyTypeSize,
  type PlyElement,
} from '../../loaders/ply-header';

/**
 * Parser for plain binary triangle-mesh PLY files - vertices and faces, no
 * splat properties.
 *
 * XGRIDS `.lcc2` datasets ship these as collision/navigation companions to
 * their splat tiles (`data/mesh/*.ply`, see `docs/formats/lcc2-notes.md`): a vertex
 * element of float x/y/z and a face element of index lists. The geometry is a
 * plain triangle soup in the dataset's source-local frame - what a host needs
 * to build its own collision or spatial queries.
 *
 * Nothing here is LCC-specific: any binary little-endian PLY with a positioned
 * vertex element and an index list parses.
 */

/** Names the face index list goes by, in preference order. */
const FACE_INDEX_PROPERTIES = ['vertex_indices', 'vertex_index'] as const;

/** A plain indexed triangle mesh decoded from a PLY. */
export interface TriangleMeshData {
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** `x, y, z` per vertex, in the file's own coordinate frame. */
  readonly positions: Float32Array;
  /** Three vertex indices per triangle, into {@link positions}. */
  readonly indices: Uint32Array;
}

/**
 * Parses a binary little-endian triangle-mesh PLY.
 *
 * Faces with more than three vertices are fan-triangulated; degenerate faces
 * (fewer than three) are dropped. Coordinates are passed through untouched, so
 * a source-local frame stays source-local - an LCC2 mesh needs the same
 * `createLcc2ToThreeMatrix` correction its splats get.
 *
 * @throws {Error} if the file is not a binary little-endian PLY, lacks a
 * usable vertex or face element, or is truncated.
 */
export function parseMeshPly(buffer: ArrayBuffer): TriangleMeshData {
  const header = parsePlyHeader(buffer);

  const vertices = header.element('vertex');
  if (!vertices) throw new Error('Not a mesh PLY: no "vertex" element.');
  assertPlyPropertyTypes(vertices, ['x', 'y', 'z'], ['float', 'float32'], 'Mesh PLY vertex');
  assertPlyElementFits(vertices, buffer.byteLength);
  const positions = readPositions(buffer, vertices);

  const faces = header.element('face');
  if (!faces) throw new Error('Not a mesh PLY: no "face" element.');
  const indices = readFaces(buffer, faces, vertices.count);

  return {
    vertexCount: vertices.count,
    triangleCount: indices.length / 3,
    positions,
    indices,
  };
}

/** Copies x/y/z out of the vertex records, honoring stride and offsets. */
function readPositions(buffer: ArrayBuffer, vertices: PlyElement): Float32Array {
  const view = new DataView(buffer, vertices.offset);
  const xOffset = plyPropertyOffset(vertices, 'x');
  const yOffset = plyPropertyOffset(vertices, 'y');
  const zOffset = plyPropertyOffset(vertices, 'z');
  const positions = new Float32Array(vertices.count * 3);
  for (let i = 0; i < vertices.count; i++) {
    const record = i * vertices.stride;
    positions[i * 3] = view.getFloat32(record + xOffset, true);
    positions[i * 3 + 1] = view.getFloat32(record + yOffset, true);
    positions[i * 3 + 2] = view.getFloat32(record + zOffset, true);
  }
  return positions;
}

/**
 * Walks the variable-stride face records into a flat triangle index array.
 *
 * Each record is a count followed by that many indices, so the records can only
 * be read in order - there is no arithmetic that finds face `n`.
 */
function readFaces(buffer: ArrayBuffer, faces: PlyElement, vertexCount: number): Uint32Array {
  if (faces.count === 0) return new Uint32Array(0);
  if (faces.offset < 0) {
    throw new Error(
      'Unsupported PLY layout: the "face" element follows a list property, so its position ' +
        'cannot be determined.',
    );
  }
  if (faces.properties.size > 0) {
    throw new Error(
      'Unsupported mesh PLY: the "face" element mixes scalar properties with its index list.',
    );
  }

  const name = FACE_INDEX_PROPERTIES.find((candidate) => faces.listProperties.has(candidate));
  const list = name ? faces.listProperties.get(name) : undefined;
  if (!list) {
    throw new Error(
      `Mesh PLY "face" element is missing an index list (${FACE_INDEX_PROPERTIES.join(' or ')}).`,
    );
  }
  const countSize = plyTypeSize(list.countType);
  const itemSize = plyTypeSize(list.itemType);

  const view = new DataView(buffer);
  const end = buffer.byteLength;
  // Most faces are triangles, so this is usually exact; a fan grows it.
  let indices = new Uint32Array(faces.count * 3);
  let written = 0;
  let cursor = faces.offset;

  for (let face = 0; face < faces.count; face++) {
    if (cursor + countSize > end) throw new Error(truncated(face));
    const count = readInteger(view, cursor, list.countType, countSize);
    if (count < 0) {
      throw new Error(`Mesh PLY face ${face} declares a negative vertex count (${count}).`);
    }
    cursor += countSize;
    if (cursor + count * itemSize > end) throw new Error(truncated(face));

    // A fan needs (count - 2) triangles; skip degenerate faces but still step
    // the cursor past their data so the following records stay aligned.
    const triangles = Math.max(0, count - 2);
    if (written + triangles * 3 > indices.length) {
      const grown = new Uint32Array(Math.max(indices.length * 2, written + triangles * 3));
      grown.set(indices.subarray(0, written));
      indices = grown;
    }
    let first = 0;
    let previous = 0;
    for (let i = 0; i < count; i++) {
      const index = readInteger(view, cursor + i * itemSize, list.itemType, itemSize);
      if (index < 0 || index >= vertexCount) {
        throw new Error(
          `Mesh PLY face ${face} references vertex ${index}, but the file has ${vertexCount}.`,
        );
      }
      if (i === 0) first = index;
      else if (i >= 2) {
        indices[written++] = first;
        indices[written++] = previous;
        indices[written++] = index;
      }
      previous = index;
    }
    cursor += count * itemSize;
  }

  return written === indices.length ? indices : indices.slice(0, written);
}

function truncated(face: number): string {
  return `Truncated PLY file: the "face" element ends inside face ${face}.`;
}

/** Reads one little-endian integer of a PLY scalar type. */
function readInteger(view: DataView, offset: number, type: string, size: number): number {
  switch (type) {
    case 'char':
    case 'int8':
      return view.getInt8(offset);
    case 'uchar':
    case 'uint8':
      return view.getUint8(offset);
    case 'short':
    case 'int16':
      return view.getInt16(offset, true);
    case 'ushort':
    case 'uint16':
      return view.getUint16(offset, true);
    case 'int':
    case 'int32':
      return view.getInt32(offset, true);
    case 'uint':
    case 'uint32':
      return view.getUint32(offset, true);
    default:
      // Sized by plyTypeSize, so this is a float type where an index belongs.
      throw new Error(`Unsupported PLY index type: "${type}" (${size} bytes).`);
  }
}
