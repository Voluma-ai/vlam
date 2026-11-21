/**
 * The public {@link loadAsogClip}: a thin entry that imports the `.asog`
 * loader (`asog-clip.ts`, with its inlined decode worker and GPU driver) on
 * first use, so an app that never opens an `.asog` clip does not download
 * it with `@voluma/vlam/dynamic`.
 */
import type { AsogClip, LoadAsogClipOptions } from './asog-clip';

/**
 * Loads an `.asog` clip: fetches the file (unless `options.bytes` is given)
 * and decodes it in the clip's own worker, which keeps it for playback.
 * Play the result with a `SplatClipMesh`; {@link AsogClip.dispose}
 * terminates the worker.
 *
 * The download goes to the worker as it arrives, and each stream of the file
 * is decoded as soon as its bytes are there, so most of the decode (about
 * 0.6 s of work for 400k splats on a desktop) overlaps the download. The clip
 * resolves once the whole file is decoded. Progress reports bytes fetched
 * (`stage: 'fetch'`) and streams decoded (`stage: 'decode'`). Only format
 * version 1 is supported.
 * The loader itself is a separate chunk, fetched on the first call.
 *
 * @example
 * ```ts
 * import { loadAsogClip, SplatClipMesh } from '@voluma/vlam/dynamic';
 *
 * const clip = await loadAsogClip('https://example.com/clip.asog');
 * const mesh = new SplatClipMesh(clip, { renderer });
 * mesh.rotation.x = Math.PI; // .asog is y down
 * ```
 *
 * @experimental The API may change in a minor release.
 */
export async function loadAsogClip(
  url: URL | string,
  options: LoadAsogClipOptions = {},
): Promise<AsogClip> {
  options.signal?.throwIfAborted();
  const { loadAsogClip: load } = await import('./asog-clip');
  return load(url, options);
}
