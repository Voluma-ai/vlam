import type { SplatData } from './splat-data';
import { ChunkLoader } from './chunk-loader';
import type { SplatFormat, SplatDataFileLoadOptions, SplatInputOptions } from './loading';

export type { SplatDataFileLoadOptions };

/** Options for {@link loadSplatData}. */
export interface SplatDataLoadOptions extends SplatInputOptions {
  /** Parser selection; URL extension detection is used only for `auto`. */
  format?: SplatFormat;
}

/**
 * Fetches and decodes a splat scene (`.sog`, `.ply`, `.spz`, `.splat` or
 * `.ksplat`) in a Web Worker, so
 * even multi-million-splat decodes never block the main thread. The
 * decoded arrays are transferred back, not copied.
 *
 * Whole-file convenience over {@link ChunkLoader}; use `ChunkLoader`
 * directly when loading many chunks or when cancellation is needed.
 *
 * @param input - Capture URL; its extension selects the parser unless an
 * explicit `format` option is provided.
 * @returns The decoded splat data, ready for {@link SplatMesh}.
 * @throws Rejects only with `SplatLoadError` (resolve, fetch or decode
 * failures - `error.phase` says which) or a `DOMException` named `AbortError`
 * when `options.signal` fires.
 *
 * @example
 * import { SplatMesh } from '@voluma/vlam';
 * import { loadSplatData } from '@voluma/vlam/loaders';
 * const splats = new SplatMesh(await loadSplatData('/scene.sog'));
 */
export async function loadSplatData(
  input: string | URL,
  options: SplatDataLoadOptions = {},
): Promise<SplatData> {
  const loader = new ChunkLoader();
  try {
    return await loader.load(input instanceof URL ? input.href : input, options);
  } finally {
    loader.dispose();
  }
}

/**
 * Decodes a local splat file - from a `<input type="file">` or a drag-and-drop
 * - in a Web Worker, without uploading it anywhere. The file's bytes are read
 * worker-side and the decoded arrays are transferred back, not copied.
 *
 * Only self-contained files are supported: `.ply`, `.spz`, `.splat`, `.ksplat`
 * and bundled `.sog`. An unbundled SOG directory needs sibling fetches, so it
 * must be served over HTTP and loaded with {@link loadSplatData}.
 *
 * @param file - The file; its name selects the parser unless an explicit
 * `format` option is provided.
 * @returns The decoded splat data, ready for {@link SplatMesh}.
 * @throws Rejects only with `SplatLoadError` (unknown extension, read or
 * decode failures) or a `DOMException` named `AbortError` when
 * `options.signal` fires.
 *
 * @example
 * import { SplatMesh } from '@voluma/vlam';
 * import { loadSplatDataFile } from '@voluma/vlam/loaders';
 * const splats = new SplatMesh(await loadSplatDataFile(event.dataTransfer.files[0]));
 */
export async function loadSplatDataFile(
  file: File,
  options: SplatDataFileLoadOptions = {},
): Promise<SplatData> {
  const loader = new ChunkLoader();
  try {
    return await loader.loadFile(file, options);
  } finally {
    loader.dispose();
  }
}
