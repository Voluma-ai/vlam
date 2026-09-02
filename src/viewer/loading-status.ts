/**
 * Copy for the demo's loading overlay and status pill.
 *
 * The loader already reports bytes via `onProgress`; this module turns that
 * into a determinate percent (when the size is known) rather than a spinner.
 */

export interface LoadingBytes {
  loaded: number;
  /** 0 when the response has no Content-Length - spinner, not 0%. */
  total: number;
}

export interface LoadingPill {
  text: string;
  /** 0..1 for the bar; null hides it (size unknown). */
  fraction: number | null;
}

/** Bytes as "1.2 GB" / "540 MB" / "12 KB" for a progress line. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${Math.max(0, Math.round(bytes))} B`;
}

/**
 * Download percent, or null when the size is unknown.
 *
 * Stays at 99 until the last byte so a rounded 100% cannot land while the
 * body is still arriving; 100 means the fetch is done and decode may follow.
 */
export function loadingPercent(progress: LoadingBytes | null): number | null {
  const total = progress?.total ?? 0;
  if (!progress || total <= 0) return null;
  if (progress.loaded >= total) return 100;
  return Math.min(99, Math.floor((progress.loaded / total) * 100));
}

/** Bottom-left overlay while a scene is still fetching or decoding. */
export function loadingOverlayText(title: string, progress: LoadingBytes | null): string {
  const percent = loadingPercent(progress);
  if (percent === null) {
    if (progress && progress.loaded > 0) return `Loading ${title}… ${formatBytes(progress.loaded)}`;
    return `Loading ${title}…`;
  }
  if (percent >= 100) return `Decoding ${title}…`;
  return `Loading ${title}… ${percent}%`;
}

/** Top-right status pill: percent + bytes, or a spinner line. */
export function loadingPill(progress: LoadingBytes | null): LoadingPill {
  const percent = loadingPercent(progress);
  if (percent === null || !progress) {
    if (progress && progress.loaded > 0) {
      return { text: `Reading ${formatBytes(progress.loaded)}…`, fraction: null };
    }
    return { text: 'Loading…', fraction: null };
  }
  if (percent >= 100) return { text: 'Decoding…', fraction: 1 };
  return {
    text: `${percent}% · ${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`,
    fraction: percent / 100,
  };
}
