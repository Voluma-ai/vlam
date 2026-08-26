import type { ViewerTool } from './tool-picker';

/** Camera pose plus demo chrome a copy-view link can restore. */
export interface ShareViewState {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly target: { readonly x: number; readonly y: number; readonly z: number };
  readonly tool: ViewerTool;
  readonly effect: string | null;
  /** First-person walk (G / Mode: walk). Written only when armed. */
  readonly fpv: boolean;
  /** Cinematic orbit playing. `orbit=0` is written when paused so a share keeps the pose. */
  readonly orbitPlaying: boolean;
}

/** Serializes a camera vector for `?cameraPosition=` / `?cameraTarget=`. */
export function formatShareVector3(value: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): string {
  const fmt = (n: number): string => String(Number(n.toFixed(6)));
  return `${fmt(value.x)},${fmt(value.y)},${fmt(value.z)}`;
}

/**
 * First-person walk from `?fpv=`. Bare `?fpv` and `1` / `true` / `on` enable it;
 * anything else is ignored.
 */
export function parseFpvParam(value: string | null): boolean {
  return value === '' || value === '1' || value === 'true' || value === 'on';
}

/**
 * Cinematic-orbit playing state from `?orbit=`.
 * `0` / `false` / `off` / `paused` → paused; `1` / `true` / `on` → playing;
 * missing or unknown → `null` (use the chrome / sticky default).
 */
export function parseOrbitPlayingParam(value: string | null): boolean | null {
  if (value === null) return null;
  if (value === '0' || value === 'false' || value === 'off' || value === 'paused') return false;
  if (value === '1' || value === 'true' || value === 'on') return true;
  return null;
}

/**
 * Writes camera pose and demo chrome onto a share URL.
 * Defaults stay off the query: no `tool` when none, no `fpv` when orbiting,
 * no `orbit` while the cinematic path is playing. Docs CTA flags (`welcome`,
 * `fallback`) are stripped so a copied link is a plain `?scene=` view.
 */
export function writeShareViewSearchParams(url: URL, state: ShareViewState): void {
  url.searchParams.set('cameraPosition', formatShareVector3(state.position));
  url.searchParams.set('cameraTarget', formatShareVector3(state.target));
  if (state.effect) url.searchParams.set('effects', state.effect);
  else url.searchParams.delete('effects');
  if (state.tool !== 'none') url.searchParams.set('tool', state.tool);
  else url.searchParams.delete('tool');
  url.searchParams.delete('separate');
  if (state.fpv) url.searchParams.set('fpv', '1');
  else url.searchParams.delete('fpv');
  if (!state.orbitPlaying) url.searchParams.set('orbit', '0');
  else url.searchParams.delete('orbit');
  url.searchParams.delete('welcome');
  url.searchParams.delete('fallback');
}
