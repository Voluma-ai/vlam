/**
 * {@link loadSplatClip}: the format-neutral way to load a 4D splat clip. It
 * picks the format from the `format` option, else from the URL, and hands
 * the load to that format's loader. A format vlam learns later is one more
 * entry in `SPLAT_CLIP_FORMATS` (`splat-clip.ts`) and one more branch here; the app's
 * call and the {@link SplatClip} it gets back stay the same.
 */
import { loadAsogClip } from './load-asog-clip';
import { isCsgsSceneFile, loadCsgsClip } from './csgs-clip';
import type { SplatClip, SplatClipFormat, SplatClipLoadOptions } from './splat-clip';

/**
 * Options of {@link loadSplatClip}.
 *
 * @experimental
 */
export interface LoadSplatClipOptions extends SplatClipLoadOptions {
  /**
   * `'auto'` (default) picks the format from the URL: an `.asog` is an
   * Animated SOG clip, and a `.json` is read and accepted when it is a
   * Faltwerk scene file. Name the format for a URL that does not say what it
   * is (an API endpoint, a blob URL).
   */
  format?: 'auto' | SplatClipFormat;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The clip load was aborted.', 'AbortError');
}

function unsupported(href: string, why: string): Error {
  return new Error(
    `${href}: ${why}. Supported 4D splat clips: Animated SOG .asog (or pass format: 'asog'), ` +
      `and Faltwerk .csgs, given by its scene_*.json (or pass format: 'csgs').`,
  );
}

/**
 * Loads a 4D (time-varying) splat clip in any format vlam reads, ready to
 * play through a `SplatClipMesh`. The format comes from `options.format`, or
 * else from the URL (see {@link LoadSplatClipOptions.format}).
 *
 * @example
 * ```ts
 * import { loadSplatClip, SplatClipMesh } from '@voluma/vlam/dynamic';
 *
 * const clip = await loadSplatClip(url, {
 *   onProgress: ({ message }) => (status.textContent = message),
 * });
 * const mesh = new SplatClipMesh(clip, { renderer });
 * ```
 *
 * @throws {Error} when the URL is not a clip format vlam reads.
 * @experimental The API may change in a minor release.
 */
export async function loadSplatClip(
  url: URL | string,
  options: LoadSplatClipOptions = {},
): Promise<SplatClip> {
  const { format = 'auto', ...loadOptions } = options;
  const { signal } = loadOptions;
  signal?.throwIfAborted();
  if (format === 'csgs') return loadCsgsClip(url, loadOptions);
  if (format === 'asog') return loadAsogClip(url, loadOptions);

  const resolved = new URL(url, globalThis.location?.href);
  const extension = resolved.pathname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  if (extension === '.asog') return loadAsogClip(resolved, loadOptions);
  if (extension === '.csgs') {
    throw unsupported(resolved.href, 'a single .csgs section has no frame rate or neighbours');
  }
  if (extension !== '.json') throw unsupported(resolved.href, 'not a recognised clip URL');
  const response = await fetch(resolved, signal ? { signal } : {});
  if (!response.ok) throw new Error(`${resolved.href}: HTTP ${response.status}`);
  const json: unknown = await response.json();
  if (signal?.aborted) throw abortError(signal);
  if (isCsgsSceneFile(json)) return loadCsgsClip(resolved, { ...loadOptions, scene: json });
  throw unsupported(resolved.href, 'this JSON file is not a clip description vlam knows');
}
