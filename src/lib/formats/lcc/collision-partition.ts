import type { TriangleMeshData } from './parse-mesh-ply';
import type { SelectionVolume } from '../../selection/selection-volume';

/**
 * Splits a collision triangle mesh by the same {@link SelectionVolume} used to
 * separate a splat region, so the separated object keeps its collision
 * geometry and both halves stay usable by a host's collision system.
 *
 * Collision tiles arrive in the dataset's source-local frame (see
 * `parse-mesh-ply.ts`), which for `.lcc2` is the frame the mesh matrix maps to
 * world - the same frame `SplatData.positions` use. So a volume built for the
 * splats partitions the collision mesh with no extra transform, as long as the
 * host holds both in that one frame.
 */
export interface TriangleMeshPartition {
  /** Triangles assigned to the selection. */
  readonly inside: TriangleMeshData;
  /** Everything else. */
  readonly outside: TriangleMeshData;
}

/**
 * Partitions a triangle mesh by a selection volume.
 *
 * A triangle goes to `inside` when **any** of its vertices is inside the
 * volume. Triangles are never clipped, so the two halves tile the original
 * exactly (no cracks, no new geometry); the trade-off is that boundary
 * triangles overhang the volume by up to one triangle. Vertex winding is
 * preserved. Vertex buffers are compacted per half - shared vertices are
 * duplicated into whichever halves reference them.
 *
 * @throws {Error} if `mesh` is internally inconsistent (array lengths that
 * disagree with the declared counts, or an out-of-range index). {@link parseMeshPly}
 * already guarantees this; a host-built mesh is checked here rather than
 * silently producing `NaN` positions.
 */
export function partitionTriangleMesh(
  mesh: TriangleMeshData,
  volume: SelectionVolume,
): TriangleMeshPartition {
  assertConsistent(mesh);
  const { positions, indices, vertexCount, triangleCount } = mesh;

  const vertexInside = new Uint8Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    vertexInside[v] = volume.containsPoint(
      positions[v * 3] as number,
      positions[v * 3 + 1] as number,
      positions[v * 3 + 2] as number,
    )
      ? 1
      : 0;
  }

  const triangleInside = new Uint8Array(triangleCount);
  let insideTriangles = 0;
  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3] as number;
    const b = indices[t * 3 + 1] as number;
    const c = indices[t * 3 + 2] as number;
    if (vertexInside[a] === 1 || vertexInside[b] === 1 || vertexInside[c] === 1) {
      triangleInside[t] = 1;
      insideTriangles++;
    }
  }

  return {
    inside: gatherTriangles(mesh, triangleInside, 1, insideTriangles),
    outside: gatherTriangles(mesh, triangleInside, 0, triangleCount - insideTriangles),
  };
}

/** Rejects a mesh whose arrays disagree with its declared counts. */
function assertConsistent(mesh: TriangleMeshData): void {
  if (mesh.positions.length < mesh.vertexCount * 3) {
    throw new Error(
      `partitionTriangleMesh: positions hold ${mesh.positions.length} floats, ` +
        `too few for ${mesh.vertexCount} vertices.`,
    );
  }
  if (mesh.indices.length < mesh.triangleCount * 3) {
    throw new Error(
      `partitionTriangleMesh: indices hold ${mesh.indices.length} entries, ` +
        `too few for ${mesh.triangleCount} triangles.`,
    );
  }
  for (let k = 0; k < mesh.triangleCount * 3; k++) {
    const index = mesh.indices[k] as number;
    if (index >= mesh.vertexCount) {
      throw new Error(
        `partitionTriangleMesh: index ${index} is out of range (${mesh.vertexCount} vertices).`,
      );
    }
  }
}

/** Compacts the triangles whose flag matches `side` into a fresh mesh. */
function gatherTriangles(
  mesh: TriangleMeshData,
  triangleFlags: Uint8Array,
  side: 0 | 1,
  triangleCount: number,
): TriangleMeshData {
  const remap = new Int32Array(mesh.vertexCount).fill(-1);
  const indices = new Uint32Array(triangleCount * 3);
  // First pass: remap indices while counting the referenced vertices.
  let vertexCount = 0;
  let written = 0;
  for (let t = 0; t < mesh.triangleCount; t++) {
    if (triangleFlags[t] !== side) continue;
    for (let k = 0; k < 3; k++) {
      const old = mesh.indices[t * 3 + k] as number;
      let mapped = remap[old] as number;
      if (mapped < 0) {
        mapped = vertexCount++;
        remap[old] = mapped;
      }
      indices[written++] = mapped;
    }
  }
  const positions = new Float32Array(vertexCount * 3);
  for (let old = 0; old < mesh.vertexCount; old++) {
    const mapped = remap[old] as number;
    if (mapped < 0) continue;
    positions[mapped * 3] = mesh.positions[old * 3] as number;
    positions[mapped * 3 + 1] = mesh.positions[old * 3 + 1] as number;
    positions[mapped * 3 + 2] = mesh.positions[old * 3 + 2] as number;
  }
  return { vertexCount, triangleCount, positions, indices };
}
