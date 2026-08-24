/**
 * What the viewer accepts as a scene, in one place.
 *
 * The same extension set is needed in three spots - the drop zone's filter, the
 * `?scene=` streamed/static routing, and the welcome panel's URL box - and they
 * drifted apart when each kept its own list. Everything here derives from
 * {@link SINGLE_FILE_EXTENSIONS} and {@link STREAMED_EXTENSIONS}.
 */

import { splatNameExtension } from '../lib/loading';

/** Self-contained files a single drop (or a single URL) can load. */
export const SINGLE_FILE_EXTENSIONS = [
  '.sog',
  '.ply',
  '.spz',
  '.splat',
  '.ksplat',
  '.rad',
] as const;

/**
 * Scenes the `StreamedSplatMesh` loader handles from a URL. `.rad` is in both
 * lists: it is one file, and it streams.
 */
export const STREAMED_EXTENSIONS = ['.json', '.lcc2', '.lcc', '.rad'] as const;

/** Human-readable list for the drop overlay and rejection messages. */
export const SINGLE_FILE_LIST = SINGLE_FILE_EXTENSIONS.join(', ');

/** The path part of a scene name, whether it arrived as a URL or a bare path. */
function scenePathname(name: string): string {
  if (!name.includes('://')) return name;
  try {
    return new URL(name).pathname;
  } catch {
    return name;
  }
}

/** Whether a file name ends in an extension a single file/URL can load. */
export function isSupportedSplatFile(name: string): boolean {
  const extension = splatNameExtension(scenePathname(name));
  return (SINGLE_FILE_EXTENSIONS as readonly string[]).includes(extension);
}

/** Whether a scene name routes to the streamed loader rather than the static one. */
export function isStreamedScene(name: string): boolean {
  const extension = splatNameExtension(scenePathname(name));
  return (STREAMED_EXTENSIONS as readonly string[]).includes(extension);
}

/** Anything `?scene=` accepts: a self-contained file or a streamed manifest. */
export function isSupportedSceneUrl(name: string): boolean {
  return isSupportedSplatFile(name) || isStreamedScene(name);
}

/** A rejected URL, with the message to show under the input. */
export interface SceneUrlError {
  readonly error: string;
}

/**
 * Validates a pasted scene URL before it costs a page load.
 *
 * Deliberately strict about the scheme: only `http:`/`https:` can be fetched
 * cross-origin, and letting `javascript:` through would put a user-typed script
 * one navigation away.
 */
export function validateSceneUrl(raw: string): { url: string } | SceneUrlError {
  const trimmed = raw.trim();
  if (trimmed === '') return { error: 'Paste a link to a splat file first.' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: "That doesn't look like a URL - include https://" };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Only http:// and https:// links can be loaded.' };
  }
  if (!isSupportedSceneUrl(parsed.href)) {
    return {
      error: `That link is not a splat scene. Expected ${SINGLE_FILE_LIST}, .lcc, .lcc2 or a lod-meta.json.`,
    };
  }
  return { url: parsed.href };
}
