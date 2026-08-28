// Guide sample: docs/guide/streaming-and-lod.md - stream a dropped folder,
// hand collision meshes to the application, toggle the environment tile.
import { StreamedSplatMesh } from '@voluma/vlam/streaming';

export async function openDroppedFolder(files: ReadonlyMap<string, File>) {
  // `files` maps relative paths ("lod-meta.json", "chunks/0.webp", …) to File
  // objects, e.g. collected from a drag-and-drop directory traversal. Files
  // are read in place through blob: URLs - ranged reads, no upload.
  const splats = await StreamedSplatMesh.loadLocal(files);

  // .lcc / .lcc2 captures may ship collision geometry as plain triangles; VLAM!
  // builds no BVH and runs no physics - that is the application's job. Resolves []
  // for scenes without collision geometry.
  const collision = await splats.loadCollisionMeshes();
  console.log(`${collision.length} collision tiles`);

  // The always-resident environment/sky tile (outside the LOD budget) can be
  // toggled live; a no-op for scenes that ship none.
  splats.setEnvironmentEnabled(false);
  return splats;
}
