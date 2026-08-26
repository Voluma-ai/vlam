/**
 * Viewer UI chrome presets for the docs site.
 *
 * Not part of `@voluma/vlam` - docs/viewer only. `embed` is the home-page
 * iframe (goose + drag/drop hint). `full` is `/demo/` with all overlays.
 */

export type ViewerPreset = 'full' | 'embed';

/** How much of the welcome panel to show. */
export type WelcomeMode = 'full' | 'drop-hint' | 'none';

export interface ViewerChrome {
  /** Welcome panel mode. */
  welcome: WelcomeMode;
  /**
   * Site navigation: the top-right Voluma logo and hamburger menu, plus the
   * top-left home logo. Off for `embed`, which must not link out of the page
   * hosting the iframe.
   */
  topLinks: boolean;
  /** Loading / streaming status pill. */
  status: boolean;
  /** Bottom-left overlay text (scene name, splat counts, backend). */
  overlay: boolean;
  /** Effect picker in the bottom chrome. */
  effects: boolean;
  /** Frame rate in the bottom-left overlay (was the stats.js panel). */
  stats: boolean;
  /** Performance-mode toggle button. */
  perfMode: boolean;
  /** Copy-view URL button. */
  copyView: boolean;
  /** Start with the cinematic orbital-camera path active. */
  cinematicOrbit: boolean;
  /** Show the cinematic orbital-camera play/pause button. */
  cinematicOrbitToggle: boolean;
  /** Enter-VR button (still honors `?xr=0`). */
  enterVr: boolean;
  /** Collision mesh toggle UI. */
  collisionUi: boolean;
  /** Full-window drag-and-drop loading. */
  dropZone: boolean;
  /** Separation tool chrome (always on in `full`; `?tool=select` / `?separate` deep-link it). */
  separate: boolean;
  /** Perf HUD when `?hud=1` is set. */
  perfHud: boolean;
}

const FULL: ViewerChrome = {
  welcome: 'full',
  topLinks: true,
  status: true,
  overlay: true,
  effects: true,
  stats: true,
  perfMode: true,
  copyView: true,
  cinematicOrbit: false,
  cinematicOrbitToggle: true,
  enterVr: true,
  collisionUi: true,
  dropZone: true,
  separate: true,
  perfHud: true,
};

const EMBED: ViewerChrome = {
  welcome: 'drop-hint',
  topLinks: false,
  status: true,
  overlay: true,
  effects: false,
  stats: false,
  perfMode: false,
  copyView: false,
  cinematicOrbit: true,
  cinematicOrbitToggle: false,
  enterVr: false,
  collisionUi: false,
  dropZone: true,
  separate: false,
  perfHud: false,
};

const PRESETS: Record<ViewerPreset, ViewerChrome> = {
  full: FULL,
  embed: EMBED,
};

/** Resolve preset from `?preset=embed|full` (default `full`). */
export function resolveViewerPreset(params: URLSearchParams): ViewerPreset {
  return params.get('preset') === 'embed' ? 'embed' : 'full';
}

/**
 * Docs "Open demo" expands the file pickers (`?welcome=1`). Other `?scene=`
 * links keep the collapsed drop-hint.
 */
export function parseWelcomeExpandedParam(value: string | null): boolean {
  return value === '1' || value === 'true' || value === 'on';
}

/**
 * Opt-in goose fallback when the CTA scene fails (`?fallback=goose`).
 * A constructed `?scene=` without this flag still surfaces the error.
 */
export function parseGooseFallbackParam(value: string | null): boolean {
  return value === 'goose';
}

/** Chrome flags for a preset. */
export function viewerChromeForPreset(preset: ViewerPreset): ViewerChrome {
  return PRESETS[preset];
}

/**
 * Apply static DOM visibility for chrome that lives in the HTML shell
 * (welcome, top links, bottom chrome). Call once after resolving the preset.
 */
export function applyStaticChrome(chrome: ViewerChrome): void {
  const welcome = document.querySelector<HTMLElement>('#welcome-hint');
  if (welcome) {
    if (chrome.welcome === 'none') {
      welcome.hidden = true;
      welcome.classList.remove('visible');
    } else if (chrome.welcome === 'drop-hint') {
      welcome.classList.add('drop-hint-only');
    }
  }

  if (!chrome.topLinks) {
    document.querySelector('#site-home')?.remove();

    const topLinks = document.querySelector<HTMLElement>('#top-links');
    if (topLinks) {
      // Keep #status (loading pill) when status chrome is on; strip everything
      // else - the menu is a <button>, so removing anchors alone leaves it.
      if (chrome.status) {
        for (const link of topLinks.querySelectorAll('a')) link.remove();
        topLinks.querySelector('#site-menu')?.remove();
      } else {
        topLinks.hidden = true;
      }
    }
  }

  const bottom = document.querySelector<HTMLElement>('#bottom-chrome');
  if (bottom && !chrome.overlay && !chrome.effects && !chrome.separate) {
    bottom.hidden = true;
  }

  const overlay = document.querySelector<HTMLElement>('#overlay');
  if (overlay && !chrome.overlay) {
    overlay.hidden = true;
  }
}
