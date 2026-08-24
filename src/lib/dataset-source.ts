import {
  SplatLoadError,
  toRequestInit,
  type SplatRequestOptions,
  type StreamedSplatFormat,
} from './loading';

/**
 * Where a streamed dataset's files come from.
 *
 * A streamed scene is never one file: it is a manifest plus sidecars and chunk
 * files that the manifest names *relatively* (`data.bin`, `data/3dgs/x.sog`,
 * `0_0/meta.json`). Over HTTP those resolve against the manifest's URL; from a
 * dropped folder there is no URL to resolve against, only `File` objects.
 *
 * This is the seam between the two. Everything downstream - including the
 * worker's ranged chunk reads - keeps working on plain URLs, because a
 * dropped file's `blob:` URL answers `Range` with a real 206 (verified on
 * Chromium/WebKit/Gecko), so only *name resolution* has to differ.
 */
export interface SplatDatasetSource {
  /** Fetchable URL of the manifest itself. */
  readonly manifestUrl: string;
  /** Fetchable URL for a dataset-relative path, or null when absent. */
  resolve(path: string): string | null;
  /** Byte length of a file, or null when absent. */
  size(path: string): Promise<number | null>;
  /**
   * The files inside a chunk *directory* (unbundled SOG), as
   * `name → fetchable URL`. Null when the chunk should be fetched by URL
   * instead - the HTTP case, where the directory is a real path.
   */
  directoryFiles(path: string): Record<string, string> | null;
  /** Releases any resources held for this dataset (e.g. blob URLs). */
  dispose(): void;
}

/** A dataset served over HTTP, resolved against the manifest's URL. */
export function httpDatasetSource(
  manifestUrl: string,
  request?: SplatRequestOptions,
): SplatDatasetSource {
  return {
    manifestUrl,
    resolve: (path) => new URL(path, manifestUrl).href,
    size: (path) => probeSize(new URL(path, manifestUrl).href, request),
    directoryFiles: () => null,
    dispose: () => {},
  };
}

/**
 * Determines a remote file's length without downloading it: `HEAD` first, and
 * a one-byte ranged `GET` for origins that disallow `HEAD` but do serve
 * ranges. A missing file is not an error - callers treat null as "absent".
 */
async function probeSize(url: string, request?: SplatRequestOptions): Promise<number | null> {
  try {
    const response = await fetch(url, { ...toRequestInit(request), method: 'HEAD' });
    await cancelBody(response);
    if (response.ok) {
      const length = response.headers.get('content-length');
      if (length !== null) return saneSize(Number(length));
    } else if (response.status === 404) {
      return null;
    }
  } catch {
    // Fall through to the ranged GET below.
  }
  try {
    const response = await fetch(url, {
      ...toRequestInit(request),
      headers: { ...(request?.headers ?? {}), Range: 'bytes=0-0' },
    });
    await cancelBody(response);
    // A plain 200 means the server ignored the Range header - the body would
    // have been the whole file, and Content-Range is absent; treat the size
    // as unknown rather than misreading a full response as a probe.
    if (response.status !== 206) return null;
    const total = response.headers.get('content-range')?.split('/')[1];
    return total === undefined || total === '*' ? null : saneSize(Number(total));
  } catch {
    return null;
  }
}

/** Discards a probe response's body so the connection is not left downloading. */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that cannot be cancelled (already consumed/locked) is fine.
  }
}

