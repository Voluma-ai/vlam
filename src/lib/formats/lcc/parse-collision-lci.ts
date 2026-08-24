import * as THREE from 'three/webgpu';
import type { TriangleMeshData } from './parse-mesh-ply';

/**
 * Parser for XGRIDS classic-LCC `collision.lci` files (manifest companions to
 * `.lcc` / `meta.lcc` captures).
 *
 * Layout reverse-engineered from the
 * [LCC whitepaper](https://github.com/xgrids/LCCWhitepaper) and verified on
 * live captures (e.g. Kaiserpfalz v2). The file packs one triangle mesh per
 * occupied cell, plus a proprietary serialized BVH we deliberately skip -
 * hosts build their own acceleration structure (see the demo's
 * `collision.ts`), the same bargain `.lcc2` makes by ignoring `.btree`.
 *
 * Coordinates are Z-up source-local, matching `data.bin` / `formatTransform`.
 */

const MAGIC = 0x6c6c6f63; // 'coll' LE
const SUPPORTED_VERSION = 2;
const GLOBAL_HEADER_BYTES = 48;
const MESH_HEADER_BYTES = 40;
const FLOATS_PER_VERTEX = 3;
const INDICES_PER_FACE = 3;
const BYTES_PER_VERTEX = FLOATS_PER_VERTEX * 4;
const BYTES_PER_FACE = INDICES_PER_FACE * 4;

/** One cell's collision mesh decoded from a `collision.lci`. */
export interface CollisionLciTile {
  readonly cellX: number;
  readonly cellY: number;
  readonly data: TriangleMeshData;
  /**
   * Cell-grid AABB in the file's source-local frame, clamped to the file's
   * scene bounds. Useful for culling before consulting the triangles.
   */
  readonly bounds: THREE.Box3;
}

/** Everything {@link parseCollisionLci} extracts from one file. */
export interface CollisionLciFile {
  readonly version: number;
  readonly bounds: THREE.Box3;
  readonly cellLengthX: number;
  readonly cellLengthY: number;
  readonly tiles: readonly CollisionLciTile[];
}

/**
 * Parses a classic-LCC `collision.lci` buffer into per-cell triangle meshes.
 *
 * @throws {Error} on bad magic, unsupported version, truncated payloads,
 * inconsistent size fields, or out-of-range face indices.
 */
