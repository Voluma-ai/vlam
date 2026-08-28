// Guide sample: docs/guide/getting-started.md - loading a local file.
import { SplatMesh } from '@voluma/vlam';
import { loadSplatDataFile } from '@voluma/vlam/loaders';

export async function onFilePicked(file: File): Promise<SplatMesh> {
  // Decoded in a Web Worker; the bytes never leave the device.
  const data = await loadSplatDataFile(file, {
    onProgress: (loaded, total) => console.log(`read ${loaded} / ${total} bytes`),
  });
  return new SplatMesh(data);
}
