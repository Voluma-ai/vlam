import { SplatMesh } from '@voluma/vlam';
import { loadSplatData } from '@voluma/vlam/loaders';

export async function loadRenderOnlyScene(url: string): Promise<SplatMesh> {
  const data = await loadSplatData(url);
  return new SplatMesh(data, { storageMode: 'render-only' });
}