export function parseCollisionLci(buffer: ArrayBuffer): CollisionLciFile {
  if (buffer.byteLength < GLOBAL_HEADER_BYTES) {
    throw new Error(
      `collision.lci is truncated: ${buffer.byteLength} bytes, need at least ${GLOBAL_HEADER_BYTES}.`,
    );
  }
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(
      `Not a collision.lci: expected magic "coll", got 0x${magic.toString(16).padStart(8, '0')}.`,
    );
  }
  const version = view.getUint32(4, true);
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported collision.lci version ${version} (expected ${SUPPORTED_VERSION}).`,
    );
  }
  const headerLen = view.getUint32(8, true);
  const sceneMin = new THREE.Vector3(
    view.getFloat32(12, true),
    view.getFloat32(16, true),
    view.getFloat32(20, true),
  );
  const sceneMax = new THREE.Vector3(
    view.getFloat32(24, true),
    view.getFloat32(28, true),
    view.getFloat32(32, true),
  );
  const cellLengthX = view.getFloat32(36, true);
  const cellLengthY = view.getFloat32(40, true);
  const meshCount = view.getUint32(44, true);

  const expectedHeader = GLOBAL_HEADER_BYTES + meshCount * MESH_HEADER_BYTES;
  if (headerLen !== expectedHeader) {
    throw new Error(
      `collision.lci headerLen ${headerLen} does not match ${meshCount} mesh headers ` +
        `(expected ${expectedHeader}).`,
    );
  }
  if (buffer.byteLength < headerLen) {
    throw new Error(
      `collision.lci is truncated: header claims ${headerLen} bytes, file has ${buffer.byteLength}.`,
    );
  }
  if (!(cellLengthX > 0) || !(cellLengthY > 0)) {
    throw new Error(
      `collision.lci cell lengths must be positive (got ${cellLengthX} × ${cellLengthY}).`,
    );
  }

  const sceneBounds = new THREE.Box3(sceneMin.clone(), sceneMax.clone());
  const tiles: CollisionLciTile[] = [];
  let expectedOffset = headerLen;

  for (let i = 0; i < meshCount; i++) {
    const at = GLOBAL_HEADER_BYTES + i * MESH_HEADER_BYTES;
    const cellX = view.getUint32(at, true);
    const cellY = view.getUint32(at + 4, true);
    const dataOffset = Number(view.getBigUint64(at + 8, true));
    const dataSize = Number(view.getBigUint64(at + 16, true));
    const vertexCount = view.getUint32(at + 24, true);
    const faceCount = view.getUint32(at + 28, true);
    const bvhByteSize = view.getUint32(at + 32, true);

    if (!Number.isSafeInteger(dataOffset) || !Number.isSafeInteger(dataSize)) {
      throw new Error(`collision.lci mesh ${i} has an unsafe data offset/size.`);
    }
    if (dataOffset !== expectedOffset) {
      throw new Error(
        `collision.lci mesh ${i} data offset ${dataOffset} is not contiguous ` +
          `(expected ${expectedOffset}).`,
      );
    }
    const geometryBytes = vertexCount * BYTES_PER_VERTEX + faceCount * BYTES_PER_FACE;
    if (geometryBytes + bvhByteSize !== dataSize) {
      throw new Error(
        `collision.lci mesh ${i} size ${dataSize} != ` +
          `${vertexCount}*12 + ${faceCount}*12 + BVH ${bvhByteSize}.`,
      );
    }
    const end = dataOffset + dataSize;
    if (end > buffer.byteLength) {
      throw new Error(
        `collision.lci mesh ${i} extends to byte ${end}, past file length ${buffer.byteLength}.`,
      );
    }

    const positions = new Float32Array(buffer, dataOffset, vertexCount * FLOATS_PER_VERTEX);
    const indexOffset = dataOffset + vertexCount * BYTES_PER_VERTEX;
    const indices = new Uint32Array(buffer, indexOffset, faceCount * INDICES_PER_FACE);
    for (let t = 0; t < indices.length; t++) {
      const index = indices[t]!;
      if (index >= vertexCount) {
        throw new Error(
          `collision.lci mesh ${i} face index ${index} is out of range ` +
            `(vertexCount ${vertexCount}).`,
        );
      }
    }

    tiles.push({
      cellX,
      cellY,
      data: {
        vertexCount,
        triangleCount: faceCount,
        // Copy so the returned arrays outlive a transferred/detached buffer
        // and are not views into the BVH-adjacent region.
        positions: positions.slice(),
        indices: indices.slice(),
      },
      bounds: cellBounds(cellX, cellY, cellLengthX, cellLengthY, sceneBounds),
    });
    expectedOffset = end;
  }

  if (expectedOffset !== buffer.byteLength) {
    throw new Error(
      `collision.lci has ${buffer.byteLength - expectedOffset} trailing bytes after the last mesh.`,
    );
  }

  return {
    version,
    bounds: sceneBounds,
    cellLengthX,
    cellLengthY,
    tiles,
  };
}

/**
 * Cell AABB on the LCI grid, anchored at the scene minimum and clamped to the
 * scene box - same rule classic LCC uses for splat cells.
 */
function cellBounds(
  cellX: number,
  cellY: number,
  cellLengthX: number,
  cellLengthY: number,
  scene: THREE.Box3,
): THREE.Box3 {
  const x0 = scene.min.x + cellX * cellLengthX;
  const y0 = scene.min.y + cellY * cellLengthY;
  return new THREE.Box3(
    new THREE.Vector3(Math.min(x0, scene.max.x), Math.min(y0, scene.max.y), scene.min.z),
    new THREE.Vector3(
      Math.min(x0 + cellLengthX, scene.max.x),
      Math.min(y0 + cellLengthY, scene.max.y),
      scene.max.z,
    ),
  );
}
