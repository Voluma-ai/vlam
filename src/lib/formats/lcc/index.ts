/**
 * `@voluma/vlam/formats/lcc` - XGRIDS LCC (`.lcc`, manifest v3–v5) / `.lcc2` builders, sidecars, and
 * collision-mesh helpers.
 *
 * Loading through {@link StreamedSplatMesh.load} does not require this import;
 * the library pulls the format in on demand. Use this subpath for direct
 * manifest inspection or collision-tile decoding.
 */
export {
  parseLccManifest,
  parseLccIndex,
  parseLccChunk,
  type LccManifest,
  type LccIndexCell,
  type LccChunkParams,
} from './parse-lcc';
export { buildLccScene, type LccSceneOptions } from './lcc';
export { buildLcc2Scene } from './lcc2';
export { createLcc2ToThreeMatrix, applyLcc2ToThreeTransform } from './lcc2-transform';
export { loadCollisionMeshTiles, type CollisionMeshTile } from './collision-mesh';
export { parseMeshPly, type TriangleMeshData } from './parse-mesh-ply';
export {
  parseCollisionLci,
  type CollisionLciFile,
  type CollisionLciTile,
} from './parse-collision-lci';
export { partitionTriangleMesh, type TriangleMeshPartition } from './collision-partition';