/** A probed size only counts if it is a non-negative safe integer. */
function saneSize(size: number): number | null {
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

/** A dataset picked out of a dropped folder. */
export interface LocalDataset {
  readonly source: SplatDatasetSource;
  /** The streamed format the folder's manifest identifies it as. */
  readonly format: Exclude<StreamedSplatFormat, 'auto'>;
  /** The manifest's file name, for display. */
  readonly name: string;
}

/** Manifest names that identify a streamed dataset, most specific first. */
const MANIFESTS: {
  test: (name: string) => boolean;
  format: Exclude<StreamedSplatFormat, 'auto'>;
}[] = [
  { test: (n) => n.endsWith('.lcc2'), format: 'lcc2' },
  { test: (n) => n.endsWith('.lcc'), format: 'lcc' },
  // The `.rad` header of a `--rad-chunked` set; `.radc` chunk files are not
  // manifests (they end in `.radc`, so `endsWith('.rad')` excludes them).
  { test: (n) => n.endsWith('.rad'), format: 'rad' },
  { test: (n) => n === 'lod-meta.json', format: 'streamed-sog' },
];

/**
 * Builds a dataset from a dropped folder's files, keyed by their paths
 * relative to the folder root.
 *
 * Every file gets a `blob:` URL, so the rest of the pipeline - including the
 * worker's ranged reads into a multi-hundred-megabyte `data.bin` - is
 * identical to the HTTP path. Nothing is copied or read here: a blob URL is a
 * handle to the file on disk, so a 300 MB `data.bin` costs nothing until a
 * chunk actually reads a range out of it.
 *
 * @throws {SplatLoadError} with `phase: 'manifest'` when the folder holds no
 * recognizable manifest, or more than one (which would make the choice
 * arbitrary). Neither is retryable: the same folder fails the same way.
 */
export function createLocalDataset(files: ReadonlyMap<string, File>): LocalDataset {
  const found: { path: string; format: Exclude<StreamedSplatFormat, 'auto'> }[] = [];
  for (const path of files.keys()) {
    const name = basename(path).toLowerCase();
    const match = MANIFESTS.find((candidate) => candidate.test(name));
    // Only a manifest at the top level counts: an `.lcc2` capture nests whole
    // datasets under `data/`, and picking one of those would load a fragment.
    if (match && depth(path) === minDepth(files, match)) found.push({ path, format: match.format });
  }
  if (found.length === 0) {
    throw new SplatLoadError(
      'That folder has no streamed-scene manifest in it (expected a .lcc, .lcc2 or lod-meta.json file).',
      { phase: 'manifest', url: 'local-folder', retryable: false },
    );
  }
  if (found.length > 1) {
    const names = found.map((entry) => basename(entry.path)).join(', ');
    throw new SplatLoadError(
      `That folder holds more than one scene manifest (${names}) - drop one scene at a time.`,
      { phase: 'manifest', url: 'local-folder', retryable: false },
    );
  }

  const manifest = found[0] as { path: string; format: Exclude<StreamedSplatFormat, 'auto'> };
  // Paths resolve relative to the manifest, exactly as they would over HTTP.
  const root = manifest.path.includes('/')
    ? manifest.path.slice(0, manifest.path.lastIndexOf('/') + 1)
    : '';
  const urls = new Map<string, string>();
  const urlFor = (path: string): string | null => {
    const existing = urls.get(path);
    if (existing !== undefined) return existing;
    const file = files.get(path);
    if (!file) return null;
    const url = URL.createObjectURL(file);
    urls.set(path, url);
    return url;
  };

  const source: SplatDatasetSource = {
    manifestUrl: urlFor(manifest.path) as string,
    resolve: (path) => urlFor(root + normalize(path)),
    size: (path) => Promise.resolve(files.get(root + normalize(path))?.size ?? null),
    directoryFiles: (path) => {
      // An unbundled SOG chunk is a folder of images the worker fetches by
      // name; hand it the whole folder rather than a URL to resolve against.
      const prefix = root + normalize(path).replace(/\/?$/, '/');
      const entries: Record<string, string> = {};
      for (const candidate of files.keys()) {
        if (!candidate.startsWith(prefix)) continue;
        const url = urlFor(candidate);
        if (url) entries[candidate.slice(prefix.length)] = url;
      }
      return Object.keys(entries).length > 0 ? entries : null;
    },
    dispose: () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
  return { source, format: manifest.format, name: basename(manifest.path) };
}

/** Strips the `./` and leading `/` a manifest path may carry. */
function normalize(path: string): string {
  return path.replace(/^\.?\//, '');
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function depth(path: string): number {
  return path.split('/').length - 1;
}

/** The shallowest depth any manifest of this kind sits at. */
function minDepth(
  files: ReadonlyMap<string, File>,
  match: { test: (name: string) => boolean },
): number {
  let shallowest = Infinity;
  for (const path of files.keys()) {
    if (match.test(basename(path).toLowerCase())) shallowest = Math.min(shallowest, depth(path));
  }
  return shallowest;
}
