import { PLY_TEMP_DIRECTORY } from './ply-temp-constants';

/** Host-side cleanup after terminating the load worker. */
export async function cleanupPlyTemporary(id: string): Promise<void> {
  if (!navigator.storage?.getDirectory || !navigator.locks?.request) return;
  await navigator.locks.request(`vlam-ply-${id}`, { mode: 'exclusive' }, async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(PLY_TEMP_DIRECTORY).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    });
    if (!dir) return;
    await dir.removeEntry(id).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    });
  });
}

/** Reclaim only orphaned files in this experiment's dedicated namespace. */
export async function recoverPlyTemporaryOrphans(): Promise<void> {
  if (!navigator.storage?.getDirectory || !navigator.locks?.request) return;
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(PLY_TEMP_DIRECTORY).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null;
    throw error;
  });
  if (!dir) return;
  for await (const [id, handle] of dir as FileSystemDirectoryHandle &
    AsyncIterable<[string, FileSystemHandle]>) {
    if (handle.kind !== 'file' || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) continue;
    await navigator.locks.request(
      `vlam-ply-${id}`,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (lock) await dir.removeEntry(id).catch(() => undefined);
      },
    );
  }
}
