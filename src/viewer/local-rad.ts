import type { EventDispatcher } from 'three';
import type { SplatMesh } from '../lib/core';
import { StreamedSplatMesh, type StreamedSplatMeshOptions } from '../lib/streaming';

/** The viewer owns URLs it creates for local RAD files until the mesh is disposed. */
export async function loadLocalRad(
  file: File,
  options: StreamedSplatMeshOptions,
): Promise<StreamedSplatMesh> {
  const url = URL.createObjectURL(file);
  try {
    const mesh = await StreamedSplatMesh.load(url, { ...options, format: 'rad' });
    // Three dispatches Mesh.dispose at runtime; its Object3D event map omits it.
    const events = mesh as unknown as EventDispatcher<{ dispose: Record<string, never> }>;
    const release = () => {
      events.removeEventListener('dispose', release);
      URL.revokeObjectURL(url);
    };
    events.addEventListener('dispose', release);
    return mesh;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** Dispose a failed scene candidate unless the viewer has fully adopted it. */
export async function applyOwnedScene(
  mesh: SplatMesh,
  mount: () => Promise<void>,
  isMounted: () => boolean,
): Promise<void> {
  try {
    await mount();
  } catch (error) {
    if (!isMounted()) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    throw error;
  }
}
