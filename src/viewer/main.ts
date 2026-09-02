import * as THREE from 'three/webgpu';
import { screenUV, texture as tslTexture } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import CameraControls from 'camera-controls';
import {
  ModifierSlots,
  SplatMesh,
  MergedSplatMesh,
  detectSplatDeviceProfile,
  isFillConstrainedSplatDevice,
  probeSplatGpuClass,
  recommendedMaxPixelRatio,
  recommendedXrFramebufferScale,
  suggestAdaptivePixelRatio,
  ADAPTIVE_PIXEL_RATIO_WARMUP_FRAMES,
  xrSessionInit,
  createSplatRenderer,
  yUpTransformForFormat,
  type SplatData,
  type SplatDeviceProfile,
  type SplatModifier,
  type SplatMeshOptions,
  type SplatOrientation,
  type SplatPerformanceProfile,
} from '../lib/core';
import { loadSplatData, loadSplatDataFile } from '../lib/loaders';
import {
  StreamedSplatMesh,
  type CollisionMeshTile,
  type StreamedSplatPerformanceEvent,
} from '../lib/streaming';
import { createDemoEffects } from './effects';
import {
  createPaintTool,
  createMaskHighlightModifier,
  getPaintBrushIndex,
  getPaintHighlightColorHex,
  setPaintHighlightColor,
  type PaintTool,
} from './paint';
import {
  createLodDistanceDebugModifier,
  createLodLevelDebugModifier,
  lodDebugLegendHtml,
} from './lod-debug';

import {
  sdfEffects,
  revealPreset,
  worldWarpPreset,
  createRelightingProxy,
  createRelightingShadowFactorMaterial,
  type SdfShape,
  type WorldWarpPreset,
  type RelightingProxy,
} from '../lib/effects';
import { showError, hideError, isErrorVisible, describeLoadError } from './failure';
import { createDropZone, filesFromDirectoryInput } from './drop-zone';
import {
  SINGLE_FILE_EXTENSIONS,
  SINGLE_FILE_LIST,
  isStreamedScene,
  isSupportedSplatFile,
  validateSceneUrl,
} from './scene-url';
import { createCollisionWorld, type CollisionWorld } from './collision';
import { createFrameBenchmark, verifyGpuSort } from './sort-benchmark';
import { createPerfHud, hudBrowserName } from './perf-hud';
import { createSeparateTool, type SeparateTool } from './separate';
import { buildToolPicker, parseViewerTool, type ViewerTool } from './tool-picker';
import { parseFpvParam, parseOrbitPlayingParam, writeShareViewSearchParams } from './share-view';
import {
  alignXrRigToCamera,
  applyPresentationSplatBudget,
  attachXrSession,
  captureXrCameraState,
  pageSplatBudgetForMesh,
  restoreXrCameraState,
  xrFramebufferScaleForBackend,
  type XrCameraState,
} from './xr-session';
import {
  applyStaticChrome,
  parseGooseFallbackParam,
  parseWelcomeExpandedParam,
  resolveViewerPreset,
  viewerChromeForPreset,
  type ViewerChrome,
} from './chrome';
import { whenDocumentVisible } from './when-document-visible';
import { installPageResourceLifecycle } from './page-resource-lifecycle';
import { setRendererMsaa, getRendererMsaaSamples } from './renderer-msaa';
import { DoubleTapDetector } from './double-tap';
import { sampleTeleportTransition, type TeleportTransition } from './teleport-transition';
import { PressForwardDetector } from './press-forward';
import { XrDiagnostics, type XrSortDiagnosticsSnapshot } from './xr-diagnostics';
import {
  XrSortCadence,
  applyXrDepthMode,
  resolveXrFoveation,
  resolveXrStabilityOptions,
  restoreXrDepthMode,
  type XrMaterialState,
} from './xr-stability';
import {
  baseDistanceForOrbitalCameraPath,
  CINEMATIC_ORBIT_DURATION,
  CINEMATIC_ORBIT_IDLE_DELAY,
  CINEMATIC_ORBIT_RAMP_DURATION,
  cinematicOrbitBlend,
  evaluateOrbitalCameraPath,
  type OrbitFraming,
} from './orbital-camera-path';
import {
  classifyOrbitFraming,
  heightSamplesFromStreamedMesh,
  overviewPositionsFromStreamedMesh,
} from './orbit-framing';

/**
 * The scene loaded when no source is given. Any other scene comes from
 * `?scene=<url|path>` or from dropping a local file on the window.
 *
 * The goose is committed under `assets/`, which Vite's `publicDir` serves at
 * the app base (`/` in dev, `/demo/` in the docs-site build).
 */
const DEFAULT_SCENE = `${import.meta.env.BASE_URL}goose.sog`;

/** Pool texture row width; dynamic sources are row-aligned to this fixed size. */
const SPLAT_POOL_ROW_WIDTH = 2048;

/** Absolute URL or site-root path for a scene name from `?scene=`. */
function resolveSceneUrl(scene: string): string {
  if (/^[a-z+]+:/i.test(scene)) return scene;
  return scene.startsWith('/') ? scene : `/${scene}`;
}

/** Short display label for a scene (basename of a path or URL). */
function sceneLabel(scene: string): string {
  const path = scene.includes('://') ? new URL(scene).pathname : scene;
  return path.split('/').filter(Boolean).pop() ?? scene;
}

/** Bytes as "1.2 GB" / "540 MB" - enough precision for a progress line. */
function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/**
 * Higher-order SH bands pinned via `?sh=0..3`, or undefined to let the
 * library choose (every band the capture carries, off on a smooth profile).
 * `?sh=0` forces it off; `?sh=3` forces the full 3rd order on.
 */
function requestedShBands(): 0 | 1 | 2 | 3 | undefined {
  const raw = new URLSearchParams(globalThis.location?.search ?? '').get('sh');
  if (raw === null) return undefined;
  const bands = Number(raw);
  return bands === 0 || bands === 1 || bands === 2 || bands === 3 ? bands : undefined;
}

/**
 * A world-space orientation from `?rot=x,y,z` (Euler **degrees**, XYZ order),
 * or null when the param is absent or malformed. Host viewers may carry a
 * per-scene rotation (e.g. `?rot=0,0,180` reproduces `z:180`).
 * The demo applies no automatic flip beyond `orientation` - like raw Spark - so
 * `?rot=` is the extra scene rotation, for every format.
 */
function requestedRotation(raw: string | null): THREE.Matrix4 | null {
  if (raw === null) return null;
  const parts = raw.split(',').map((v) => Number(v.trim()));
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return null;
  const [x, y, z] = parts as [number, number, number];
  if (x === 0 && y === 0 && z === 0) return null;
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(x),
    THREE.MathUtils.degToRad(y),
    THREE.MathUtils.degToRad(z),
    'XYZ',
  );
  return new THREE.Matrix4().makeRotationFromEuler(euler);
}

/**
 * A per-axis mesh scale from `?scale=x,y,z` (or `?scale=s` for uniform), or
 * null when absent or malformed. Applied on top of the scene's base transform
 * - e.g. `?scale=2,0.5,1` - to visually verify non-uniform scaling end-to-end.
 */
function requestedScale(raw: string | null): THREE.Vector3 | null {
  if (raw === null) return null;
  const parts = raw.split(',').map((v) => Number(v.trim()));
  if (parts.length !== 1 && parts.length !== 3) return null;
  if (parts.some((v) => !Number.isFinite(v) || v === 0)) return null;
  const [x, y, z] = parts.length === 1 ? [parts[0]!, parts[0]!, parts[0]!] : parts;
  if (x === 1 && y === 1 && z === 1) return null;
  return new THREE.Vector3(x, y, z);
}

/**
 * The mesh's view-dependent colour state for the debug line: the SH bands it
 * actually renders, which is what the scene had (and the device allowed), not
 * what `?sh=` asked for.
 */
function shLabel(mesh: SplatMesh | undefined): string {
  const bands = mesh?.shBands ?? 0;
  return bands > 0 ? `SH ${bands}` : 'SH off';
}

CameraControls.install({ THREE });

/** Render scale while performance mode is on - 1 device pixel per CSS pixel. */
const PERF_MODE_PIXEL_RATIO = 1;
/**
 * Gaussian cutoff while performance mode is on. The library default on a phone
 * is 4σ so zoomed-out coverage tiles; that extra tail is ~1.8× the quad area of
 * the reference 3σ and is what pushed hard orbits over 16.6 ms on an iPhone 15
 * Pro (WebGPU, 600k LCC-class, dpr 1). 3σ plus no renderer MSAA held 60 rAF
 * there. Coverage tails come back when the mode is off.
 */
const PERF_MODE_MAX_STD_DEV = 3;
/**
 * Resident-splat **ceiling** while performance mode is on.
 *
 * A ceiling, not a setting, and passed as `budgetCap` so the library keeps
 * resolving the device tier and the format's cost class underneath it. Passing
 * it as an explicit `budget` bypassed both: measured on a Galaxy S7 (WebGL2,
 * `deviceMemory: 4`), whose low-power tier resolves to 500k, the demo handed it
 * 1,000,000 instead - performance mode *raised* the load on the weakest device
 * tested.
 */
const PERF_MODE_BUDGET = 1_000_000;
/**
 * Bumped when the default flipped to on for integrated/fallback desktops.
 * The old `vlam:performance-mode` key left Chrome (and any desktop session that
 * once saw the toggle) stuck on `false` after library defaults already applied.
 */
const PERF_MODE_STORAGE_KEY = 'vlam:performance-mode-v2';
const PERF_MODE_STORAGE_KEY_LEGACY = 'vlam:performance-mode';
const CINEMATIC_ORBIT_STORAGE_KEY = 'vlam:cinematic-orbit';
const XR_SKIP_SORT_OPTIONS = { sort: false } as const;

/**
 * Performance-mode state: on by default where the GPU needs it (mobile and
 * fill-constrained desktops), and sticky once the viewer has chosen, so the
 * choice survives a scene switch or reload. `localStorage` can throw (private
 * mode, blocked cookies) - a demo toggle is never worth failing the whole
 * viewer over, so fall back to the default.
 */
function createPerformanceMode(defaultEnabled: boolean): {
  enabled: boolean;
  set(value: boolean): void;
} {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(PERF_MODE_STORAGE_KEY);
    // Drop the pre-v2 sticky value so integrated desktops are not stuck off
    // after the default change; leave the legacy key unread.
    if (stored === null) {
      localStorage.removeItem(PERF_MODE_STORAGE_KEY_LEGACY);
    }
  } catch {
    // Blocked storage: keep the null default and detect from the device.
  }
  return {
    enabled: stored === null ? defaultEnabled : stored === 'true',
    set(value: boolean): void {
      this.enabled = value;
      try {
        localStorage.setItem(PERF_MODE_STORAGE_KEY, String(value));
      } catch {
        // Preference is not persisted; the current session still honors it.
      }
    },
  };
}

/**
 * Sticky cinematic-orbit state. Storage failures fall back to the chrome
 * preset so privacy settings cannot prevent the viewer from starting.
 */
function createCinematicOrbitMode(
  defaultEnabled: boolean,
  urlPlaying: boolean | null = null,
): {
  enabled: boolean;
  set(value: boolean): void;
} {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(CINEMATIC_ORBIT_STORAGE_KEY);
  } catch {
    // Blocked storage: keep the preset default.
  }
  return {
    // A share link's `?orbit=` wins over the sticky preference so a paused
    // copy-view pose is not immediately overwritten by cinematic motion.
    enabled: urlPlaying ?? (stored === null ? defaultEnabled : stored === 'true'),
    set(value: boolean): void {
      this.enabled = value;
      try {
        localStorage.setItem(CINEMATIC_ORBIT_STORAGE_KEY, String(value));
      } catch {
        // Preference is not persisted; the current session still honors it.
      }
    },
  };
}

/**
 * Splits decoded splat data into roughly equal parts (dropping any SH
 * palette) - exercises the dynamic-capacity appendRange path exactly as
 * LOD streaming will use it.
 */
function splitSplatData(data: SplatData, parts: number): SplatData[] {
  const chunks: SplatData[] = [];
  for (let p = 0; p < parts; p++) {
    const start = Math.floor((p * data.count) / parts);
    const end = Math.floor(((p + 1) * data.count) / parts);
    chunks.push({
      count: end - start,
      positions: data.positions.subarray(start * 3, end * 3),
      colors: data.colors.subarray(start * 4, end * 4),
      covariances: data.covariances.subarray(start * 6, end * 6),
      // Carry the source format so each chunk mesh can self-orient like the
      // whole-scene path (the chunked/paint mesh is dynamic, so the demo applies
      // the correction manually - see buildStaticScene).
      ...(data.format ? { format: data.format } : {}),
    });
  }
  return chunks;
}

/**
 * 16 SDF shapes orbiting inside the scene bounds, cycling through the four
 * modes, re-posed every frame. Feeding this to `SdfEffect.setShapes` each
 * frame proves add/move/remove is data-only - no pipeline recompiles.
 */
function makeAnimatedSdfShapes(t: number, bounds: THREE.Box3): SdfShape[] {
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const scale = Math.max(size.x, size.y, size.z) || 1;
  const modes = ['tint', 'desaturate', 'hide', 'rim'] as const;
  const colors: [number, number, number][] = [
    [1, 0.3, 0.2],
    [0.2, 0.9, 0.4],
    [0.3, 0.5, 1],
    [1, 0.85, 0.2],
  ];
  const shapes: SdfShape[] = [];
  const N = 16;
  // Orbit in the scene's two widest axes so shapes actually intersect the
  // content (many splat captures are thin in one axis); wobble gently along
  // the third. The shape half-size spans the thin axis so it stays covered.
  const axes = [0, 1, 2].sort((a, b) => size.getComponent(b) - size.getComponent(a));
  const [wideA, wideB, thin] = axes as [number, number, number];
  // Keep the orbit inside the content's dense core - a capture rarely fills
  // its bounding box, so shapes flung to the box edges would miss every splat.
  const orbit = 0.15 * scale;
  const shapeSize = 0.14 * scale;
  for (let i = 0; i < N; i++) {
    const phase = (i / N) * Math.PI * 2;
    const cen: [number, number, number] = [center.x, center.y, center.z];
    cen[wideA] = center.getComponent(wideA) + Math.cos(phase + t * 0.4) * orbit;
    cen[wideB] = center.getComponent(wideB) + Math.sin(phase + t * 0.4) * orbit;
    cen[thin] = center.getComponent(thin) + Math.sin(t * 0.5 + phase) * orbit * 0.15;
    shapes.push({
      kind: i % 2 === 0 ? 'sphere' : 'box',
      center: cen,
      radius: shapeSize,
      halfExtents: [shapeSize, shapeSize, shapeSize],
      rotation: [0, Math.sin(t * 0.5 + i), 0, Math.cos(t * 0.5 + i)],
      color: colors[i % colors.length],
      falloff: 0.05 * scale,
      strength: 0.9,
      mode: modes[i % modes.length] as SdfShape['mode'],
    });
  }
  return shapes;
}

/**
 * Wire the top-right hamburger. Removed by `applyStaticChrome` for the `embed`
 * preset, so a missing button is expected, not an error.
 */
function wireSiteMenu(): void {
  const button = document.querySelector<HTMLButtonElement>('#site-menu-btn');
  const panel = document.querySelector<HTMLElement>('#site-menu-panel');
  if (!button || !panel) return;

  const setOpen = (open: boolean): void => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };

  button.addEventListener('click', () => setOpen(panel.hidden));

  // Pointerdown, not click: the canvas swallows clicks for camera drags, so a
  // press anywhere in the scene must still dismiss the panel.
  window.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !(e.target instanceof Node && button.parentElement?.contains(e.target))) {
      setOpen(false);
    }
  });

  window.addEventListener('keydown', (e) => {
    // Only consume Escape while open, so the viewer's own shortcuts are unaffected.
    if (e.key === 'Escape' && !panel.hidden) {
      setOpen(false);
      button.focus();
    }
  });
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  // Mobile browsers often open `target=_blank` tabs in the background. WebGPU
  // adapter setup and the first `?scene=` fetch then fail; a manual refresh
  // works because the tab is focused. Wait (briefly) before GPU/scene work.
  if (params.has('scene')) await whenDocumentVisible();
  const chrome: ViewerChrome = viewerChromeForPreset(resolveViewerPreset(params));
  applyStaticChrome(chrome);
  wireSiteMenu();

  const container = document.querySelector<HTMLElement>('#app');
  const overlay = document.querySelector<HTMLElement>('#overlay');
  if (!container || !overlay) throw new Error('Missing #app or #overlay element.');
  const welcomeHint = document.querySelector<HTMLElement>('#welcome-hint');
  const welcomeToggle = document.querySelector<HTMLButtonElement>('#welcome-toggle');
  if (chrome.welcome !== 'none') {
    // The URL box: a pasted link becomes `?scene=`, so it takes the exact path
    // an explicitly opened `?scene=` already takes - and the result is a link
    // the viewer can share. Everything else here is client-side validation, so
    // an obvious typo never costs a page load.
    const urlForm = document.querySelector<HTMLFormElement>('#welcome-url-form');
    const urlInput = document.querySelector<HTMLInputElement>('#welcome-url-input');
    const urlError = document.querySelector<HTMLElement>('#welcome-url-error');
    if (urlForm && urlInput) {
      // Keep a failed load's link editable rather than making the user re-paste.
      const current = params.get('scene');
      if (current !== null && /^https?:/i.test(current)) urlInput.value = current;
      urlInput.addEventListener('input', () => {
        if (urlError) urlError.textContent = '';
      });
      urlForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const checked = validateSceneUrl(urlInput.value);
        if ('error' in checked) {
          // Inline, not `showError`: the panel is still on screen and the
          // failure card would cover the input the user is fixing.
          if (urlError) urlError.textContent = checked.error;
          urlInput.focus();
          return;
        }
        // Swap only `scene` and keep the rest - `?preset=`, `?rot=`, `?sh=`,
        // `?backend=` and the rest of the query surface all survive, so loading
        // a second scene does not silently reset how the viewer is configured.
        const next = new URLSearchParams(location.search);
        next.set('scene', checked.url);
        location.search = `?${next.toString()}`;
      });
    }
  }
  // How scenes are normalized to Y-up. Default 'y-up' (the library default):
  // every known format is stood upright. `?orientation=source` renders in the
  // data frame (raw Spark parity), for hosts that manage orientation themselves.
  const orientation: SplatOrientation = params.get('orientation') === 'source' ? 'source' : 'y-up';
  // An extra per-scene rotation on top of that, applied in world space via
  // premultiply. Null = none. See requestedRotation.
  const userRotation = requestedRotation(params.get('rot'));
  // An extra per-axis mesh scale (`?scale=2,0.5,1`, or one value for uniform),
  // multiplied onto the mesh's own scale - non-uniform scaling is supported
  // end-to-end (projection, sorting, picking, queries).
  const userScale = requestedScale(params.get('scale'));
  // ?backend=webgl forces the WebGL2 backend (fallback-path testing).
  const forceWebGL = params.get('backend') === 'webgl';
  // Timestamp queries have a finite pool in Three.js. Keep the long CPU-frame
  // benchmark clean by opting into GPU timing explicitly for short diagnostics.
  const gpuTimestampsEnabled = params.get('gpuTimestamps') === '1';
  // Enrich the navigator profile with a WebGPU adapter class so laptop / Apple
  // Silicon desktops take the integrated tier instead of the workstation 8M path.
  // Resolved before the renderer so the first frame already has the device
  // default (performance mode drops MSAA at construction; the HD toggle can
  // restore it live via setRendererMsaa).
  const baseDeviceProfile = detectSplatDeviceProfile() ?? {};
  const probedGpuClass = await probeSplatGpuClass();
  const deviceProfile: SplatDeviceProfile = {
    ...baseDeviceProfile,
    ...(probedGpuClass === undefined ? {} : { gpuClass: probedGpuClass }),
  };
  // Performance mode trades detail for frame rate, defaulting on where the GPU
  // needs it (mobile + integrated/fallback desktop) and remembering whatever
  // the viewer chooses. It drives the costs a running viewer can still change:
  // render resolution, resident splat budget, Gaussian cutoff, and MSAA.
  // Streamed SH bands are still a load-time choice.
  const perfMode = createPerformanceMode(isFillConstrainedSplatDevice(deviceProfile));
  // Renderer MSAA is on when performance mode is off; ?rendererAntialias=0/1
  // pins it for A/B (distinct from ?antialias, which toggles the Mip-Splatting
  // filter, not the render target). Measured on an iPhone 15 Pro: MSAA was the
  // last few milliseconds that tipped a 3σ pass back over 16.6 ms.
  const rendererAntialiasParam = params.get('rendererAntialias');
  const rendererAntialias =
    rendererAntialiasParam === '0'
      ? false
      : rendererAntialiasParam === '1'
        ? true
        : !perfMode.enabled;
  // Adapter, device, raised limits and the Windows powerPreference quirk, in
  // one call - including the owned `requestDevice` that keeps MSAA alive and
  // preserves the real failure instead of three's flat "WebGPU is not
  // available" fallback log.
  const renderer = await createSplatRenderer({
    antialias: rendererAntialias,
    forceWebGL,
    trackTimestamp: gpuTimestampsEnabled,
  });
  // Render resolution. Splat rendering is fragment-bound, so on a high-DPI
  // mobile screen this is often the single largest cost; ?pixelRatio=N pins it
  // (e.g. 1 or 1.5) for A/B, overriding performance mode and adaptive DPR.
  // ?adaptiveDpr=1 enables frame-time scaling between 1 and the device ceiling.
  const pixelRatioParam = Number(params.get('pixelRatio'));
  const pinnedPixelRatio =
    Number.isFinite(pixelRatioParam) && pixelRatioParam > 0 ? pixelRatioParam : null;
  // Default ON for fill-constrained devices: nothing else in the viewer
  // self-corrects, so a phone / laptop that cannot hold the frame rate simply
  // stayed slow. `?adaptiveDpr=0` pins it off for A/B runs, `=1` forces it on.
  const adaptiveDprParam = params.get('adaptiveDpr');
  const adaptiveDpr =
    adaptiveDprParam === null
      ? isFillConstrainedSplatDevice(deviceProfile)
      : adaptiveDprParam !== '0';
  // HD uses the library quality ceiling (1.5 on integrated, 2 on discrete), not
  // min(native, ceiling). Clamping to `devicePixelRatio` made HD identical to
  // SD whenever the window reported 1, while `?pixelRatio=1.5` could still
  // supersample. Adaptive DPR may still step down from that ceiling under
  // frame-time pressure.
  const pixelRatioCeiling = (): number => recommendedMaxPixelRatio(deviceProfile);
  let adaptiveEmaMs: number | undefined;
  let adaptiveWarmupRemaining = ADAPTIVE_PIXEL_RATIO_WARMUP_FRAMES;
  let adaptivePixelRatio = pixelRatioCeiling();
  const resetAdaptivePixelRatio = (): void => {
    adaptiveEmaMs = undefined;
    adaptiveWarmupRemaining = ADAPTIVE_PIXEL_RATIO_WARMUP_FRAMES;
    adaptivePixelRatio = pixelRatioCeiling();
  };
  const resolvePixelRatio = (): number =>
    pinnedPixelRatio ??
    (perfMode.enabled
      ? PERF_MODE_PIXEL_RATIO
      : adaptiveDpr
        ? adaptivePixelRatio
        : pixelRatioCeiling());
  renderer.setPixelRatio(resolvePixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  try {
    await renderer.init();
  } catch (error) {
    showError({
      title: 'Graphics unavailable',
      message: 'This viewer needs WebGPU or WebGL2, which this browser or device does not support.',
    });
    console.error(error);
    return;
  }
  // `init()` rebuilds the drawing buffer; re-apply so HD is not stuck at 1
  // after a load that set the ratio before the backend existed.
  renderer.setPixelRatio(resolvePixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  const backendName =
    (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
      ? 'WebGPU'
      : 'WebGL2';
  const xrStability = resolveXrStabilityOptions(params, {
    isHeadset: deviceProfile.isHeadset === true,
    backend: backendName,
    recommendedFramebufferScale: recommendedXrFramebufferScale(deviceProfile),
  });
  const xrSortCadence = new XrSortCadence(xrStability.sortHz);
  const xrDiagnostics = xrStability.diagnostics ? new XrDiagnostics() : null;

  // Graceful device loss (M4.4): a lost GPU device (driver reset, sleep,
  // resource pressure) otherwise leaves a silently frozen canvas. Stop the
  // loop and offer a reload - on WebGPU via `device.lost`, on WebGL2 via the
  // canvas `webglcontextlost` event.
  let deviceLost = false;
  const onDeviceLost = (reason: string): void => {
    if (deviceLost) return;
    deviceLost = true;
    renderer.setAnimationLoop(null);
    showError({
      title: 'Graphics device lost',
      message: `The GPU connection was lost (${reason}). Reload to continue.`,
      action: { label: 'Reload', onClick: () => location.reload() },
    });
  };
  const device = (renderer.backend as { device?: { lost?: Promise<{ reason?: string }> } }).device;
  void device?.lost?.then((info) => {
    // 'destroyed' is an intentional teardown (our dispose), not a failure.
    if (info?.reason !== 'destroyed') onDeviceLost(info?.reason ?? 'unknown');
  });
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    onDeviceLost('WebGL context lost');
  });

  // Hand the GPU device back when the page goes away. Nothing else does: a
  // reload otherwise leaves the previous device - and the whole splat pool
  // behind it - alive until the old document is collected, so a session of
  // reloads on a large scene ends with `requestDevice` failing outright
  // (D3D12 `E_OUTOFMEMORY` creating the command queue) and the viewer quietly
  // running on WebGL2 until the browser is restarted.
  //
  // Quest Browser can retain several viewer documents in bfcache while the XR
  // harness moves back and forth between tests. Each retained WebGL context
  // consumes scarce GPU resources until context creation fails. Always dispose
  // on pagehide; if bfcache restores this now-empty document, reload it to
  // construct one fresh renderer. The explicit device destroy covers the
  // WebGPU device supplied by createSplatRenderer, which three leaves alone.
  installPageResourceLifecycle(
    window,
    () => {
      renderer.dispose();
      (renderer.backend as { device?: { destroy?: () => void } }).device?.destroy?.();
    },
    () => location.reload(),
  );

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1f);

  // Opaque world-locked reference for the Quest A/B harness. If this cube
  // trails with the goose, the fault is frame pacing or XR pose delivery; if
  // only the goose moves, investigate splat sorting/depth instead.
  const xrDiagnosticProbe = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x33ff88 }),
  );
  xrDiagnosticProbe.visible = false;
  scene.add(xrDiagnosticProbe);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.01,
    10000,
  );
  const controls = new CameraControls(camera, renderer.domElement);
  controls.mouseButtons.left = CameraControls.ACTION.NONE;
  controls.mouseButtons.right = CameraControls.ACTION.NONE;
  // Wheel/dolly and enableTransition=true moves coast longer than the library default (0.25).
  controls.smoothTime = 0.45;
  controls.draggingSmoothTime = 0.15;
  renderer.domElement.tabIndex = 0;

  // WebXR (?xr=0 disables, ?foveation=0..1 overrides). Splats handle stereo
  // themselves - SplatMesh.update detects a presenting session, projects with
  // the eye camera and sorts once from the head - so the frame loop below is
  // unchanged in VR.
  //
  // The rig exists because three derives the head pose from the *parent* of
  // the app camera, never from the camera's own transform: without it, entering
  // VR drops the viewer at the reference-space origin, which in most captures
  // is inside the geometry. Parenting on `sessionstart` and restoring on
  // `sessionend` keeps the 2D path untouched for anyone who never enters VR.
  const xrRig = new THREE.Group();
  let xrCameraState: XrCameraState | null = null;
  let xrPlacementPending = false;
  let xrMaterialState: XrMaterialState | null = null;
  const restoreXrMaterial = (): void => {
    restoreXrDepthMode(xrMaterialState);
    xrMaterialState = null;
  };
  const applyXrMaterial = (mesh: SplatMesh): void => {
    restoreXrMaterial();
    if (xrStability.depthAlphaThreshold !== null) {
      xrMaterialState = applyXrDepthMode(mesh, xrStability.depthAlphaThreshold);
    }
  };
  const placeXrDiagnosticProbe = (mesh: SplatMesh): void => {
    mesh.updateWorldMatrix(true, false);
    const bounds = mesh.computeSplatBounds().applyMatrix4(mesh.matrixWorld);
    if (bounds.isEmpty()) return;
    const size = bounds.getSize(new THREE.Vector3());
    const edge = Math.max(size.x, size.y, size.z, 1e-4) * 0.12;
    const center = bounds.getCenter(new THREE.Vector3());
    xrDiagnosticProbe.scale.setScalar(edge);
    xrDiagnosticProbe.position.set(bounds.max.x + edge, center.y, center.z);
    xrDiagnosticProbe.updateMatrixWorld();
  };
  const workerSortSnapshot = (mesh: SplatMesh): XrSortDiagnosticsSnapshot | null => {
    const sorter = (
      mesh as unknown as {
        sorter?: {
          kind?: string;
          snapshot?: () => XrSortDiagnosticsSnapshot;
        };
      }
    ).sorter;
    return sorter?.kind === 'worker' && sorter.snapshot ? sorter.snapshot() : null;
  };
  const logXrDiagnostics = (final: boolean): void => {
    if (!xrDiagnostics || !mounted) return;
    const report = xrDiagnostics.report(performance.now(), workerSortSnapshot(splats), final);
    console.info('XR_DIAGNOSTIC', JSON.stringify({ ...report, config: xrStability }));
  };
  /** Applies the XR framebuffer cap while presenting, the page budget otherwise. */
  const applySplatBudget = (mesh: SplatMesh | undefined = splats): void => {
    // A pinned ?budget is an explicit A/B choice and wins everywhere, in
    // session or out. Only a streamed pool can be resized live.
    if (pinnedBudget !== undefined || !(mesh instanceof StreamedSplatMesh)) return;
    // Use maxBudget (not the raw device default) so load-time finest-level
    // lifts survive applyScene / XR session-end instead of being clobbered
    // back to 4M and forcing LCC cells onto coarse discs.
    // In perf mode the mesh was *loaded* under `budgetCap`, so its own ceiling
    // already reflects the cap, the device tier and the format's cost class.
    // Re-deriving a number here would discard the only one of those three this
    // call site can see.
    const page = pageSplatBudgetForMesh({
      perfMode: perfMode.enabled,
      perfModeBudget: Math.min(PERF_MODE_BUDGET, mesh.maxBudget),
      maxBudget: mesh.maxBudget,
    });
    applyPresentationSplatBudget(mesh, page, renderer.xr.isPresenting);
  };
  if (params.get('xr') !== '0' && typeof navigator !== 'undefined' && navigator.xr) {
    try {
      if (await navigator.xr.isSessionSupported('immersive-vr')) {
        renderer.xr.enabled = true;
        // three 0.185.x reads this setting only on its WebGL XR path. Its
        // XRGPUBinding path creates a native-scale projection layer, so WebGPU
        // uses the budget and fixed-foveation levers below instead.
        const xrFramebufferScale = xrFramebufferScaleForBackend(
          backendName,
          xrStability.framebufferScale,
        );
        if (xrFramebufferScale !== null) {
          // Must precede the session: three warns and ignores this once presenting.
          renderer.xr.setFramebufferScaleFactor(xrFramebufferScale);
        }
        const foveation = resolveXrFoveation(params.get('foveation'));
        renderer.xr.setFoveation(foveation);
        renderer.xr.addEventListener('sessionstart', () => {
          // Save the exact desktop eye pose and lens before three starts
          // copying the XR head/union camera into the application camera.
          xrCameraState = captureXrCameraState(camera);
          xrPlacementPending = true;
          xrRig.position.set(0, 0, 0);
          xrRig.quaternion.identity();
          xrRig.scale.set(1, 1, 1);
          xrRig.updateMatrixWorld(true);
          scene.add(xrRig);
          xrRig.add(camera);
          xrSortCadence.reset();
          if (mounted) {
            applyXrMaterial(splats);
            placeXrDiagnosticProbe(splats);
          }
          xrDiagnosticProbe.visible = xrDiagnostics !== null;
          const activeSession = renderer.xr.getSession();
          if (activeSession) {
            xrDiagnostics?.begin(activeSession, performance.now(), workerSortSnapshot(splats));
          }
          // Re-assert foveation: three re-applies the stored value itself when
          // it builds a *GL* layer, but `_initWebGPUSession` does not, so on a
          // WebGPU-backed session the pre-session value is dropped on the floor.
          renderer.xr.setFoveation(foveation);
          // A pointer-driven, screen-scaled overlay has no meaning in a headset.
          separateTool?.setInteractive(false);
          // Stereo is a property of the session, not the device: two eye
          // viewports together exceed a 4K desktop and every splat is drawn
          // twice. Tighten now and restore on exit - this is what makes a
          // tethered desktop, or a headset we failed to recognize from its
          // user agent, size correctly anyway.
          applySplatBudget();
        });
        renderer.xr.addEventListener('sessionend', () => {
          logXrDiagnostics(true);
          restoreXrMaterial();
          xrDiagnosticProbe.visible = false;
          xrSortCadence.reset();
          // three leaves its last head pose and union projection on the
          // application camera. Restore the exact desktop state before
          // camera-controls resumes.
          if (xrCameraState) restoreXrCameraState(camera, xrCameraState);
          xrCameraState = null;
          separateTool?.setInteractive(true);
          xrPlacementPending = false;
          xrRig.removeFromParent();
          xrRig.position.set(0, 0, 0);
          xrRig.quaternion.identity();
          xrRig.scale.set(1, 1, 1);
          xrRig.updateMatrixWorld(true);
          controls.update(0);
          applySplatBudget();
          refreshOverlay();
        });
        if (chrome.enterVr) {
          buildEnterVrButton(renderer, (message, offerWebGl) => {
            showError({
              title: 'Cannot enter VR',
              message,
              ...(offerWebGl
                ? {
                    action: {
                      label: 'Reload in WebGL mode',
                      onClick: () => {
                        const url = new URL(location.href);
                        url.searchParams.set('backend', 'webgl');
                        location.href = url.toString();
                      },
                    },
                  }
                : {}),
            });
          });
        }
      }
    } catch (error) {
      // XR is an enhancement; a probe failure must not block the 2D viewer.
      console.warn('WebXR unavailable:', error);
    }
  }

  const POINTER_ROTATION_SPEED = 0.0025;
  const MAX_LOOK_PITCH = THREE.MathUtils.degToRad(60);
  /** Half-life of residual drag spin after pointer-up, seconds. */
  const POINTER_INERTIA_HALFLIFE = 0.2;
  const POINTER_INERTIA_EPS = 1e-5;
  const lookTarget = new THREE.Vector3();
  const lookOffset = new THREE.Vector3();
  const lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const lastDragPointer = new THREE.Vector2();
  let dragPointerId: number | null = null;
  let dragButton: number | null = null;
  /**
   * True between the separation gizmo's pointerdown and pointerup. The gizmo
   * captures the pointer itself and never calls `stopPropagation`, so this flag
   * is what stops a *second* (touch) pointer starting a camera drag on top of
   * an in-flight handle drag. The first pointer is handled differently - see
   * `onGizmoDragChange` where the tool is created.
   */
  let gizmoDragging = false;
  /** 'orbit' = spherical rotate; 'look' = FPS look-around; null = coasting or idle. */
  let pointerInertiaMode: 'orbit' | 'look' | null = null;
  /** Residual angular rates (rad/s) applied after pointer-up. */
  let pointerInertiaAz = 0;
  let pointerInertiaPol = 0;
  let lastPointerMoveTime = 0;
  /** Still camera presses become forward; a look-around drag during the hold does not. */
  const pressForward = new PressForwardDetector();

  const pressForwardActive = (): boolean => pressForward.active(performance.now());

  const clearPointerInertia = (): void => {
    pointerInertiaMode = null;
    pointerInertiaAz = 0;
    pointerInertiaPol = 0;
  };

  const rotateViewFromCamera = (deltaX: number, deltaY: number): void => {
    controls.getTarget(lookTarget, false);
    const targetDistance = Math.max(lookTarget.distanceTo(camera.position), 1e-4);
    lookEuler.setFromQuaternion(camera.quaternion, 'YXZ');
    lookEuler.y -= deltaX * POINTER_ROTATION_SPEED;
    lookEuler.x = THREE.MathUtils.clamp(
      lookEuler.x - deltaY * POINTER_ROTATION_SPEED,
      -MAX_LOOK_PITCH,
      MAX_LOOK_PITCH,
    );
    lookEuler.z = 0;
    lookOffset.set(0, 0, -targetDistance).applyEuler(lookEuler);
    lookTarget.copy(camera.position).add(lookOffset);
    camera.up.set(0, 1, 0);
    controls.setLookAt(
      camera.position.x,
      camera.position.y,
      camera.position.z,
      lookTarget.x,
      lookTarget.y,
      lookTarget.z,
      false,
    );
  };

  /**
   * Continues the last drag spin with exponential decay. Custom pointer handlers
   * call rotate/setLookAt with enableTransition=false (instant), so camera-controls'
   * smoothTime never coasts them - this fills that gap.
   */
  const updatePointerInertia = (elapsed: number): void => {
    if (dragPointerId !== null || pointerInertiaMode === null) return;
    if (
      Math.abs(pointerInertiaAz) < POINTER_INERTIA_EPS &&
      Math.abs(pointerInertiaPol) < POINTER_INERTIA_EPS
    ) {
      clearPointerInertia();
      return;
    }
    const stepAz = pointerInertiaAz * elapsed;
    const stepPol = pointerInertiaPol * elapsed;
    if (pointerInertiaMode === 'look') {
      // rotateViewFromCamera takes pointer pixels; convert rad → pixels.
      rotateViewFromCamera(stepAz / POINTER_ROTATION_SPEED, stepPol / POINTER_ROTATION_SPEED);
    } else {
      controls.rotate(stepAz, stepPol, false);
    }
    const decay = Math.exp((-Math.LN2 * elapsed) / POINTER_INERTIA_HALFLIFE);
    pointerInertiaAz *= decay;
    pointerInertiaPol *= decay;
  };

  renderer.domElement.addEventListener('pointerdown', (event) => {
    renderer.domElement.focus();
    if ((event.button !== 0 && event.button !== 2) || dragPointerId !== null || gizmoDragging) {
      return;
    }
    // Paint mode owns LMB: a pick decides paint vs orbit before either starts.
    // Capture now so moves during the async classify still belong to this press.
    if (event.button === 0 && paintTool) {
      renderer.domElement.setPointerCapture(event.pointerId);
      return;
    }
    clearPointerInertia();
    dragPointerId = event.pointerId;
    dragButton = event.button;
    lastDragPointer.set(event.clientX, event.clientY);
    lastPointerMoveTime = performance.now();
    pressForward.begin(event.pointerId, event.clientX, event.clientY, lastPointerMoveTime);
    // Capture only once the pointer actually moves. Calling this on pointerdown
    // makes WebKit fire `pointercancel` immediately, which both drops the drag
    // and used to wipe the double-tap recognizer before the tap was recorded.
  });
  renderer.domElement.addEventListener('pointermove', (event) => {
    if (event.pointerId !== dragPointerId) return;
    const deltaX = event.clientX - lastDragPointer.x;
    const deltaY = event.clientY - lastDragPointer.y;
    lastDragPointer.set(event.clientX, event.clientY);
    if (deltaX === 0 && deltaY === 0) return;

    if (!renderer.domElement.hasPointerCapture(event.pointerId)) {
      renderer.domElement.setPointerCapture(event.pointerId);
    }

    // Walking always looks, never orbits. Orbiting swings the camera around a
    // pivot two metres ahead - which moves it *vertically* - and walk mode
    // pulls it straight back to eye height every frame, so the two heave the
    // camera metres up and down against each other. A body standing on a floor
    // has nothing to orbit around anyway. A still-hold that has already
    // become a forward input looks the same way, so the view can turn while
    // moving; a look that starts during the hold cancels forward instead.
    const now = performance.now();
    pressForward.move(event.pointerId, event.clientX, event.clientY, now);
    const lookAround =
      dragButton === 2 ||
      (dragButton === 0 && (movementKeys.size > 0 || walkMode || pressForward.active(now)));
    const moveDt = Math.max((now - lastPointerMoveTime) / 1000, 1 / 240);
    lastPointerMoveTime = now;
    if (lookAround) {
      // Look applies raw pointer deltas; orbit negates them for spherical rotate.
      pointerInertiaMode = 'look';
      pointerInertiaAz = (deltaX * POINTER_ROTATION_SPEED) / moveDt;
      pointerInertiaPol = (deltaY * POINTER_ROTATION_SPEED) / moveDt;
      rotateViewFromCamera(deltaX, deltaY);
    } else {
      const dAz = -deltaX * POINTER_ROTATION_SPEED;
      const dPol = -deltaY * POINTER_ROTATION_SPEED;
      pointerInertiaMode = 'orbit';
      pointerInertiaAz = dAz / moveDt;
      pointerInertiaPol = dPol / moveDt;
      controls.rotate(dAz, dPol, false);
    }
  });
  const endPointerDrag = (event: PointerEvent): void => {
    if (event.pointerId !== dragPointerId) return;
    dragPointerId = null;
    dragButton = null;
    pressForward.cancel(event.pointerId);
    // Stale last-sample (pointer stopped before up) would invent a phantom flick.
    if (performance.now() - lastPointerMoveTime > 80) clearPointerInertia();
  };
  renderer.domElement.addEventListener('pointerup', endPointerDrag);
  renderer.domElement.addEventListener('pointercancel', endPointerDrag);
  renderer.domElement.addEventListener('lostpointercapture', endPointerDrag);
  renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());

  const movementKeys = new Set<string>();
  const movementDelta = new THREE.Vector3();
  const movementForward = new THREE.Vector3();
  const movementRight = new THREE.Vector3();
  const movementUp = new THREE.Vector3();
  const movementTarget = new THREE.Vector3();
  const MOVEMENT_SPEED_SCENE_RADII_PER_SECOND = 0.05;
  const MOVEMENT_SPEED_BOOST = 3;
  const MOVEMENT_ORBIT_DISTANCE = 2;
  const TELEPORT_DISTANCE = 3;
  const TELEPORT_DURATION_MS = 500;
  let movementSpeed = MOVEMENT_SPEED_SCENE_RADII_PER_SECOND;

  // Collision, for the captures that ship it (.lcc collision.lci / .lcc2 mesh tiles).
  // LCC captures are metric, so walking can use real-world numbers.
  /** Eye height above the floor when walking, metres. */
  const EYE_HEIGHT = 1.7;
  /** Gravity, m/s². Well above 9.81: real gravity feels floaty in a viewer. */
  const GRAVITY = 18;
  /** Upward launch speed of a jump, m/s (~0.7 m of hop). */
  const JUMP_SPEED = 5;
  /** Ground speed when walking, m/s (Shift doubles it). */
  const WALK_SPEED = 4;
  /** Rise a step snaps up, and slack below the feet before falling, metres. */
  const GROUND_SNAP = 0.5;
  /** Below this much drop, walking gives up and hovers instead. */
  const MAX_GROUND_DROP = 50;
  /** Terminal speed, m/s - a long fall must not tunnel the floor. */
  const MAX_FALL_SPEED = 40;

  let collisionWorld: CollisionWorld | null = null;
  let collisionEnabled = true;
  let walkMode = false;
  /**
   * `?fpv=1` is applied once the first collision tile is queryable. The BVH
   * builds one tile per idle callback, so the world is not `.ready` on the
   * same tick `loadCollisionMeshes` resolves.
   */
  let fpvWalkPending = parseFpvParam(params.get('fpv'));
  let collisionRadius = 0.3;
  let verticalVelocity = 0;
  /** Guards against a slow collision load landing after the scene changed. */
  let collisionSequence = 0;
  const walkDelta = new THREE.Vector3();
  const walkForward = new THREE.Vector3();
  const walkRight = new THREE.Vector3();
  /** Where the camera was before this frame's walk step, to detect real motion. */
  const walkPrevious = new THREE.Vector3();

  const movementKeyCodes = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyZ', 'Space']);
  const speedBoostKeyCodes = new Set(['ShiftLeft', 'ShiftRight']);
  const speedBoostKeys = new Set<string>();
  const isEditableTarget = (target: EventTarget | null): boolean => {
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    );
  };

  const clearMovementKeys = (): void => {
    movementKeys.clear();
    speedBoostKeys.clear();
    pressForward.cancel();
  };
  window.addEventListener('blur', clearMovementKeys);
  document.addEventListener('visibilitychange', clearMovementKeys);
  window.addEventListener('keydown', (event) => {
    const isMovementKey = movementKeyCodes.has(event.code);
    const isSpeedBoostKey = speedBoostKeyCodes.has(event.code);
    if ((!isMovementKey && !isSpeedBoostKey) || isEditableTarget(event.target)) return;
    if (document.activeElement !== renderer.domElement) return;
    if (isMovementKey) movementKeys.add(event.code);
    if (isSpeedBoostKey) speedBoostKeys.add(event.code);
    event.preventDefault();
  });
  window.addEventListener('keyup', (event) => {
    if (movementKeyCodes.has(event.code)) movementKeys.delete(event.code);
    if (speedBoostKeyCodes.has(event.code)) speedBoostKeys.delete(event.code);
  });

  /** Whether collision is available and switched on for this scene. */
  const collisionActive = (): boolean =>
    collisionEnabled && collisionWorld !== null && collisionWorld.ready;

  /**
   * Re-points the orbit pivot just ahead of the camera after a move.
   *
   * fitToBox may leave the target hundreds of units away. Moving adopts a
   * nearby pivot (two world units, i.e. metres for LCC) so the next orbit
   * cannot swing the camera around the scene-scale framing radius.
   */
  const commitCameraMove = (): void => {
    movementForward.set(0, 0, -1).transformDirection(camera.matrixWorld);
    movementTarget.copy(camera.position).addScaledVector(movementForward, MOVEMENT_ORBIT_DISTANCE);
    controls.setLookAt(
      camera.position.x,
      camera.position.y,
      camera.position.z,
      movementTarget.x,
      movementTarget.y,
      movementTarget.z,
      false,
    );
  };

  const updateFlyMovement = (elapsed: number): void => {
    const autoForward = pressForwardActive();
    if (
      (movementKeys.size === 0 && !autoForward) ||
      document.activeElement !== renderer.domElement
    ) {
      return;
    }

    movementDelta.set(0, 0, 0);
    movementForward.set(0, 0, -1).transformDirection(camera.matrixWorld);
    movementRight.set(1, 0, 0).transformDirection(camera.matrixWorld);
    movementUp.set(0, 1, 0).transformDirection(camera.matrixWorld);

    const speedMultiplier = speedBoostKeys.size > 0 ? MOVEMENT_SPEED_BOOST : 1;
    const distance = movementSpeed * speedMultiplier * elapsed;
    if (movementKeys.has('KeyW') || autoForward) {
      movementDelta.addScaledVector(movementForward, distance);
    }
    if (movementKeys.has('KeyS')) movementDelta.addScaledVector(movementForward, -distance);
    if (movementKeys.has('KeyA')) movementDelta.addScaledVector(movementRight, -distance);
    if (movementKeys.has('KeyD')) movementDelta.addScaledVector(movementRight, distance);
    if (movementKeys.has('KeyZ')) movementDelta.addScaledVector(movementUp, -distance);
    if (movementKeys.has('Space')) movementDelta.addScaledVector(movementUp, distance);
    if (movementDelta.lengthSq() === 0) return;

    if (collisionActive()) {
      (collisionWorld as CollisionWorld).moveSphere(
        camera.position,
        movementDelta,
        collisionRadius,
      );
    } else {
      camera.position.add(movementDelta);
    }
    commitCameraMove();
  };

  /** True while the camera is standing on something - what a jump needs. */
  let grounded = false;

  /**
   * Walks the camera: horizontal input only, gravity, and a floor probe that
   * both keeps the eye at head height and steps up small rises.
   *
   * Unlike flying, this runs every frame whether or not a key is down -
   * gravity is not an input.
   */
  const updateWalkMovement = (elapsed: number): void => {
    const world = collisionWorld;
    if (!world?.ready) return;

    walkPrevious.copy(camera.position);
    const focused = document.activeElement === renderer.domElement;
    const autoForward = pressForwardActive();
    walkDelta.set(0, 0, 0);
    if (focused && (movementKeys.size > 0 || autoForward)) {
      walkForward.set(0, 0, -1).transformDirection(camera.matrixWorld).setY(0);
      // Looking straight down leaves no forward to project; the camera's own
      // up is the horizontal direction it is facing in that pose.
      if (walkForward.lengthSq() < 1e-8) {
        walkForward.set(0, 1, 0).transformDirection(camera.matrixWorld).setY(0);
      }
      walkForward.normalize();
      walkRight.set(1, 0, 0).transformDirection(camera.matrixWorld).setY(0).normalize();

      const distance = WALK_SPEED * (speedBoostKeys.size > 0 ? 2 : 1) * elapsed;
      if (movementKeys.has('KeyW') || autoForward) {
        walkDelta.addScaledVector(walkForward, distance);
      }
      if (movementKeys.has('KeyS')) walkDelta.addScaledVector(walkForward, -distance);
      if (movementKeys.has('KeyA')) walkDelta.addScaledVector(walkRight, -distance);
      if (movementKeys.has('KeyD')) walkDelta.addScaledVector(walkRight, distance);
      if (movementKeys.has('Space') && grounded) {
        verticalVelocity = JUMP_SPEED;
        grounded = false;
      }
    }
    if (walkDelta.lengthSq() > 0) world.moveSphere(camera.position, walkDelta, collisionRadius);

    const ground = world.groundDistance(camera.position, MAX_GROUND_DROP);
    if (ground === null) {
      // Nothing below within a long drop: the capture's collision does not
      // cover here. Hover rather than fall out of the scene forever.
      verticalVelocity = 0;
      grounded = false;
    } else if (verticalVelocity <= 0 && ground <= EYE_HEIGHT + GROUND_SNAP) {
      // Standing, landing, or stepping up a kerb: hold the eye at head height.
      // The dead-band matters more than it looks: without it the probe's own
      // float noise nudges the camera every frame, so a camera standing
      // perfectly still never reads as still - and re-points the controls and
      // re-runs LOD scheduling forever.
      const correction = EYE_HEIGHT - ground;
      if (Math.abs(correction) > 1e-3) camera.position.y += correction;
      verticalVelocity = 0;
      grounded = true;
    } else {
      grounded = false;
      verticalVelocity = Math.max(verticalVelocity - GRAVITY * elapsed, -MAX_FALL_SPEED);
      const step = verticalVelocity * elapsed;
      if (step < 0 && ground + step < EYE_HEIGHT) {
        camera.position.y += EYE_HEIGHT - ground; // would fall through; land instead
        verticalVelocity = 0;
        grounded = true;
      } else {
        camera.position.y += step;
        world.depenetrate(camera.position, collisionRadius); // e.g. a ceiling
      }
    }
    // Gravity runs every frame, but re-pointing the controls when nothing
    // actually moved would fight the user's own mouse-look for the pivot.
    if (camera.position.distanceToSquared(walkPrevious) > 1e-8) commitCameraMove();
  };

  const updateMovement = (elapsed: number): void => {
    applyWalkFromUrl();
    if (walkMode && collisionEnabled && collisionWorld?.ready) updateWalkMovement(elapsed);
    else updateFlyMovement(elapsed);
  };

  /** Drops the camera onto the floor when walking starts. */
  const groundCamera = (): void => {
    const world = collisionWorld;
    if (!world?.ready) return;
    world.depenetrate(camera.position, collisionRadius);
    const ground = world.groundDistance(camera.position, MAX_GROUND_DROP);
    if (ground !== null) camera.position.y += EYE_HEIGHT - ground;
    verticalVelocity = 0;
    grounded = ground !== null;
    commitCameraMove();
  };

  const setWalkMode = (walk: boolean): void => {
    walkMode = walk;
    if (walk) groundCamera();
    refreshOverlay();
  };

  /** Restores `?fpv=1` once a collision floor exists to stand on. */
  const applyWalkFromUrl = (): void => {
    if (!fpvWalkPending || !collisionEnabled || !collisionWorld?.ready) return;
    fpvWalkPending = false;
    setWalkMode(true);
    collisionToggles.setWalk(true);
  };

  const collisionToggles = chrome.collisionUi
    ? buildCollisionToggles(
        (enabled) => {
          collisionEnabled = enabled;
          if (!enabled && walkMode) {
            // Walking needs a floor; without collision there is none.
            walkMode = false;
            collisionToggles.setWalk(false);
          }
          refreshOverlay();
        },
        (walk) => setWalkMode(walk),
      )
    : {
        setAvailable: (_available: boolean) => {},
        setWalk: (_walk: boolean) => {},
      };

  window.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyG' || isEditableTarget(event.target)) return;
    if (document.activeElement !== renderer.domElement) return;
    if (!collisionEnabled || !collisionWorld?.ready) return;
    event.preventDefault();
    setWalkMode(!walkMode);
    collisionToggles.setWalk(walkMode);
  });

  /**
   * Frame rate for the overlay, in place of the stats.js panel that used to
   * float over the bottom-right chrome. One number beside the backend name
   * says what that graph said, in a line the viewer is already reading.
   *
   * Smoothed over a second of frames: an instantaneous reading flickers too
   * fast to read, and the overlay only repaints every 250ms anyway.
   */
  let fps = 0;
  let fpsFrames = 0;
  let fpsSince = performance.now();
  const sampleFps = (): void => {
    fpsFrames++;
    const now = performance.now();
    const elapsed = now - fpsSince;
    if (elapsed < 1000) return;
    fps = Math.round((fpsFrames * 1000) / elapsed);
    fpsFrames = 0;
    fpsSince = now;
  };
  /** `· 58 rAF`, honestly naming callback rather than physical presentation cadence. */
  const fpsSuffix = (): string => (chrome.stats && fps > 0 ? ` · ${fps} rAF` : '');

  // `?hud=1` - the phone-readable panel. The overlay's fps covers the desktop
  // case, but it is too small to read at arm's length and carries none of the
  // splat-side state (budget, SH bands, GPU split) an A/B run turns on.
  const perfHud = chrome.perfHud && params.get('hud') === '1' ? createPerfHud() : null;
  if (perfHud) document.body.appendChild(perfHud.element);
  document.addEventListener('visibilitychange', () => perfHud?.reset());
  let hudSortCount = 0;
  let hudSortSince = performance.now();
  let hudSortHz = 0;
  const sampleSort = (mesh: SplatMesh, now: number): { hz: number; ageMs: number } | undefined => {
    const scheduler = (
      mesh as unknown as {
        sortScheduler?: { snapshot(): { acceptedCount: number; lastAcceptedAt: number } };
      }
    ).sortScheduler;
    if (!scheduler) return undefined;
    const snapshot = scheduler.snapshot();
    const elapsed = now - hudSortSince;
    if (elapsed >= 1000) {
      hudSortHz = ((snapshot.acceptedCount - hudSortCount) * 1000) / elapsed;
      hudSortCount = snapshot.acceptedCount;
      hudSortSince = now;
    }
    return {
      hz: hudSortHz,
      ageMs: Number.isFinite(snapshot.lastAcceptedAt)
        ? Math.max(0, now - snapshot.lastAcceptedAt)
        : 0,
    };
  };
  /** Detected once - the profile cannot change within a session. */
  const hudDeviceProfile = ((): {
    memoryGb?: number;
    mobile: boolean;
    lowPower: boolean;
    gpuClass?: string;
  } => {
    return {
      ...(deviceProfile.deviceMemoryGb === undefined
        ? {}
        : { memoryGb: deviceProfile.deviceMemoryGb }),
      mobile: deviceProfile.isMobile === true,
      lowPower: deviceProfile.isLowPower === true,
      ...(deviceProfile.gpuClass === undefined ? {} : { gpuClass: deviceProfile.gpuClass }),
    };
  })();
  const hudBrowser = hudBrowserName(typeof navigator === 'undefined' ? '' : navigator.userAgent);
  /**
   * Worst per-update CPU cost seen, by stage. Monotonic maxima like
   * `planTimings.worstApplyMs`, so a stall that happened once while the camera
   * swung is still readable afterwards - the thing a rolling average loses.
   */
  const worstUpdate = { cpuMs: 0, uploadMs: 0, sortSubmitMs: 0, activeListMs: 0 };
  const recordWorstUpdate = (event: StreamedSplatPerformanceEvent): void => {
    worstUpdate.cpuMs = Math.max(worstUpdate.cpuMs, event.cpuMs);
    worstUpdate.uploadMs = Math.max(worstUpdate.uploadMs, event.uploadMs);
    worstUpdate.sortSubmitMs = Math.max(worstUpdate.sortSubmitMs, event.sortSubmitMs);
    worstUpdate.activeListMs = Math.max(worstUpdate.activeListMs, event.activeListMs);
  };

  const sortStrategy: 'radix' | 'counting' = params.get('sort') === 'radix' ? 'radix' : 'counting';
  // ?budget pins the budget for A/B; otherwise performance mode picks the low
  // one and the library resolves the device default.
  const pinnedBudget = Number(params.get('budget')) || undefined;
  // Omitted unless pinned: the library picks the profile from the device, and
  // passing one unconditionally would mask that default.
  const profileParam = params.get('profile');
  const performanceProfile: SplatPerformanceProfile | undefined =
    profileParam === null ? undefined : profileParam === 'smooth' ? 'smooth' : 'quality';
  // ?cacheMB=N pins the decoded-chunk CPU cache cap, to reproduce a phone's
  // tighter cache on desktop (the streamed-SOG donut: the finest chunks are
  // wanted nearest the camera and are the first evicted when the cap is short).
  // ?minSplatPx=N floors each splat's projected quad radius (px), to A/B the
  // screen-space minimum-size fix for the zoomed-out dark-gap failure on mobile.
  // `0` explicitly forces it off; no floor is applied automatically.
  const minSplatPxParam = params.get('minSplatPx');
  const minSplatSizePx = minSplatPxParam === null ? undefined : Number(minSplatPxParam);
  const cacheMbParam = params.get('cacheMB');
  const cpuCacheBytes =
    cacheMbParam === null ? undefined : Math.round(Number(cacheMbParam) * 1024 * 1024) || undefined;
  const benchmarkSeconds = Number(params.get('benchmarkSeconds')) || 0;
  const swapCap = Number(params.get('swapCap')) || undefined;
  const manualBenchmarkStart = params.get('benchmarkStart') === 'manual';
  const sortIntervalParam = params.get('sortIntervalMs');
  const sortIntervalMs = sortIntervalParam === null ? undefined : Number(sortIntervalParam);
  // ?antialias=on|off forces the Mip-Splatting filter regardless of the scene's
  // own flag (for A/B comparison); omit to honor the SOG `antialias` meta flag.
  const antialiasParam = params.get('antialias');
  const antialias = antialiasParam === 'on' ? true : antialiasParam === 'off' ? false : undefined;
  // ?maxStdDev=N pins the Gaussian cutoff (3 = reference, 4 = mobile default)
  // to weigh overdraw against the clipped tail on a given device. Unpinned,
  // performance mode uses 3σ so a phone's fill-bound orbit stays in 16.6 ms.
  const pinnedMaxStdDev = Number(params.get('maxStdDev')) || undefined;
  // Blob cull (px): hide splats whose projected radius exceeds this. On by
  // default for .rad (removes the near-camera coarse-LOD blobs); `?blobCull=0`
  // turns it off, `?blobCull=<px>` tunes the threshold. See RAD_BLOB_CULL_PX.
  const blobCull = params.has('blobCull') ? Number(params.get('blobCull')) : undefined;
  // Foveated `.rad` cut: `?foveationMode=band` forces the legacy screen-radius
  // band (A/B); `?foveationMode=page-table` uses Spark's selected-index page
  // table (CPU-picked frontier paged into the pool); default is the GPU
  // frontier cut. `?foveationPx=N` tunes the target node size.
  const foveationParam = params.get('foveationMode');
  const foveationMode =
    foveationParam === 'band'
      ? ('band' as const)
      : foveationParam === 'page-table'
        ? ('page-table' as const)
        : undefined;
  const foveationTargetPx = params.has('foveationPx')
    ? Number(params.get('foveationPx'))
    : undefined;
  // `?foveationDraw=N` caps the frontier cut's drawn-splat count; the limit
  // self-adjusts to hold it (bigger = denser/slower, smaller = coarser/faster).
  const foveationDrawBudget = params.has('foveationDraw')
    ? Number(params.get('foveationDraw'))
    : undefined;
  // `?aspectClamp=K` caps a rendered splat's major/minor axis ratio at K, taming
  // far-field needle/spike artifacts from anisotropic / expanded coarse splats.
  const maxSplatAspect = params.has('aspectClamp') ? Number(params.get('aspectClamp')) : undefined;
  // Page-table foveation ramp (Spark's `coneFov0`/`coneFov`/`coneFoveate`/
  // `behindFoveate`): full detail inside `?coneFov0=` degrees of the view
  // direction, falling to `?coneFoveate=` by `?coneFov=` and to
  // `?behindFoveate=` behind. Off-cone content is coarsened, never dropped, so
  // turning or zooming out never exposes an unpainted region.
  const frontierFoveation = {
    ...(params.has('coneFov0') ? { coneFov0: Number(params.get('coneFov0')) } : {}),
    ...(params.has('coneFov') ? { coneFov: Number(params.get('coneFov')) } : {}),
    ...(params.has('coneFoveate') ? { coneFoveate: Number(params.get('coneFoveate')) } : {}),
    ...(params.has('behindFoveate') ? { behindFoveate: Number(params.get('behindFoveate')) } : {}),
  };
  // `?lodAlpha=0` disables Spark's merged-node σ-growth + super-Gaussian falloff
  // for `.rad` (A/B against the plain true-Gaussian path). Default on for `.rad`.
  const lodAlpha = params.has('lodAlpha') ? params.get('lodAlpha') !== '0' : undefined;
  const resolvedMaxStdDev = (): number | undefined => {
    if (pinnedMaxStdDev !== undefined) return pinnedMaxStdDev;
    return perfMode.enabled ? PERF_MODE_MAX_STD_DEV : undefined;
  };
  const qualityMaxStdDev = (): number => (isFillConstrainedSplatDevice(deviceProfile) ? 4 : 3);
  const meshOptions = (): SplatMeshOptions => {
    const cutoff = resolvedMaxStdDev();
    return {
      sortStrategy,
      orientation,
      ...(performanceProfile === undefined ? {} : { performanceProfile }),
      ...(sortIntervalMs === undefined ? {} : { sortIntervalMs }),
      ...(antialias === undefined ? {} : { antialias }),
      ...(cutoff === undefined ? {} : { maxStdDev: cutoff }),
      ...(minSplatSizePx === undefined ? {} : { minSplatSizePx }),
      ...(params.get('poolFloat') === 'float16' ? { poolFloatTextures: 'float16' as const } : {}),
    };
  };
  /** Blob culling is opt-in: a coarse prefix node is the coverage fallback. */
  const RAD_BLOB_CULL_PX = 0;
  const radMeshOptions = () => ({
    ...meshOptions(),
    maxSplatScreenRadius: blobCull ?? RAD_BLOB_CULL_PX,
    ...(foveationMode ? { foveationMode } : {}),
    ...(foveationTargetPx === undefined ? {} : { foveationTargetPx }),
    ...(foveationDrawBudget === undefined ? {} : { foveationDrawBudget }),
    ...(maxSplatAspect === undefined ? {} : { maxSplatAspect }),
    ...(Object.keys(frontierFoveation).length === 0 ? {} : { frontierFoveation }),
    ...(lodAlpha === undefined ? {} : { lodAlpha }),
  });
  let benchmark =
    benchmarkSeconds > 0 && !manualBenchmarkStart
      ? createFrameBenchmark(Number(params.get('warmupSeconds')) || 15, benchmarkSeconds)
      : null;
  let lastTimestampResolveAt = -Infinity;
  let timestampResolvePending: Promise<void> | null = null;
  let latestComputeGpuMs: number | undefined;
  let latestRenderGpuMs: number | undefined;
  const resolveGpuTimestamps = (): Promise<void> => {
    if (!gpuTimestampsEnabled) return Promise.resolve();
    if (timestampResolvePending) return timestampResolvePending;
    timestampResolvePending = Promise.all([
      renderer.resolveTimestampsAsync('compute').catch(() => undefined),
      renderer.resolveTimestampsAsync('render').catch(() => undefined),
    ])
      .then(([compute, render]) => {
        if (compute !== undefined) latestComputeGpuMs = compute;
        if (render !== undefined) latestRenderGpuMs = render;
      })
      .finally(() => {
        timestampResolvePending = null;
      });
    return timestampResolvePending;
  };
  const benchmarkOutput = benchmarkSeconds > 0 ? document.createElement('pre') : null;
  if (benchmarkOutput) {
    benchmarkOutput.id = 'benchmark-json';
    benchmarkOutput.hidden = true;
    document.body.appendChild(benchmarkOutput);
  }
  let swapPerformanceEvents: StreamedSplatPerformanceEvent[] = [];
  const sceneName = params.get('scene') ?? DEFAULT_SCENE;
  // True while the built-in default goose is on screen. Cleared when a drop or
  // any other framed scene replaces it; kept across effect rebuilds (`frame: false`).
  let isDefaultGoose = !params.has('scene');
  /**
   * User opted to expand the welcome panel while a non-goose scene is showing.
   * Cleared whenever a new framed (non-rebuild) scene mounts, so a drop
   * collapses the panel again.
   */
  let welcomeExpanded = false;
  const keepWelcomeExpanded =
    chrome.welcome === 'full' && parseWelcomeExpandedParam(params.get('welcome'));
  const gooseFallback = parseGooseFallbackParam(params.get('fallback'));
  let usedGooseFallback = false;
  /**
   * Full welcome panel on the built-in goose; after any other scene, a single
   * drop-hint line with an expand toggle. Embed (`drop-hint`) is unchanged.
   */
  const syncWelcomePanel = (options: { forceExpanded?: boolean } = {}): void => {
    if (!welcomeHint || chrome.welcome === 'none') return;
    if (chrome.welcome === 'drop-hint') {
      welcomeHint.classList.add('visible');
      welcomeHint.classList.remove('welcome-collapsed', 'welcome-expanded');
      if (welcomeToggle) welcomeToggle.hidden = true;
      return;
    }
    if (options.forceExpanded) welcomeExpanded = true;
    welcomeHint.classList.add('visible');
    // Goose keeps the full branding panel; everything else collapses unless the
    // viewer has expanded it (or a failed `?scene=` forced the pickers open).
    const collapsed = !isDefaultGoose && !welcomeExpanded;
    welcomeHint.classList.toggle('welcome-collapsed', collapsed);
    welcomeHint.classList.toggle('welcome-expanded', !collapsed && !isDefaultGoose);
    if (welcomeToggle) {
      welcomeToggle.hidden = isDefaultGoose;
      welcomeToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      welcomeToggle.setAttribute('aria-label', collapsed ? 'Expand welcome' : 'Collapse welcome');
    }
  };
  if (chrome.welcome === 'full') {
    welcomeToggle?.addEventListener('click', () => {
      welcomeExpanded = !welcomeExpanded;
      syncWelcomePanel();
    });
  }
  // A manifest URL (…/lod-meta.json or .lcc2) selects the LOD-streaming path.
  const streamed = isStreamedScene(sceneName);
  // ?mode=chunked streams the scene into a dynamic-capacity mesh in four
  // appendRange calls - must be visually identical to static loading.
  const chunked = params.get('mode') === 'chunked';
  // ?tool=select (or legacy ?separate=1) starts with select & cut already
  // picked: place a box/sphere/cylinder, preview the covered splats, split
  // them into their own animated mesh (M9+). The tool itself is always
  // available from the picker; Copy cameralink writes `?tool=` for any armed
  // tool so a pasted link restores it.
  const separateMode = params.has('separate');
  const toolFromUrl = parseViewerTool(params.get('tool'));
  const orbitFromUrl = parseOrbitPlayingParam(params.get('orbit'));

  // Scene state. A dropped file replaces all of it in place, so everything
  // derived from the current scene is a `let` that `applyScene` re-derives;
  // the listeners below are registered once and read these through the
  // closure rather than being re-bound per scene.
  let splats!: SplatMesh;
  let splatData: SplatData | null = null;
  let mounted = false;
  let sceneTitle = sceneLabel(sceneName);
  /** Non-null while a scene is decoding - the overlay shows progress for it. */
  let loadingTitle: string | null = sceneLabel(sceneName);
  /**
   * Bytes read of a loading scene. `total` is 0 while the size is unknown, and
   * the whole thing is null for a format that cannot report at all - both mean
   * "show the spinner without a bar".
   */
  let loadingProgress: { loaded: number; total: number } | null = null;
  /**
   * Streamed startup hold (classic `.lcc` in-view L1-near / coarsest-far,
   * `.lcc2` in-view coarsest). Library default, unless
   * `?initialReveal=progressive`. While pending, the mesh stays invisible and
   * camera controls are locked so the frozen set matches the URL pose.
   */
  const preferStartupHold = params.get('initialReveal') !== 'progressive';
  let nearL0HoldActive = false;
  /**
   * While `applyScene` awaits `fitToBox`, skip `update()` so the coverage hold
   * cannot freeze the pre-fit camera (mounted is already true, mesh is in the
   * scene). Cleared after framing.
   */
  let suppressStreamedUpdate = false;
  const cinematicOrbitMode = createCinematicOrbitMode(chrome.cinematicOrbit, orbitFromUrl);
  let cinematicOrbitPlaying = cinematicOrbitMode.enabled;
  let cinematicOrbitPhase = 0;
  let cinematicOrbitLastInteraction = performance.now();
  let cinematicOrbitWasMoving = false;
  const cinematicOrbitCenter = new THREE.Vector3();
  const cinematicOrbitPosition = new THREE.Vector3();
  const cinematicOrbitTarget = new THREE.Vector3();
  const cinematicOrbitResumePosition = new THREE.Vector3();
  const cinematicOrbitResumeTarget = new THREE.Vector3();
  let cinematicOrbitDistance = 1;
  let cinematicOrbitFraming: OrbitFraming = 'object';
  let cinematicOrbitVerticalSpan = 0;
  let cinematicOrbitSpanHeights = false;
  /** Camera-controls must not consume the same touch drag as the transform gizmo. */
  const syncCameraControlsEnabled = (): void => {
    controls.enabled = !nearL0HoldActive && !gizmoDragging && !cinematicOrbitWasMoving;
  };
  const noteCinematicOrbitInteraction = (): void => {
    if (!cinematicOrbitPlaying) return;
    cinematicOrbitLastInteraction = performance.now();
    cinematicOrbitWasMoving = false;
    syncCameraControlsEnabled();
  };
  const cinematicOrbitPointers = new Set<number>();
  const noteCinematicOrbitPointerDown = (event: PointerEvent): void => {
    cinematicOrbitPointers.add(event.pointerId);
    noteCinematicOrbitInteraction();
  };
  const noteCinematicOrbitPointerMove = (event: PointerEvent): void => {
    if (cinematicOrbitPointers.has(event.pointerId)) noteCinematicOrbitInteraction();
  };
  const noteCinematicOrbitPointerEnd = (event: PointerEvent): void => {
    if (!cinematicOrbitPointers.delete(event.pointerId)) return;
    noteCinematicOrbitInteraction();
  };
  // Capture runs before camera-controls' own handlers, unlocking manual input
  // on the very event that interrupts the automatic move. Moves and releases
  // keep the idle timer behind the entire gesture, including long touch drags.
  renderer.domElement.addEventListener('pointerdown', noteCinematicOrbitPointerDown, true);
  renderer.domElement.addEventListener('pointermove', noteCinematicOrbitPointerMove, true);
  renderer.domElement.addEventListener('pointerup', noteCinematicOrbitPointerEnd, true);
  renderer.domElement.addEventListener('pointercancel', noteCinematicOrbitPointerEnd, true);
  renderer.domElement.addEventListener('wheel', noteCinematicOrbitInteraction, true);
  window.addEventListener('keydown', noteCinematicOrbitInteraction, true);
  window.addEventListener('keyup', noteCinematicOrbitInteraction, true);
  let nearL0RevealFadeUntil = 0;
  let sceneNote = '';
  let updateEffects: ((elapsed: number) => void) | null = null;
  let paintTool: PaintTool | null = null;
  let separateTool: SeparateTool | null = null;
  /** Which click tool is armed; see the tool picker in the bottom chrome. */
  let pointerTool: ViewerTool = 'none';
  /** Where a tool hangs its own controls, once the picker has mounted. */
  let toolSlot: HTMLElement | null = null;
  let brushRadius = 0;
  let lastPickedPoint: THREE.Vector3 | null = null;
  let benchmarkGroundY: number | null = null;
  /** Wired after the effect picker mounts; syncs the DoF focus slider. */
  let syncDofFocusSlider:
    ((state: { visible: boolean; value?: number; min?: number; max?: number }) => void) | null =
    null;
  let syncWarpIntensitySlider: ((state: { visible: boolean; value?: number }) => void) | null =
    null;
  /** Shows/hides the relight option once a cast mesh is known. */
  let syncRelightModeVisible: ((visible: boolean) => void) | null = null;
  let liveWarp: WorldWarpPreset | null = null;

  // ?effects=… attaches SplatModifiers to exercise the M7 hook contract on
  // whichever scene is loaded. The picker switches this live (see setEffect).
  //   demo     - opacity pulse + height tint (M7.2)
  //   paint    - click to paint a per-splat mask channel (M7.3/M7.6)
  //   sdf      - 16 animated SDF shapes tint/desaturate/hide/rim (M7.4)
  //   relight  - PlayCanvas-style proxy-mesh screen-space relight (collision mesh)
  //   reveal   - wgslFn value-noise dissolve, WebGPU-only (M7.5)
  //   warp     - planet / bowl wrap (worldWarpPreset)
  //   lod      - false-color by resident LOD level (red=finest … blue=coarse)
  //   distance  - false-color by camera distance (same band edges as LCC LODs)
  // `?tool=paint` is enough to arm paint without a separate effects value.
  let effectMode = params.get('effects') ?? (toolFromUrl === 'paint' ? 'paint' : null);
  /** Parks the visual effect while paint owns the stack; cleared on a local pick. */
  let parkedEffect: string | null = effectMode === 'paint' ? null : effectMode;
  // `defineChannel` throws on a redefinition, so a streamed scene's mask is
  // defined once however many times paint is toggled.
  let streamedMaskDefined = false;

  /** Collision tiles kept for the relight effect (physics world is separate). */
  let collisionTilesForRelight: readonly CollisionMeshTile[] | null = null;
  /**
   * Optional lighting proxy from `?proxy=<url>` (e.g. splat-transform
   * `.collision.glb`). Already Y-up — do not bake the LCC matrix again.
   */
  let relightExternalGeometries: THREE.BufferGeometry[] | null = null;
  let relightProxyLoadSeq = 0;
  /** True after `?proxy=` fails so the effect option can hide. */
  let relightProxyFailed = false;
  const relightProxyUrl = params.get('proxy');
  /** Dropped once a local file/folder is picked so `?proxy=` does not follow it. */
  let useUrlRelightProxy = relightProxyUrl !== null;
  /**
   * After a local pick, ignore the outgoing mesh's collision until the new
   * scene's `attachCollision` runs.
   */
  let suppressStaleRelightOption = false;
  let relightProxy: RelightingProxy | null = null;
  let relightScene: THREE.Scene | null = null;
  let relightTarget: THREE.RenderTarget | null = null;
  let relightSun: THREE.DirectionalLight | null = null;
  let relightMidSun: THREE.DirectionalLight | null = null;
  let relightOuterSun: THREE.DirectionalLight | null = null;
  let relightFarSun: THREE.DirectionalLight | null = null;
  /** Shadow-factor material owned by the demo (proxy group borrows it). */
  let relightFactorMaterial: THREE.MeshStandardNodeMaterial | null = null;
  let relightOrbitRadius = 8;
  /** Ortho half-extent of the far (scene-sized) sun shadow map. */
  let relightShadowRadius = 80;
  /** Ortho half-extent of the inner (close) cascade. */
  let relightNearRadius = 20;
  /** Ortho half-extent of the mid cascade. */
  let relightMidRadius = 50;
  /** Ortho half-extent of the outer cascade (before scene-sized far). */
  let relightOuterRadius = 160;
  const relightSunDir = new THREE.Vector3();
  const relightShadowFocus = new THREE.Vector3();
  const relightNearFocus = new THREE.Vector3();
  const relightMidFocus = new THREE.Vector3();
  const relightOuterFocus = new THREE.Vector3();
  const relightCamForward = new THREE.Vector3();
  const relightLightSpace = new THREE.Vector3();
  const relightSnapDelta = new THREE.Vector3();
  const relightShadowOrigin = new THREE.Vector3();
  const relightClearColor = new THREE.Color();
  const relightSize = new THREE.Vector2();
  const relightBoundsSize = new THREE.Vector3();

  /**
   * Relight needs triangles that can cast/receive shadows: either a
   * loaded `?proxy=` mesh or LCC collision tiles (or a scene that ships them).
   */
  const relightCastMeshAvailable = (): boolean => {
    if ((relightExternalGeometries?.length ?? 0) > 0) return true;
    if ((collisionTilesForRelight?.length ?? 0) > 0) return true;
    if (
      !suppressStaleRelightOption &&
      mounted &&
      splats instanceof StreamedSplatMesh &&
      splats.hasCollisionMeshes
    ) {
      return true;
    }
    // Deep-link with ?proxy=…: keep the option visible while the GLB loads.
    if (
      useUrlRelightProxy &&
      relightProxyUrl &&
      !relightProxyFailed &&
      relightExternalGeometries === null
    ) {
      return true;
    }
    // Chrome mounts before the first scene; do not wipe `?effects=relight` yet.
    if (!mounted && effectMode === 'relight') return true;
    return false;
  };

  const refreshRelightEffectOption = (): void => {
    syncRelightModeVisible?.(relightCastMeshAvailable());
  };

  const teardownRelight = (): void => {
    if (mounted) splats.setRelighting(null);
    relightFactorMaterial?.dispose();
    relightFactorMaterial = null;
    relightProxy?.dispose();
    relightProxy = null;
    relightSun?.dispose();
    relightMidSun?.dispose();
    relightOuterSun?.dispose();
    relightFarSun?.dispose();
    relightSun = null;
    relightMidSun = null;
    relightOuterSun = null;
    relightFarSun = null;
    relightScene = null;
    relightTarget?.dispose();
    relightTarget = null;
    renderer.shadowMap.enabled = false;
  };

  const ensureRelightTarget = (): THREE.RenderTarget => {
    if (!relightTarget) {
      relightTarget = new THREE.RenderTarget(1, 1, {
        depthBuffer: true,
        type: THREE.HalfFloatType,
      });
      // Lighting is evaluated in linear working space; match the renderer.
      relightTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
      relightTarget.texture.minFilter = THREE.LinearFilter;
      relightTarget.texture.magFilter = THREE.LinearFilter;
      relightTarget.texture.generateMipmaps = false;
    }
    renderer.getDrawingBufferSize(relightSize);
    // Full-res so orbiting shadow maps stay sharp; coverage edges are softened
    // in-shader via `softness` (see setRelighting).
    relightTarget.setSize(
      Math.max(1, Math.floor(relightSize.x)),
      Math.max(1, Math.floor(relightSize.y)),
    );
    return relightTarget;
  };

  const setupRelight = (mesh: SplatMesh): void => {
    teardownRelight();
    setEffectModifiers([]);
    const useExternal = relightExternalGeometries !== null && relightExternalGeometries.length > 0;
    if (!useExternal && (!collisionTilesForRelight || collisionTilesForRelight.length === 0)) {
      console.warn(
        relightProxyUrl
          ? `Relight: still loading ${relightProxyUrl} (or load failed).`
          : 'Relight needs collision meshes or ?proxy=<glb|gltf url>.',
      );
      updateEffects = null;
      return;
    }
    mesh.updateWorldMatrix(true, false);
    // External splat-transform GLB is already Y-up world geometry. LCC
    // collision tiles are source-local and need mesh.matrixWorld baked in.
    if (useExternal) {
      relightProxy = createRelightingProxy({
        geometries: relightExternalGeometries!,
        albedo: 1,
      });
      console.info(`Relight using ?proxy=${relightProxyUrl}`);
    } else {
      relightProxy = createRelightingProxy({
        tiles: collisionTilesForRelight!,
        matrixWorld: mesh.matrixWorld.clone(),
        albedo: 1,
      });
    }
    relightScene = new THREE.Scene();
    relightScene.add(relightProxy.group);

    const bounds = new THREE.Box3().setFromObject(relightProxy.group);
    const splatBounds = mesh.computeSplatBounds().clone().applyMatrix4(mesh.matrixWorld);
    if (bounds.isEmpty()) bounds.copy(splatBounds);
    else if (!splatBounds.isEmpty()) bounds.union(splatBounds);
    bounds.getCenter(relightShadowFocus);
    bounds.getSize(relightBoundsSize);
    const extent = Math.max(relightBoundsSize.x, relightBoundsSize.y, relightBoundsSize.z, 1);
    relightOrbitRadius = Math.max(extent * 0.85, 2);
    // Cover the full proxy + splat bounds. Slope-gated receive keeps foliage
    // from sparkling; a camera-fitted box was clipping umbras past ~20–140 m.
    // A light-space axis can combine horizontal and vertical extents. The
    // half-diagonal encloses the box for every sun angle; max(XZ, Y) does not.
    relightShadowRadius = Math.max(relightBoundsSize.length() * 0.5, 8) * 1.1;
    relightNearRadius = 20;
    relightMidRadius = 50;
    // Blend to scene starts at ~0.7×outerRadius — keep that past 100 m so the
    // mid/outer band does not sample the coarse scene map early.
    relightOuterRadius = 160;

    const configureSun = (
      light: THREE.DirectionalLight,
      mapSize: number,
      bias: number,
      normalBias: number,
    ): void => {
      light.castShadow = true;
      light.shadow.mapSize.set(mapSize, mapSize);
      light.shadow.bias = bias;
      light.shadow.normalBias = normalBias;
      light.shadow.radius = 2;
      relightScene!.add(light);
      relightScene!.add(light.target);
    };

    const relightSunColor = new THREE.Color(0xffa040);

    relightSun = new THREE.DirectionalLight(relightSunColor, 1);
    configureSun(relightSun, 2048, -0.002, 0.12);
    relightMidSun = new THREE.DirectionalLight(relightSunColor, 1);
    configureSun(relightMidSun, 2048, -0.0025, 0.2);
    relightOuterSun = new THREE.DirectionalLight(relightSunColor, 1);
    configureSun(relightOuterSun, 4096, -0.003, 0.22);
    relightFarSun = new THREE.DirectionalLight(relightSunColor, 1);
    const farTexel = (2 * relightShadowRadius) / 2048;
    configureSun(relightFarSun, 2048, -0.004, Math.max(0.35, farTexel * 1.5));

    relightFactorMaterial = createRelightingShadowFactorMaterial(relightSun, {
      umbra: 0.5,
      color: relightSunColor,
      diffuse: 0.8,
      direction: relightSunDir,
      nearRadius: relightNearRadius,
      midLight: relightMidSun,
      midRadius: relightMidRadius,
      outerLight: relightOuterSun,
      outerRadius: relightOuterRadius,
      farLight: relightFarSun,
    });
    relightFactorMaterial.side = THREE.FrontSide;
    relightProxy.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.material = relightFactorMaterial!;
      obj.castShadow = true;
      obj.receiveShadow = true;
    });

    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const placeSun = (
      light: THREE.DirectionalLight,
      focus: THREE.Vector3,
      radius: number,
      distance: number,
    ): void => {
      light.position.copy(focus).addScaledVector(relightSunDir, distance);
      light.target.position.copy(focus);
      light.target.updateMatrixWorld();
      light.updateMatrixWorld();
      const shadowCam = light.shadow.camera;
      shadowCam.left = -radius;
      shadowCam.right = radius;
      shadowCam.top = radius;
      shadowCam.bottom = -radius;
      shadowCam.near = 0.5;
      shadowCam.far = distance + radius;
      shadowCam.updateProjectionMatrix();
      light.shadow.updateMatrices(light);
      const texel = (2 * radius) / Math.max(light.shadow.mapSize.x, 1);
      relightLightSpace.copy(focus).applyMatrix4(shadowCam.matrixWorldInverse);
      const snappedX = Math.round(relightLightSpace.x / texel) * texel;
      const snappedY = Math.round(relightLightSpace.y / texel) * texel;
      relightShadowOrigin.set(0, 0, 0).applyMatrix4(shadowCam.matrixWorld);
      relightSnapDelta
        .set(relightLightSpace.x - snappedX, relightLightSpace.y - snappedY, 0)
        .applyMatrix4(shadowCam.matrixWorld)
        .sub(relightShadowOrigin);
      light.position.add(relightSnapDelta);
      light.target.position.add(relightSnapDelta);
      light.target.updateMatrixWorld();
    };

    const applyRelightSun = (elapsed: number): void => {
      if (!relightSun || !relightMidSun || !relightOuterSun || !relightFarSun) return;
      const angle = elapsed * 0.05625;
      relightSunDir.set(Math.cos(angle), 0.75, Math.sin(angle)).normalize();
      camera.getWorldDirection(relightCamForward);
      relightNearFocus
        .copy(camera.position)
        .addScaledVector(relightCamForward, relightNearRadius * 0.55);
      relightMidFocus
        .copy(camera.position)
        .addScaledVector(relightCamForward, relightMidRadius * 0.55);
      relightOuterFocus
        .copy(camera.position)
        .addScaledVector(relightCamForward, relightOuterRadius * 0.55);
      const innerDist = Math.max(relightOrbitRadius * 0.2, relightNearRadius * 2);
      const midDist = Math.max(relightOrbitRadius * 0.35, relightMidRadius * 2);
      const outerDist = Math.max(relightOrbitRadius * 0.5, relightOuterRadius * 2);
      const farDist = Math.max(relightOrbitRadius, relightShadowRadius * 2);
      placeSun(relightSun, relightNearFocus, relightNearRadius, innerDist);
      placeSun(relightMidSun, relightMidFocus, relightMidRadius, midDist);
      placeSun(relightOuterSun, relightOuterFocus, relightOuterRadius, outerDist);
      placeSun(relightFarSun, relightShadowFocus, relightShadowRadius, farDist);
    };
    applyRelightSun(0);

    const target = ensureRelightTarget();
    mesh.setRelighting({
      map: target.texture,
      blend: 1,
      brightness: 1,
      background: 1,
      softness: 2,
    });
    updateEffects = (t) => {
      applyRelightSun(t);
    };
  };

  /** Load `?proxy=` GLB/GLTF meshes for lighting (test hook; not a product path). */
  const loadRelightProxyUrl = (url: string): void => {
    const seq = ++relightProxyLoadSeq;
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        if (seq !== relightProxyLoadSeq) return;
        const geometries: THREE.BufferGeometry[] = [];
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((obj) => {
          if (!(obj instanceof THREE.Mesh)) return;
          // instanceof erases Mesh type params, so geometry is `any` until recast.
          const mesh = obj as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
          if (!mesh.geometry) return;
          // Bake node transform so createRelightingProxy can leave matrixWorld unset.
          const geo = mesh.geometry.clone();
          geo.applyMatrix4(mesh.matrixWorld);
          geometries.push(geo);
        });
        if (geometries.length === 0) {
          console.warn(`Relight: no meshes in ${url}`);
          return;
        }
        for (const g of relightExternalGeometries ?? []) g.dispose();
        relightExternalGeometries = geometries;
        relightProxyFailed = false;
        refreshRelightEffectOption();
        if (effectMode === 'relight' && mounted) setupRelight(splats);
      },
      undefined,
      (err) => {
        console.warn(`Relight: failed to load ${url}`, err);
        relightProxyFailed = true;
        refreshRelightEffectOption();
      },
    );
  };
  if (relightProxyUrl) loadRelightProxyUrl(relightProxyUrl);

  const renderRelightPass = (): void => {
    if (effectMode !== 'relight' || !mounted || !relightScene || !relightTarget) return;
    ensureRelightTarget();
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    renderer.getClearColor(relightClearColor);
    const previousAlpha = renderer.getClearAlpha();
    try {
      renderer.setRenderTarget(relightTarget);
      // White + A0: softness samples at coverage edges must not pull in black
      // (that drew a dark outline of every collision triangle).
      renderer.setClearColor(0xffffff, 0);
      renderer.autoClear = true;
      renderer.clear(true, true, true);
      renderer.render(relightScene, camera);
    } finally {
      // Always restore the backbuffer so the gray proxy never composites onto
      // the canvas (a failed/partial RT bind would otherwise leave mesh fragments).
      renderer.setRenderTarget(previousTarget ?? null);
      renderer.setClearColor(relightClearColor, previousAlpha);
      renderer.autoClear = previousAutoClear;
    }
  };

  const lodLegend = document.createElement('div');
  lodLegend.id = 'lod-debug-legend';
  lodLegend.style.cssText =
    'position:absolute;left:12px;bottom:48px;z-index:5;pointer-events:none;max-width:min(420px,90vw)';
  container.appendChild(lodLegend);
  const syncLodLegend = (): void => {
    if (effectMode === 'lod' || effectMode === 'distance') {
      lodLegend.innerHTML = lodDebugLegendHtml(effectMode);
      lodLegend.hidden = false;
    } else {
      lodLegend.innerHTML = '';
      lodLegend.hidden = true;
    }
  };
  syncLodLegend();

  const status = document.querySelector<HTMLElement>('#status');
  const statusText = document.querySelector<HTMLElement>('#status-text');
  const statusBar = document.querySelector<HTMLElement>('#status-progress i');

  /**
   * Rewrites the bottom-left overlay from current state. Called on a 250ms timer
   * because a streamed scene's counts change every frame; a static scene's
   * line is stable but costs nothing to rewrite.
   */
  const refreshOverlay = (): void => {
    // A failure card owns the screen; `showError` clears the overlay line and
    // the timer must not paint it back underneath the card.
    if (isErrorVisible()) {
      if (chrome.overlay) overlay.textContent = '';
      return;
    }
    if (loadingTitle !== null) {
      if (chrome.overlay) overlay.textContent = `Loading ${loadingTitle}…`;
      // The pill carries the activity; the overlay line carries the name. A
      // multi-gigabyte drop spends ~15 s here, which needs a real bar rather
      // than a spinner that says only "not frozen".
      if (chrome.status && status && statusText) {
        status.classList.add('visible');
        status.classList.remove('error');
        const total = loadingProgress?.total ?? 0;
        if (loadingProgress && total > 0) {
          const fraction = Math.min(1, loadingProgress.loaded / total);
          status.classList.add('progress');
          statusText.textContent = `Reading ${formatBytes(loadingProgress.loaded)} / ${formatBytes(total)}`;
          if (statusBar) statusBar.style.width = `${Math.round(fraction * 100)}%`;
        } else {
          status.classList.remove('progress');
          statusText.textContent = 'Loading…';
        }
      }
      return;
    }
    if (
      nearL0HoldActive &&
      mounted &&
      splats instanceof StreamedSplatMesh &&
      splats.initialRevealState.status === 'pending'
    ) {
      const hold = splats.initialRevealState;
      if (chrome.overlay) overlay.textContent = 'Loading coverage…';
      if (chrome.status && status && statusText) {
        status.classList.add('visible', 'progress');
        status.classList.remove('error');
        const total = Math.max(1, hold.totalSplats);
        const fraction = Math.min(1, hold.stagedSplats / total);
        statusText.textContent =
          `Coverage ${hold.readyGroups}/${hold.totalGroups} cells · ` +
          `${hold.stagedSplats.toLocaleString('en-US')} / ${hold.totalSplats.toLocaleString('en-US')}`;
        if (statusBar) statusBar.style.width = `${Math.round(fraction * 100)}%`;
      }
      return;
    }
    if (chrome.status) status?.classList.remove('progress');
    const mesh = splats;
    if (mesh instanceof StreamedSplatMesh) {
      if (chrome.overlay) {
        overlay.textContent =
          `${sceneTitle} · ${mesh.activeSplatCount.toLocaleString('en-US')} / ` +
          `${mesh.budget.toLocaleString('en-US')} splats · ` +
          `${mesh.residentChunkCount} chunks · ${shLabel(mesh)} · ` +
          `${backendName}${fpsSuffix()}`;
      }
      if (!chrome.status || !status || !statusText) return;
      const failed = mesh.failedChunkCount;
      if (failed > 0) {
        status.classList.add('visible', 'error');
        statusText.textContent = `⚠ ${failed} chunk${failed > 1 ? 's' : ''} failed to load`;
      } else if (mesh.isStreaming) {
        status.classList.add('visible');
        status.classList.remove('error');
        const pending = mesh.pendingChunkCount;
        statusText.textContent =
          pending > 0 ? `Streaming ${pending} chunk${pending > 1 ? 's' : ''}…` : 'Streaming…';
      } else {
        status.classList.remove('visible', 'error');
      }
      return;
    }
    if (chrome.overlay) {
      overlay.textContent =
        `${sceneTitle}${sceneNote} · ${(splatData?.count ?? 0).toLocaleString('en-US')} splats · ` +
        `${shLabel(splats)} · ${backendName}${fpsSuffix()}`;
    }
    // The streaming pill belongs to the streamed path only - a dropped scene
    // replaces a streamed mesh, and would otherwise leave it stuck on screen.
    if (chrome.status) status?.classList.remove('visible', 'error');
  };

  // Pick interaction (M8.3): double-click teleports near the clicked splat;
  // paint mode also picks on a single click. Both exercise the shared async
  // GPU pick at near and far depths on WebGPU and the WebGL2 fallback.
  const teleportDirection = new THREE.Vector3();
  const teleportPosition = new THREE.Vector3();
  const teleportTarget = new THREE.Vector3();
  let teleportTransition: TeleportTransition | null = null;

  const updateTeleportTransition = (now: number): void => {
    if (!teleportTransition) return;
    const finished = sampleTeleportTransition(
      teleportTransition,
      now,
      teleportPosition,
      teleportTarget,
    );
    controls.setLookAt(
      teleportPosition.x,
      teleportPosition.y,
      teleportPosition.z,
      teleportTarget.x,
      teleportTarget.y,
      teleportTarget.z,
      false,
    );
    if (finished) teleportTransition = null;
  };

  /** One decoded scene, built and ready to put on screen. */
  interface LoadedScene {
    readonly mesh: SplatMesh;
    /** Decoded arrays for a static scene; null for a streamed one. */
    readonly data: SplatData | null;
    readonly title: string;
    /** Suffix for the overlay line, e.g. ' (paint)'. */
    readonly note: string;
    readonly paint: PaintTool | null;
    /** Source-local → world matrix for selection when the mesh is a MergedSplatMesh. */
    readonly selectionWorldMatrix?: THREE.Matrix4;
    /** Exact rendered bounds when source transforms live inside a MergedSplatMesh. */
    readonly worldBounds?: THREE.Box3;
    /** Source transforms already include host orientation/rotation/scale. */
    readonly preservesTransform?: boolean;
  }

  /**
   * Builds a static mesh from decoded data, in whichever mode is active.
   *
   * Paint is the one effect that changes how the mesh itself is built: it
   * needs a {@link SplatRange} per chunk to write the mask through, and a
   * plain `new SplatMesh(data)` keeps its range private. So paint borrows the
   * dynamic-capacity chunked path.
   */
  const buildStaticScene = (data: SplatData, title: string): LoadedScene => {
    const paintable = effectMode === 'paint';
    if (!chunked && !paintable) {
      return { mesh: new SplatMesh(data, meshOptions()), data, title, note: '', paint: null };
    }
    const mesh = new SplatMesh({ capacity: data.count + 4 * 2048 }, meshOptions()); // row-alignment headroom
    // A dynamic-capacity pool has no source format, so SplatMesh cannot
    // self-orient it - apply the same Y-up correction the whole-scene path gets.
    const correction = orientation === 'y-up' ? yUpTransformForFormat(data.format) : null;
    if (correction) {
      mesh.matrix.copy(correction);
      mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.matrixWorldNeedsUpdate = true;
    }
    const parts = splitSplatData(data, 4);
    if (paintable) {
      const chunks = parts.map((chunk) => ({ range: mesh.appendRange(chunk), data: chunk }));
      return { mesh, data, title, note: ' (paint)', paint: createPaintTool(mesh, chunks) };
    }
    for (const chunk of parts) mesh.appendRange(chunk);
    return { mesh, data, title, note: ' (4 chunks)', paint: null };
  };

  /**
   * Loads the scene's collision meshes, if it ships any, and builds a world
   * from them in the background.
   *
   * Fire-and-forget: the fetch and the BVH builds take a moment, and the
   * camera flies (uncollided) in the meantime, then starts colliding once the
   * first tiles are ready. `collisionSequence` drops a load that lands after
   * the user has already moved on to another scene.
   */
  const attachCollision = (mesh: SplatMesh): void => {
    suppressStaleRelightOption = false;
    collisionSequence++;
    collisionWorld?.dispose();
    collisionWorld = null;
    collisionTilesForRelight = null;
    walkMode = false;
    collisionToggles.setWalk(false);
    fpvWalkPending = parseFpvParam(params.get('fpv'));

    const available = mesh instanceof StreamedSplatMesh && mesh.hasCollisionMeshes;
    collisionToggles.setAvailable(available);
    refreshRelightEffectOption();
    if (!available) {
      if (effectMode === 'relight') setupRelight(mesh);
      return;
    }

    const sequence = collisionSequence;
    void mesh
      .loadCollisionMeshes()
      .then((tiles) => {
        if (sequence !== collisionSequence || tiles.length === 0) {
          refreshRelightEffectOption();
          return;
        }
        collisionTilesForRelight = tiles;
        collisionWorld = createCollisionWorld(tiles, mesh.matrixWorld, {
          buildOrderOrigin: camera.position,
        });
        refreshRelightEffectOption();
        if (effectMode === 'relight' && mounted && splats === mesh) setupRelight(mesh);
        refreshOverlay(); // the hint gains the walk/fly key
        applyWalkFromUrl();
      })
      .catch((error: unknown) => {
        console.warn('Collision meshes failed to load; flying uncollided.', error);
        refreshRelightEffectOption();
      });
  };

  /**
   * The live modifier stack, as named slots rather than a raw
   * `mesh.modifiers` assignment.
   *
   * Two independent things want the stack - the effect picker and the `?separate=1`
   * selection preview - and whichever assigned last used to silently drop the
   * other. `selection` folds last so the highlight tints over whatever the
   * effect produced. `effectExtra` exists because one preset (`demo`) ships two
   * modifiers.
   */
  const modifierSlots = new ModifierSlots(['effect', 'effectExtra', 'selection']);
  /** The mesh the slots are applied to; re-applied whenever a slot changes. */
  let modifierTarget: SplatMesh | null = null;
  const applyModifierSlots = (): void => {
    if (modifierTarget) modifierSlots.apply(modifierTarget);
  };
  /** Fills the effect slots from a preset's modifier list (0, 1 or 2 of them). */
  const setEffectModifiers = (modifiers: readonly SplatModifier[]): void => {
    modifierSlots.set('effect', modifiers[0] ?? null);
    modifierSlots.set('effectExtra', modifiers[1] ?? null);
    applyModifierSlots();
  };

  /** Attaches the current effect's modifiers; paint wires its own elsewhere. */
  const attachEffects = (mesh: SplatMesh): void => {
    const localBounds = mesh.computeSplatBounds();
    // Core DoF is independent of the modifier stack; clear it unless this mode
    // is the DoF demo so switching effects does not leave blur on.
    if (effectMode !== 'dof') {
      mesh.setDepthOfField({ aperture: 0 });
      syncDofFocusSlider?.({ visible: false });
    }
    if (effectMode !== 'warp') {
      liveWarp = null;
      syncWarpIntensitySlider?.({ visible: false });
    }
    if (effectMode !== 'relight') {
      teardownRelight();
    }
    // LOD level channel is only written while the lod effect is active.
    if (mesh instanceof StreamedSplatMesh) {
      mesh.setLodLevelDebug(effectMode === 'lod');
    }
    if (effectMode === 'demo') {
      const demo = createDemoEffects();
      setEffectModifiers(demo.modifiers);
      updateEffects = (t) => demo.update(t);
    } else if (effectMode === 'sdf') {
      const sdf = sdfEffects([], { maxShapes: 24 });
      setEffectModifiers([sdf.modifier]);
      updateEffects = (t) => sdf.setShapes(makeAnimatedSdfShapes(t, localBounds));
    } else if (effectMode === 'relight') {
      setupRelight(mesh);
    } else if (effectMode === 'reveal') {
      const reveal = revealPreset({ frequency: 6, edge: 0.06 });
      setEffectModifiers([reveal.modifier]);
      updateEffects = (t) => {
        reveal.progress.value = Math.sin(t * 0.5) * 0.5 + 0.5;
      };
    } else if (effectMode === 'warp') {
      const span = localBounds.getSize(new THREE.Vector3()).length();
      const radius = Math.max(1e-4, 0.22 * span);
      const warp = worldWarpPreset({ intensity: 0.55, radius });
      liveWarp = warp;
      setEffectModifiers([warp.modifier]);
      updateEffects = null;
      syncWarpIntensitySlider?.({ visible: true, value: warp.intensity.value });
    } else if (effectMode === 'dof') {
      // Fixed focus (no rack). Default to the view-space depth of the scene
      // center so large captures start sharp where you're looking; the focus
      // slider retunes. Aperture scales with span. Core projected-2D path.
      const span = localBounds.getSize(new THREE.Vector3()).length();
      const aperture = Math.min(0.25, Math.max(0.07, 0.22 / Math.sqrt(Math.max(span, 0.5))));
      const lookTarget = new THREE.Vector3();
      const cameraPosition = new THREE.Vector3();
      controls.getTarget(lookTarget, false);
      controls.getPosition(cameraPosition, false);
      const { focusDistance, min, max } = dofFocusRangeForMesh(
        mesh,
        localBounds,
        lookTarget,
        cameraPosition,
      );
      setEffectModifiers([]);
      mesh.setDepthOfField({ focusDistance, aperture });
      syncDofFocusSlider?.({ visible: true, value: focusDistance, min, max });
      updateEffects = null;
    } else if (effectMode === 'paint') {
      // The mask channel is defined wherever paint's tool is wired (the static
      // rebuild, or the streamed branch in applyScene); the highlight modifier
      // goes through the same slot as every other effect so the selection
      // preview survives alongside it.
      setEffectModifiers([createMaskHighlightModifier('mask')]);
      updateEffects = null;
    } else if (effectMode === 'lod') {
      // Resident LOD level: red = finest (0), … blue = coarsest. Zoom alone
      // does not change this until resident runs swap.
      setEffectModifiers([
        mesh instanceof StreamedSplatMesh
          ? createLodLevelDebugModifier()
          : createLodDistanceDebugModifier(),
      ]);
      updateEffects = null;
    } else if (effectMode === 'distance') {
      // Camera-distance bands matching classic LCC defaults (10 / 2^L metres).
      setEffectModifiers([createLodDistanceDebugModifier()]);
      updateEffects = null;
    } else {
      // Switching back to 'none' has to drop the previous effect's modifier,
      // or it would stay folded into the material.
      setEffectModifiers([]);
      updateEffects = null;
    }
    syncLodLegend();
  };

  /**
   * Wires paint on a streamed mesh. The mask lives in the persistent store
   * rather than in per-range arrays, so it survives chunk eviction and reload
   * (M7.6) - which is also why this needs no rebuild to switch on.
   */
  const wireStreamedPaint = (mesh: StreamedSplatMesh): void => {
    if (!streamedMaskDefined) {
      mesh.definePersistentChannel('mask', { type: 'byte' });
      streamedMaskDefined = true;
    }
    // Unlike the normal effect path, paint wires directly into this helper.
    // Clear a preceding core DoF effect before assigning its mask modifier.
    mesh.setDepthOfField({ aperture: 0 });
    setEffectModifiers([createMaskHighlightModifier('mask')]);
    paintTool = {
      paintAt: (point, radius) => mesh.paintPersistent('mask', point, radius, getPaintBrushIndex()),
      clear: () => mesh.clearPersistentChannel('mask'),
    };
  };

  /**
   * Puts a built scene on screen, disposing whatever it replaces. Every
   * scale-dependent value (brush and marker radii, movement speed, the SDF
   * orbit) is re-derived here, so a dropped scene of a different size behaves
   * the same as one loaded from a URL.
   *
   * @param options.frame - Fit the camera to the new scene (default). Passed
   * `false` when the mesh is rebuilt for the same scene (an effect switch),
   * where moving the viewer's camera would be jarring. `sideView` is used
   * only for the initial built-in goose, never for dropped or explicit scenes.
   */
  const applyScene = async (
    next: LoadedScene,
    options: { frame?: boolean; sideView?: boolean; keepWelcome?: boolean } = {},
  ): Promise<void> => {
    if (options.frame ?? true) perfHud?.reset();
    hudSortCount = 0;
    hudSortSince = performance.now();
    hudSortHz = 0;
    // `frame: false` already means "the same scene, rebuilt" (an effect switch,
    // or the separation tool swapping in a half) - exactly the distinction the
    // separation tool needs, so it drives the origin rather than a second flag.
    const sceneSwapOrigin = (options.frame ?? true) ? 'external' : 'self';
    if (mounted) {
      restoreXrMaterial();
      scene.remove(splats);
      splats.dispose();
      // The paint tool holds the old mesh's range handles and cannot survive
      // the swap; benchmark points likewise belong to the old scene's space.
      lastPickedPoint = null;
      benchmarkGroundY = null;
    }
    splats = next.mesh;
    // A scene can finish loading or be replaced after the XR session starts.
    // Session transitions alone are therefore insufficient to enforce the
    // stereo cap on every live streamed pool.
    applySplatBudget(next.mesh);
    splatData = next.data;
    sceneTitle = next.title;
    sceneNote = next.note;
    paintTool = next.paint;
    // Channels are per mesh, so the new one starts undefined however many
    // times paint was toggled on the old one.
    streamedMaskDefined = false;
    // The mesh already carries its base orientation: the library stood it up to
    // Y-up (`orientation: 'y-up'`, default) or left it in its source frame
    // (`?orientation=source`). `?rot=` adds a per-scene rotation on top,
    // premultiplied in world space so it composes with whatever base matrix
    // whatever base matrix the mesh has (identity, 180°-X, or the LCC Z-up matrix).
    if (!next.preservesTransform && userRotation) {
      next.mesh.matrix.premultiply(userRotation);
      next.mesh.matrix.decompose(next.mesh.position, next.mesh.quaternion, next.mesh.scale);
      next.mesh.matrixWorldNeedsUpdate = true;
    }
    // `?scale=` stacks a per-axis scale on whatever scale the mesh already
    // carries (format corrections are pure rotations, so this is usually 1).
    if (!next.preservesTransform && userScale) next.mesh.scale.multiply(userScale);
    next.mesh.updateMatrixWorld();
    scene.add(next.mesh);
    if (renderer.xr.isPresenting) {
      applyXrMaterial(next.mesh);
      placeXrDiagnosticProbe(next.mesh);
    }
    if (options.frame ?? true) suppressStreamedUpdate = true;
    mounted = true;
    if (
      next.mesh instanceof StreamedSplatMesh &&
      next.mesh.initialRevealState.status === 'pending'
    ) {
      next.mesh.visible = false;
      nearL0HoldActive = true;
    } else {
      nearL0HoldActive = false;
    }
    syncCameraControlsEnabled();
    // Re-point the slot stack before any slot is filled: the old mesh is gone,
    // and every effect/preview modifier belongs to the new one.
    modifierTarget = next.mesh;
    if (next.mesh instanceof StreamedSplatMesh && effectMode === 'paint') {
      wireStreamedPaint(next.mesh);
    } else {
      attachEffects(next.mesh);
    }

    const bounds =
      next.worldBounds ?? next.mesh.computeSplatBounds().applyMatrix4(next.mesh.matrixWorld);
    // Covariance scale separates a finely reconstructed subject from the vague
    // environment sphere emitted by object-mode mobile scans. Compute this
    // before fitting so neither the initial camera nor the cinematic orbit is
    // forced outside that expensive, mostly-background shell.
    const framing = options.sideView
      ? null
      : classifyOrbitFraming(bounds, {
          positions: next.data?.positions ?? overviewPositionsFromStreamedMesh(next.mesh),
          colors: next.data?.colors,
          covariances: next.data?.covariances,
          worldMatrix: next.mesh.matrixWorld,
          heightSamples: heightSamplesFromStreamedMesh(next.mesh, next.mesh.matrixWorld),
        });
    const cameraBounds = framing?.focusBounds ?? bounds;
    // Frame the scene: fit the camera to the splats' world-space bounds. For a
    // streamed scene this uses the manifest's root bounds (valid immediately).
    if (options.frame ?? true) {
      clearPointerInertia();
      const center = bounds.getCenter(new THREE.Vector3());
      if (options.sideView) {
        const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius || 1;
        // Set the viewing direction before fitting: a top-down fit can place
        // the camera inside the goose once that direction is changed to side-on.
        const startDistance = radius * 2;
        controls.setLookAt(
          center.x,
          center.y,
          center.z + startDistance,
          center.x,
          center.y,
          center.z,
          false,
        );
      }
      await controls.fitToBox(cameraBounds, false);
      if (options.sideView) {
        // Leave a lot more breathing room than the tight box fit so the
        // whole goose is visible, not just a close-up of part of it.
        // Compute the side-view distance from the projected box dimensions.
        // Reusing fitToBox's top-down distance is too short for this unusually
        // thin asset and can put the camera inside the splats.
        const size = bounds.getSize(new THREE.Vector3());
        const halfFovTangent = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
        const verticalDistance = (size.y * 0.5) / halfFovTangent;
        const horizontalDistance = (size.x * 0.5) / (camera.aspect * halfFovTangent);
        const distance = Math.max(verticalDistance, horizontalDistance, 1e-4) * 1.8 + size.z * 0.5;
        // The goose is best framed at eye level; CameraControls' default fit
        // looks down from above because the asset is unusually flat.
        controls.setLookAt(
          center.x,
          center.y + 0.2,
          center.z + distance,
          center.x,
          center.y + 0.2,
          center.z,
          false,
        );
      }
      // The built-in goose is a compact object with an unusually flat AABB, so
      // skip the landscape heuristic and keep the outside orbit.
      if (framing?.framing === 'landscape') {
        cinematicOrbitFraming = 'landscape';
        cinematicOrbitVerticalSpan = framing.verticalSpan;
        cinematicOrbitSpanHeights = framing.spanHeights;
        cinematicOrbitCenter.copy(framing.center);
        cinematicOrbitDistance = framing.distance;
        cinematicOrbitPhase = 0;
        evaluateOrbitalCameraPath(
          0,
          cinematicOrbitCenter,
          cinematicOrbitDistance,
          cinematicOrbitPosition,
          cinematicOrbitTarget,
          {
            framing: 'landscape',
            verticalSpan: cinematicOrbitVerticalSpan,
            spanHeights: cinematicOrbitSpanHeights,
          },
        );
        controls.setLookAt(
          cinematicOrbitPosition.x,
          cinematicOrbitPosition.y,
          cinematicOrbitPosition.z,
          cinematicOrbitTarget.x,
          cinematicOrbitTarget.y,
          cinematicOrbitTarget.z,
          false,
        );
      } else {
        cinematicOrbitFraming = 'object';
        cinematicOrbitSpanHeights = false;
        cinematicOrbitVerticalSpan =
          framing?.verticalSpan ??
          (Number.isFinite(bounds.max.y - bounds.min.y)
            ? Math.max(bounds.max.y - bounds.min.y, 0)
            : 0);
        cinematicOrbitCenter.copy(framing?.center ?? bounds.getCenter(new THREE.Vector3()));
        controls.getPosition(cinematicOrbitPosition, false);
        cinematicOrbitDistance = Math.max(
          cinematicOrbitPosition.distanceTo(cinematicOrbitCenter),
          1e-4,
        );
        const offsetX = cinematicOrbitPosition.x - cinematicOrbitCenter.x;
        const offsetZ = cinematicOrbitPosition.z - cinematicOrbitCenter.z;
        cinematicOrbitPhase = (((Math.atan2(offsetX, offsetZ) / (Math.PI * 2)) % 1) + 1) % 1;
      }
      cinematicOrbitLastInteraction = performance.now();
      cinematicOrbitWasMoving = false;
      syncCameraControlsEnabled();
    }
    const sceneRadius = bounds.getBoundingSphere(new THREE.Sphere()).radius || 1;
    movementSpeed = sceneRadius * MOVEMENT_SPEED_SCENE_RADII_PER_SECOND;
    brushRadius = sceneRadius * 0.005;
    // Roughly a shoulder's width on a room-sized capture, and clamped so a
    // huge or tiny scene still gets a sane body rather than one scaled to it.
    collisionRadius = THREE.MathUtils.clamp(sceneRadius * 0.005, 0.1, 0.4);
    attachCollision(next.mesh);
    // A framed mount is a scene change (URL load or drop). `sideView` is only
    // set for the initial built-in goose; effect rebuilds pass `frame: false`
    // and leave this flag alone.
    if (options.frame ?? true) {
      isDefaultGoose = options.sideView === true;
      // A new non-goose scene starts collapsed unless the docs CTA asked to
      // keep the file pickers open (`?welcome=1` via `keepWelcome`).
      welcomeExpanded = (options.keepWelcome ?? false) && !isDefaultGoose;
      syncWelcomePanel();
    }
    // The preview goes into its own slot, so order relative to attachEffects
    // no longer decides which one survives.
    separateTool?.onScene(
      next.mesh,
      next.data,
      sceneSwapOrigin,
      next.selectionWorldMatrix ?? next.mesh.matrixWorld,
    );
    // `onScene` re-attaches the gizmo and its volume, so the tool gating has
    // to be re-applied or a scene change would reveal them under any tool.
    syncSeparateTool();
    loadingTitle = null;
    loadingProgress = null;
    if (options.frame ?? true) {
      armStartupHoldAfterPose();
      suppressStreamedUpdate = false;
    }
    refreshOverlay();
  };

  const armStartupHoldAfterPose = (): void => {
    if (!(splats instanceof StreamedSplatMesh)) return;
    splats.recaptureInitialReveal();
    if (splats.initialRevealState.status === 'pending') {
      splats.visible = false;
      nearL0HoldActive = true;
      syncCameraControlsEnabled();
    }
  };

  // Built unconditionally now that the tool picker gates it: `?separate` used
  // to exist because the panel and its gizmo were always on screen, which is
  // exactly what picking a tool now decides. The flag survives as a way to
  // start the viewer with the tool already selected.
  if (chrome.separate) {
    separateTool = createSeparateTool({
      scene,
      camera,
      domElement: renderer.domElement,
      onGizmoDragChange: (dragging) => {
        gizmoDragging = dragging;
        // TransformGizmo and camera-controls both listen to touch pointers on
        // the canvas. Disabling camera-controls for the full handle drag keeps
        // its default touch gestures from orbiting/dollying the camera while
        // translate, rotate, or scale owns that pointer.
        syncCameraControlsEnabled();
        if (!dragging) return;
        // The gizmo's pointerdown listener is registered after this file's, so
        // a camera drag has already been armed for this very press. Cancel it:
        // no pointermove can have landed between the two handlers, so the
        // camera has not moved and now will not. Clearing the inertia matters
        // too - an in-flight orbit coast would otherwise keep spinning under
        // the drag.
        dragPointerId = null;
        dragButton = null;
        pressForward.cancel();
        clearPointerInertia();
      },
      setPreviewModifier: (modifier) => {
        modifierSlots.set('selection', modifier);
        applyModifierSlots();
      },
      canSeparate: () => effectMode !== 'paint',
      commit: async (partition) => {
        // `MergedSplatMesh` combines both halves in one pool and sort, so their
        // splats interleave correctly while the inside source animates.
        const placement = splats.matrixWorld.clone();
        const rowCapacity = (count: number): number =>
          Math.ceil(count / SPLAT_POOL_ROW_WIDTH) * SPLAT_POOL_ROW_WIDTH;
        const separated = new MergedSplatMesh({
          ...meshOptions(),
          capacity: rowCapacity(partition.outside.count) + rowCapacity(partition.inside.count),
          maxSources: 2,
        });
        separated.addSource(partition.outside, placement, { orientation: 'source' });
        const partId = separated.addSource(partition.inside, placement, { orientation: 'source' });
        const worldBounds = new THREE.Box3()
          .setFromArray(partition.outside.positions)
          .union(new THREE.Box3().setFromArray(partition.inside.positions))
          .applyMatrix4(placement);
        await applyScene(
          {
            mesh: separated,
            data: partition.outside,
            title: sceneTitle,
            note: ' (separated)',
            paint: null,
            selectionWorldMatrix: placement,
            worldBounds,
            preservesTransform: true,
          },
          { frame: false },
        );
        return {
          transform: placement,
          setTransform: (transform) => separated.setSourceTransform(partId, transform),
        };
      },
      restore: async (data) => {
        await applyScene(buildStaticScene(data, sceneTitle), { frame: false });
      },
    });
  }

  /**
   * Switches the effect on the live scene - no reload, and no refetch or
   * redecode of the splats.
   *
   * Most effects are a modifier swap, which `SplatMesh.modifiers` handles by
   * rebuilding the material. Paint is the exception on a static scene: it
   * needs per-range handles the current mesh may not have, so entering or
   * leaving it rebuilds the mesh from the data we already decoded, keeping the
   * camera where the viewer left it.
   */
  const setEffect = async (mode: string | null): Promise<void> => {
    if (mode === effectMode || !mounted) return;
    if (separateTool?.hasSeparatedParts && (mode === 'paint' || effectMode === 'paint')) {
      console.warn('Restore the separated scene before switching to or from paint mode.');
      return;
    }
    const rebuild =
      (mode === 'paint' || effectMode === 'paint') && !(splats instanceof StreamedSplatMesh);
    effectMode = mode;
    if (rebuild && splatData) {
      await applyScene(buildStaticScene(splatData, sceneTitle), { frame: false });
      return;
    }
    if (splats instanceof StreamedSplatMesh && mode === 'paint') {
      wireStreamedPaint(splats);
    } else {
      paintTool = null;
      attachEffects(splats);
    }
    separateTool?.refresh();
    refreshOverlay();
  };

  // Drag and drop a local splat file anywhere on the window to view it. The
  // file is decoded in the loading worker and never leaves the device.
  //
  // Registered before the first scene loads, not after: with no drop listener
  // the browser answers a drop by navigating away to the file, and the seconds
  // spent decoding the initial scene are exactly when an eager viewer drops
  // theirs. A drop that lands first simply wins - see the sequence guard.
  let dropSequence = 0;
  // Set once a dropped scene is actually on screen, so the initial URL scene
  // does not mount on top of it when its own load finishes.
  let dropMounted = false;
  /** Picker UI sync assigned once the chrome exists; a drop during first load skips it. */
  let applyPickerReset: (() => void) | null = null;
  /** True after a local pick so chrome that mounts later starts at none. */
  let localPickClearedChrome = false;

  const disposeRelightExternalGeometries = (): void => {
    for (const geometry of relightExternalGeometries ?? []) geometry.dispose();
    relightExternalGeometries = null;
  };

  /**
   * A local file or folder is a new capture. Drop the previous tool, effect,
   * and any `?proxy=` lighting mesh so relight only comes back if this scene
   * ships its own collision.
   */
  const resetChromeForLocalPick = (): void => {
    localPickClearedChrome = true;
    parkedEffect = null;
    effectMode = null;
    paintTool = null;
    pointerTool = 'none';
    useUrlRelightProxy = false;
    suppressStaleRelightOption = true;
    relightProxyLoadSeq++;
    disposeRelightExternalGeometries();
    relightProxyFailed = false;
    collisionTilesForRelight = null;
    if (mounted) attachEffects(splats);
    refreshRelightEffectOption();
    applyPickerReset?.();
  };

  /**
   * Mounts one self-contained local file. Shared by the drop zone and the
   * welcome panel's file picker, so a picked scene inherits the same sequence
   * guard, progress reporting and error cards a dropped one gets.
   */
  const loadLocalFile = (file: File): void => {
    resetChromeForLocalPick();
    // A superseded drop (a second file, or one overtaken by the scene that
    // was already loading) must not resurrect its scene when it decodes.
    const sequence = ++dropSequence;
    hideError();
    // Collapses to the drop-hint line once the scene mounts (see syncWelcomePanel);
    // stays interactive for another pick until then.
    loadingTitle = file.name;
    loadingProgress = null;
    refreshOverlay();

    // A single `.rad` streams rather than decoding whole: its LOD tree can be
    // tens of millions of splats, past what one data texture holds. A blob
    // URL answers the range requests the streamed reader makes, so nothing is
    // copied - the same in-place read a dropped folder gets.
    if (file.name.toLowerCase().endsWith('.rad')) {
      const blobUrl = URL.createObjectURL(file);
      void StreamedSplatMesh.load(blobUrl, {
        format: 'rad',
        deviceProfile,
        ...(pinnedBudget === undefined ? {} : { budget: pinnedBudget }),
        ...(perfMode.enabled && pinnedBudget === undefined ? { budgetCap: PERF_MODE_BUDGET } : {}),
        ...radMeshOptions(),
      })
        .then(async (mesh) => {
          if (sequence !== dropSequence) {
            mesh.dispose();
            URL.revokeObjectURL(blobUrl);
            return;
          }
          await applyScene({
            mesh,
            data: null,
            title: file.name,
            note: '',
            paint: null,
          });
          dropMounted = true;
        })
        .catch((error: unknown) => {
          URL.revokeObjectURL(blobUrl);
          if (sequence !== dropSequence) return;
          loadingTitle = null;
          loadingProgress = null;
          refreshOverlay();
          const info = describeLoadError(error, file.name);
          showError({ title: info.title, message: info.message });
          console.error(error);
        });
      return;
    }

    void loadSplatDataFile(file, {
      onProgress: (loaded, total) => {
        // A superseded drop must not drive the bar for the one that replaced it.
        if (sequence === dropSequence) loadingProgress = { loaded, total };
      },
    })
      .then(async (data) => {
        if (sequence !== dropSequence) return;
        // A local file is shown in its own frame (raw, like Spark); any
        // reorientation comes from `?rot=`.
        await applyScene(buildStaticScene(data, file.name));
        dropMounted = true;
      })
      .catch((error: unknown) => {
        if (sequence !== dropSequence) return;
        loadingTitle = null;
        loadingProgress = null;
        refreshOverlay();
        const info = describeLoadError(error, file.name);
        showError({ title: info.title, message: info.message });
        console.error(error);
      });
  };

  /** Mounts a local scene folder. Shared by the drop zone and the folder picker. */
  const loadLocalDirectory = (files: Map<string, File>, name: string): void => {
    resetChromeForLocalPick();
    const sequence = ++dropSequence;
    hideError();
    // Collapses once mounted, same as the single-file path.
    loadingTitle = name;
    refreshOverlay();
    // A local folder streams exactly like a served one - the mesh reads
    // ranges out of the files in place, so nothing is copied or uploaded.
    void StreamedSplatMesh.loadLocal(files, {
      deviceProfile,
      environmentEnabled: params.get('env') !== '0',
      // Keep the explicit query opt-out effective now that streamed formats
      // default to a first-paint hold in the library. Unset lets `.lcc` keep
      // in-view L1-near / coarsest-far coverage, and `.lcc2` keep coarsest.
      ...(preferStartupHold ? {} : { initialReveal: 'progressive' as const }),
      ...(pinnedBudget === undefined ? {} : { budget: pinnedBudget }),
      ...(perfMode.enabled && pinnedBudget === undefined ? { budgetCap: PERF_MODE_BUDGET } : {}),
      ...(requestedShBands() === undefined
        ? perfMode.enabled
          ? { shBands: 0 as const }
          : {}
        : { shBands: requestedShBands() as 0 | 1 | 2 | 3 }),
      ...meshOptions(),
    })
      .then(async (mesh) => {
        if (sequence !== dropSequence) {
          mesh.dispose(); // superseded: stop it streaming unseen
          return;
        }
        // LCC generations self-orient via formatTransform; a streamed SOG
        // folder is shown raw (like Spark), reoriented only via `?rot=`.
        await applyScene({
          mesh,
          data: null,
          title: name,
          note: '',
          paint: null,
        });
        dropMounted = true;
      })
      .catch((error: unknown) => {
        if (sequence !== dropSequence) return;
        loadingTitle = null;
        refreshOverlay();
        const info = describeLoadError(error, name);
        showError({ title: info.title, message: info.message });
        console.error(error);
      });
  };

  if (chrome.dropZone) {
    createDropZone({
      onFile: loadLocalFile,
      onDirectory: loadLocalDirectory,
      onReject: (message) => showError({ title: 'Cannot load that drop', message }),
    });
  }

  // The welcome panel's pickers: the same two loads as a drop, reached by a
  // click. Wired here rather than with the rest of the panel because it needs
  // the loaders above, which need the renderer.
  if (chrome.welcome !== 'none') {
    const fileInput = document.querySelector<HTMLInputElement>('#welcome-file-input');
    const folderInput = document.querySelector<HTMLInputElement>('#welcome-folder-input');
    const pickFile = document.querySelector<HTMLButtonElement>('#welcome-pick-file');
    const pickFolder = document.querySelector<HTMLButtonElement>('#welcome-pick-folder');

    if (fileInput && pickFile) {
      // Built from the shared list rather than written into the HTML, so the
      // dialog's filter cannot drift from what the loader actually reads.
      fileInput.accept = SINGLE_FILE_EXTENSIONS.join(',');
      pickFile.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        // Re-picking the same file fires no `change` unless the value is
        // cleared first - a failed load could otherwise not be retried.
        fileInput.value = '';
        if (!file) return;
        // `accept` only filters the dialog; "All files" defeats it.
        if (!isSupportedSplatFile(file.name)) {
          showError({
            title: 'Cannot load that file',
            message: `"${file.name}" is not a splat file this viewer can read. Choose a ${SINGLE_FILE_LIST} file, or a folder holding a .lcc, .lcc2, .rad or lod-meta.json scene.`,
          });
          return;
        }
        loadLocalFile(file);
      });
    }

    // iOS Safari and Firefox on Android have no `webkitdirectory`; the button
    // would open a picker that cannot return a folder, so drop it entirely.
    if (folderInput && pickFolder) {
      if ('webkitdirectory' in folderInput) {
        pickFolder.addEventListener('click', () => folderInput.click());
        folderInput.addEventListener('change', () => {
          const picked = filesFromDirectoryInput(folderInput.files ?? []);
          folderInput.value = '';
          if (!picked) return;
          loadLocalDirectory(picked.files, picked.name);
        });
      } else {
        pickFolder.hidden = true;
      }
    }
  }

  if (keepWelcomeExpanded) syncWelcomePanel({ forceExpanded: true });
  refreshOverlay();
  try {
    await loadInitialScene();
  } catch (error) {
    // Not fatal to the viewer any more: the drop zone is already live and the
    // render loop below still starts, so a viewer whose ?scene= is broken can
    // drop a local file and carry on rather than being stuck on a dead page.
    const showInitialLoadError = (failed: unknown): void => {
      const info = describeLoadError(failed, sceneLabel(sceneName));
      showError({
        title: info.title,
        message: `${info.message} You can drop a local splat file to view one instead.`,
        ...(info.retryable ? { action: { label: 'Retry', onClick: () => location.reload() } } : {}),
      });
      // The panel is normally reserved for the default goose, but a `?scene=`
      // that failed is exactly when its pickers (and parked URL box) are wanted:
      // force the full panel open so a typo is one edit away from fixed.
      if (chrome.welcome !== 'none') syncWelcomePanel({ forceExpanded: true });
      console.error(failed);
    };
    if (gooseFallback && sceneName !== DEFAULT_SCENE) {
      try {
        loadingTitle = sceneLabel(DEFAULT_SCENE);
        refreshOverlay();
        const data = await loadSplatData(resolveSceneUrl(DEFAULT_SCENE), {
          onProgress: (loaded, total) => {
            if (!dropMounted) loadingProgress = { loaded, total };
          },
        });
        if (!dropMounted) {
          await applyScene(buildStaticScene(data, sceneLabel(DEFAULT_SCENE)), {
            sideView: true,
          });
        }
        usedGooseFallback = true;
        console.error(error);
      } catch (fallbackError) {
        showInitialLoadError(error);
        console.error(fallbackError);
      }
    } else {
      showInitialLoadError(error);
    }
  }
  setInterval(() => {
    if (!renderer.xr.isPresenting) refreshOverlay();
  }, 250);

  /** Loads and mounts the `?scene=` scene the page was opened with. */
  async function loadInitialScene(): Promise<void> {
    if (!streamed) {
      // `?scene=` can point at a scene as big as any drop, so it reports the
      // download the same way.
      const data = await loadSplatData(resolveSceneUrl(sceneName), {
        onProgress: (loaded, total) => {
          if (!dropMounted) loadingProgress = { loaded, total };
        },
      });
      // A still-decoding drop does not block this: it mounts, and the drop
      // replaces it on arrival - so the render loop always has a scene, even
      // if that drop turns out to be corrupt.
      if (!dropMounted) {
        await applyScene(buildStaticScene(data, sceneLabel(sceneName)), {
          sideView: isDefaultGoose,
          keepWelcome: keepWelcomeExpanded,
        });
        // applyScene syncs the welcome panel (full for goose, collapsed otherwise).
      }
      return;
    }
    // `?budget=` pins absolutely (that is what it is for, and what the A/B needs);
    // performance mode only *tightens* the library's own per-device, per-format
    // default, so it cannot overshoot the way a pinned constant did.
    const budgetCap = perfMode.enabled ? PERF_MODE_BUDGET : undefined;
    // Bounded inactive staging is the default; ?staging=0 retains the legacy A/B path.
    const experimentalStagedSwaps = params.get('staging') !== '0';
    // Unpinned, the library streams every SH band the capture carries. The
    // demo's performance mode pins the budget rather than the profile, so it
    // has to opt out of SH itself - it exists to cut exactly this cost.
    const shBands = requestedShBands() ?? (perfMode.enabled ? 0 : undefined);
    const mesh = await StreamedSplatMesh.load(resolveSceneUrl(sceneName), {
      budget: pinnedBudget,
      deviceProfile,
      ...(budgetCap === undefined ? {} : { budgetCap }),
      experimentalStagedSwaps,
      // Keep the explicit query opt-out effective now that streamed formats
      // default to a first-paint hold in the library. Unset lets `.lcc` keep
      // in-view L1-near / coarsest-far coverage, and `.lcc2` keep coarsest.
      ...(preferStartupHold ? {} : { initialReveal: 'progressive' as const }),
      // `.lcc2` ships an always-on sky; ?env=0 starts it hidden, and 'v' toggles
      // it live (see the keydown handler). Other formats have none - no effect.
      environmentEnabled: params.get('env') !== '0',
      ...(cpuCacheBytes === undefined ? {} : { cpuCacheBytes }),
      ...(swapCap === undefined ? {} : { maxSplatsPerSwap: swapCap }),
      ...(shBands === undefined ? {} : { shBands }),
      // Blob cull applies only to .rad (its coarse LOD nodes are the blobs).
      ...(sceneName.toLowerCase().endsWith('.rad') ? radMeshOptions() : meshOptions()),
      // The HUD subscribes too, not just a benchmark run: these are the only
      // per-update CPU timings a host can see (`getUpdateTimings` is protected),
      // and they are what separates an upload stall from a sort stall when the
      // 1% low collapses.
      ...(benchmarkSeconds > 0 || perfHud
        ? {
            onPerformanceEvent: (event: StreamedSplatPerformanceEvent) => {
              if (benchmarkSeconds > 0) swapPerformanceEvents.push(event);
              recordWorstUpdate(event);
            },
          }
        : {}),
    });
    // A file dropped while this was loading has already taken the screen -
    // mounting now would replace it. Nothing referenced the mesh yet, so
    // dispose it here or its chunk loader would keep streaming unseen.
    if (dropMounted) {
      mesh.dispose();
    } else {
      await applyScene(
        {
          mesh,
          data: null,
          title: sceneLabel(sceneName),
          note: '',
          paint: null,
        },
        { keepWelcome: keepWelcomeExpanded },
      );
    }
  }

  // Shareable / benchmark view. Applied *after* applyScene's fitToBox so the
  // URL pose wins. The streamed `initialReveal` hold freezes its coverage set
  // on the first update() after this - do not move URL assignment earlier than
  // framing or the hold would capture the fitted camera instead.
  const benchmarkCameraPosition = parseVector3Param(params.get('cameraPosition'));
  const benchmarkCameraTarget = parseVector3Param(params.get('cameraTarget'));
  // The docs CTA camera is framed for Dehaar; skip it if goose had to stand in.
  if (!usedGooseFallback && benchmarkCameraPosition && benchmarkCameraTarget) {
    controls.setLookAt(
      benchmarkCameraPosition.x,
      benchmarkCameraPosition.y,
      benchmarkCameraPosition.z,
      benchmarkCameraTarget.x,
      benchmarkCameraTarget.y,
      benchmarkCameraTarget.z,
      false,
    );
    armStartupHoldAfterPose();
  }

  /** NDC (-1..1, y up) for a pointer event on the canvas. */
  const eventNdc = (e: { clientX: number; clientY: number }): THREE.Vector2 => {
    const rect = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    );
  };

  const teleportRaycaster = new THREE.Raycaster();
  let lastTeleportAt = -Infinity;
  const teleportToPointer = (e: { clientX: number; clientY: number }): void => {
    if (!mounted) return;
    const rect = renderer.domElement.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    ) {
      return;
    }
    const now = performance.now();
    if (now - lastTeleportAt < 100) return;
    teleportRaycaster.setFromCamera(eventNdc(e), camera);
    const hit = splats.queryRay(teleportRaycaster.ray);
    if (!hit) return;
    lastTeleportAt = now;
    teleportDirection.subVectors(hit.point, camera.position);
    if (teleportDirection.lengthSq() < 1e-8) return;
    teleportDirection.normalize();
    teleportPosition.copy(hit.point).addScaledVector(teleportDirection, -TELEPORT_DISTANCE);
    lastPickedPoint = hit.point.clone();
    markNearestSplat(hit.point);
    // Landing three units short of a picked splat can still be inside the
    // wall behind it, so the arrival is resolved like any other move.
    if (collisionActive()) {
      (collisionWorld as CollisionWorld).depenetrate(teleportPosition, collisionRadius);
    }
    clearPointerInertia();
    noteCinematicOrbitInteraction();
    const fromPosition = controls.getPosition(new THREE.Vector3(), false);
    const fromTarget = controls.getTarget(new THREE.Vector3(), false);
    teleportTransition = {
      startedAt: now,
      duration: TELEPORT_DURATION_MS,
      from: { position: fromPosition, target: fromTarget },
      to: { position: teleportPosition.clone(), target: hit.point.clone() },
    };
  };
  window.addEventListener('dblclick', teleportToPointer, true);

  // Touch never gets a reliable `dblclick` (mobile browsers swallow it for the
  // double-tap-zoom gesture), so the same teleport is driven off a hand-rolled
  // double-tap: two short, near-stationary taps close together in time and space.
  // Listen in *capture* so the recognizer runs before `setPointerCapture` on
  // the bubble pointerdown path. WebKit often dispatches `pointercancel`
  // synchronously from capture, which used to wipe the tap before `begin()`.
  const doubleTap = new DoubleTapDetector();
  const onTouchDoubleTap = (
    event: PointerEvent,
    phase: 'down' | 'move' | 'up' | 'cancel',
  ): void => {
    if (event.pointerType !== 'touch') return;
    const now = performance.now();
    let hit = false;
    if (phase === 'down') {
      hit = doubleTap.begin(event.pointerId, event.clientX, event.clientY, now);
    } else if (phase === 'move') {
      doubleTap.move(event.pointerId, event.clientX, event.clientY);
    } else if (phase === 'up') {
      hit = doubleTap.end(event.pointerId, event.clientX, event.clientY, now);
    } else {
      hit = doubleTap.cancel(event.pointerId, event.clientX, event.clientY, now);
    }
    if (!hit) return;
    event.preventDefault();
    teleportToPointer(event);
  };
  window.addEventListener('pointerdown', (e) => onTouchDoubleTap(e, 'down'), true);
  window.addEventListener('pointermove', (e) => onTouchDoubleTap(e, 'move'), true);
  window.addEventListener('pointerup', (e) => onTouchDoubleTap(e, 'up'), true);
  window.addEventListener('pointercancel', (e) => onTouchDoubleTap(e, 'cancel'), true);
  // Some iOS versions omit part of the pointer sequence but still synthesize
  // a click with detail 2. It is a last-resort recognizer, not another GPU pick.
  window.addEventListener(
    'click',
    (event) => {
      if (event.detail === 2) teleportToPointer(event);
    },
    true,
  );
  // The second `touchstart` fires before `pointerdown`. Without this, iOS can
  // still treat the pair as page zoom even when `touch-action` is none.
  window.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length !== 1) return;
      const touch = event.changedTouches[0];
      if (
        touch !== undefined &&
        doubleTap.isSecondTap(touch.clientX, touch.clientY, performance.now())
      ) {
        event.preventDefault();
      }
    },
    { capture: true, passive: false },
  );

  // Paint spray vs camera: on LMB down in paint mode, a pick classifies the
  // press. Hit a splat → spray for the whole hold (camera locked). Miss →
  // normal orbit/look for the whole hold (never paints).
  let sprayPointerId: number | null = null;
  let pendingPaintClassifyId: number | null = null;
  const sprayClient = new THREE.Vector2();
  let sprayPickInFlight = false;
  const lastSprayPoint = new THREE.Vector3();
  let hasLastSprayPoint = false;

  const currentPaintRadius = (): number =>
    brushRadius * (isDefaultGoose && effectMode === 'paint' ? 5 : 1);

  const stopSpray = (pointerId?: number): void => {
    if (pointerId !== undefined) {
      if (pendingPaintClassifyId === pointerId) pendingPaintClassifyId = null;
      if (sprayPointerId !== pointerId) return;
    }
    sprayPointerId = null;
    hasLastSprayPoint = false;
  };

  const sprayPaintAtCursor = (): void => {
    if (sprayPointerId === null || !mounted || !paintTool || sprayPickInFlight) return;
    sprayPickInFlight = true;
    const ndc = eventNdc({ clientX: sprayClient.x, clientY: sprayClient.y });
    void splats
      .pick(ndc, camera, renderer)
      .then((hit) => {
        sprayPickInFlight = false;
        // Button may have been released, or paint mode switched, while the
        // async pick was in flight.
        if (sprayPointerId === null || !paintTool || !hit) return;
        if (hasLastSprayPoint && lastSprayPoint.distanceToSquared(hit.point) < 1e-12) return;
        lastSprayPoint.copy(hit.point);
        hasLastSprayPoint = true;
        lastPickedPoint = hit.point.clone();
        paintTool.paintAt(hit.point, currentPaintRadius());
      })
      .catch(() => {
        sprayPickInFlight = false;
      });
  };

  renderer.domElement.addEventListener('pointerdown', (e) => {
    // `gizmoDragging`: this listener is registered after the separation gizmo's,
    // so it still fires on a handle grab - without the guard the classify pick
    // below would spray paint through the drag.
    if (e.button !== 0 || !paintTool || !mounted || gizmoDragging) return;
    const pointerId = e.pointerId;
    sprayClient.set(e.clientX, e.clientY);
    pendingPaintClassifyId = pointerId;
    void splats
      .pick(eventNdc(e), camera, renderer)
      .then((hit) => {
        if (pendingPaintClassifyId !== pointerId) return;
        pendingPaintClassifyId = null;
        if (!paintTool) return;
        if (hit) {
          // Paint this press; camera drag stays unset for the hold.
          sprayPointerId = pointerId;
          hasLastSprayPoint = false;
          lastSprayPoint.copy(hit.point);
          hasLastSprayPoint = true;
          lastPickedPoint = hit.point.clone();
          paintTool.paintAt(hit.point, currentPaintRadius());
        } else {
          // Miss: hand the remainder of the press to camera controls.
          dragPointerId = pointerId;
          dragButton = 0;
          lastDragPointer.copy(sprayClient);
        }
      })
      .catch(() => {
        if (pendingPaintClassifyId !== pointerId) return;
        pendingPaintClassifyId = null;
        dragPointerId = pointerId;
        dragButton = 0;
        lastDragPointer.copy(sprayClient);
      });
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (e.pointerId !== sprayPointerId && e.pointerId !== pendingPaintClassifyId) return;
    sprayClient.set(e.clientX, e.clientY);
  });
  renderer.domElement.addEventListener('pointerup', (e) => stopSpray(e.pointerId));
  renderer.domElement.addEventListener('pointercancel', (e) => stopSpray(e.pointerId));
  renderer.domElement.addEventListener('lostpointercapture', (e) => stopSpray(e.pointerId));

  // --- annotate / measure -------------------------------------------------
  //
  // Both are click tools over the same GPU pick the paint brush uses, and both
  // are showcases for docs examples (site/examples/annotations.md and
  // surface-queries.md). They act on pointer *up*, and only when the pointer
  // barely moved: a press that turned into an orbit is a camera gesture, and
  // stealing it would make the scene feel stuck.
  const annotationLayer = document.createElement('div');
  annotationLayer.id = 'annotations';
  document.body.appendChild(annotationLayer);

  const annotations: { point: THREE.Vector3; element: HTMLElement; covered: boolean }[] = [];
  const measurePoints: THREE.Vector3[] = [];
  let measureLine: THREE.Line | null = null;
  const measureReadout = document.createElement('span');
  measureReadout.className = 'tool-readout';

  // Hover-preview state. Declared up here because clearMeasure() touches it and
  // runs during tool setup, before the pointer handlers below exist.
  let previewPending = false;
  let previewQueued = false;
  const previewNdc = new THREE.Vector2();

  const clearAnnotations = (): void => {
    for (const { element } of annotations) element.remove();
    annotations.length = 0;
  };

  const clearMeasure = (): void => {
    measurePoints.length = 0;
    if (measureLine) {
      scene.remove(measureLine);
      measureLine.geometry.dispose();
      (measureLine.material as THREE.Material).dispose();
      measureLine = null;
    }
    // A pick may still be in flight; its guard on measurePoints.length keeps it
    // from resurrecting the line, but the queued follow-up would be wasted work.
    previewQueued = false;
    measureReadout.textContent = 'click two points';
  };

  /**
   * Draws (or moves) the single measure line. Preview and committed states share
   * one object: the second click only has to overwrite the geometry the hover
   * preview was already showing, so the line never jumps.
   */
  const setMeasureLine = (a: THREE.Vector3, b: THREE.Vector3, preview: boolean): void => {
    if (!measureLine) {
      measureLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicNodeMaterial({ color: 0xffaa33, transparent: true }),
      );
      scene.add(measureLine);
    } else {
      measureLine.geometry.setFromPoints([a, b]);
    }
    (measureLine.material as THREE.Material).opacity = preview ? 0.5 : 1;
    measureLine.visible = true;
  };

  /** Hides the rubber band without tearing it down - the cursor usually comes back. */
  const hideMeasurePreview = (): void => {
    if (measureLine && measurePoints.length === 1) measureLine.visible = false;
  };

  const addAnnotation = (point: THREE.Vector3): void => {
    const element = document.createElement('div');
    element.className = 'annotation';
    element.textContent = `${annotations.length + 1}`;
    annotationLayer.appendChild(element);
    annotations.push({ point: point.clone(), element, covered: false });
  };

  const addMeasurePoint = (point: THREE.Vector3): void => {
    if (measurePoints.length === 2) clearMeasure();
    measurePoints.push(point.clone());
    if (measurePoints.length === 2) {
      const [a, b] = measurePoints as [THREE.Vector3, THREE.Vector3];
      setMeasureLine(a, b, false);
      measureReadout.textContent = `${a.distanceTo(b).toFixed(3)} units apart`;
    } else {
      measureReadout.textContent = 'click the second point';
    }
  };

  /**
   * The separation gizmo, its wireframe volume and its selection tint belong
   * to one tool, but they live in the 3D scene rather than in the panel - so
   * hiding the panel is not enough. Re-asserted after every scene change,
   * because `onScene` re-attaches all three.
   */
  // A function declaration, not a const arrow: `applyScene` is defined earlier
  // in this scope and calls it during the very first load, which a const would
  // meet in its temporal dead zone.
  function syncSeparateTool(): void {
    if (!separateTool) return;
    const active = pointerTool === 'select';
    separateTool.setInteractive(active);
    separateTool.volumeAnchor.visible = active;
    if (!active) {
      // Drop the tint too: a highlight with no visible volume is unexplainable.
      modifierSlots.set('selection', null);
      applyModifierSlots();
    } else if (mounted) {
      // Rebinding restores the preview modifier the line above cleared, and
      // 'self' keeps the placement the user already set.
      separateTool.onScene(splats, splatData, 'self', splats.matrixWorld);
    }
  }

  /** Arms one click tool and tears down whatever the last one left on screen. */
  const setPointerTool = (tool: ViewerTool): void => {
    pointerTool = tool;
    if (tool !== 'annotate') clearAnnotations();
    if (tool !== 'measure') clearMeasure();
    if (toolSlot) {
      toolSlot.replaceChildren(...(tool === 'measure' ? [measureReadout] : []));
      if (tool === 'measure') clearMeasure();
    }
    syncSeparateTool();
  };

  let toolPointerId: number | null = null;
  const toolPressAt = new THREE.Vector2();

  /**
   * The hover pick behind the measure rubber band. It self-coalesces: at most
   * one is ever in flight, and a cursor that moved meanwhile re-runs it once
   * with the latest position. SplatPicker serializes picks internally, so
   * enqueueing one per pointermove would build a backlog of stale readbacks.
   */
  const runPreviewPick = async (): Promise<void> => {
    previewPending = true;
    try {
      const hit = await splats.pick(previewNdc.clone(), camera, renderer, {
        alphaThreshold: 0.1,
      });
      // The tool may have changed, or the measurement been committed, in flight.
      if (pointerTool === 'measure' && measurePoints.length === 1) {
        if (hit) setMeasureLine(measurePoints[0] as THREE.Vector3, hit.point, true);
        else hideMeasurePreview();
      }
    } catch {
      /* a pick that failed is not worth a message here */
    }
    previewPending = false;
    if (previewQueued) {
      previewQueued = false;
      void runPreviewPick();
    }
  };

  renderer.domElement.addEventListener('pointermove', (e) => {
    if (pointerTool !== 'measure' || !mounted || measurePoints.length !== 1) return;
    // A pointer that is down is a camera gesture or a pending click, not a hover.
    if (toolPointerId !== null || gizmoDragging) return;
    previewNdc.copy(eventNdc(e));
    if (previewPending) previewQueued = true;
    else void runPreviewPick();
  });

  renderer.domElement.addEventListener('pointerleave', () => {
    previewQueued = false;
    hideMeasurePreview();
  });

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !mounted || gizmoDragging) return;
    if (pointerTool !== 'annotate' && pointerTool !== 'measure') return;
    toolPointerId = e.pointerId;
    toolPressAt.set(e.clientX, e.clientY);
  });

  renderer.domElement.addEventListener('pointerup', (e) => {
    if (e.pointerId !== toolPointerId) return;
    toolPointerId = null;
    // 4px of slop: a deliberate click, not the start of an orbit.
    if (toolPressAt.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 4) return;
    const tool = pointerTool;
    void splats
      .pick(eventNdc(e), camera, renderer, { alphaThreshold: 0.1 })
      .then((hit) => {
        // The tool may have changed while the pick was in flight.
        if (!hit || pointerTool !== tool) return;
        lastPickedPoint = hit.point.clone();
        if (tool === 'annotate') addAnnotation(hit.point);
        else if (tool === 'measure') addMeasurePoint(hit.point);
      })
      .catch(() => {
        /* a pick that failed is not worth a message here */
      });
  });

  const projected = new THREE.Vector3();
  const annotationNdc = new THREE.Vector2();
  // Occlusion is a GPU pick per label, so it is amortised: one label per frame,
  // round-robin, never more than one in flight. Ten labels at 60fps is six
  // rechecks a second each - faster than the eye reads a label as stale - and
  // the cost is fixed however many labels exist.
  let nextOcclusionCheck = 0;
  let occlusionPickInFlight = false;

  const checkOneAnnotationOcclusion = (): void => {
    if (occlusionPickInFlight || annotations.length === 0 || !mounted) return;
    const annotation = annotations[nextOcclusionCheck % annotations.length];
    nextOcclusionCheck++;
    if (!annotation) return;

    projected.copy(annotation.point).project(camera);
    if (projected.z > 1) return; // behind the camera; already hidden
    annotationNdc.set(projected.x, projected.y);

    const distance = camera.position.distanceTo(annotation.point);
    occlusionPickInFlight = true;
    void splats
      .pick(annotationNdc, camera, renderer, { alphaThreshold: 0.1 })
      .then((hit) => {
        // Something solid nearer than the pinned point means the capture is in
        // the way. The tolerance stops the point's own surface hiding it.
        annotation.covered = hit !== null && hit.distance < distance - 0.02;
      })
      .catch(() => {
        /* a failed pick leaves the last verdict standing */
      })
      .finally(() => {
        occlusionPickInFlight = false;
      });
  };

  /** Per frame: keep the labels over their points. Cheap - no GPU work here. */
  const updateAnnotationOverlay = (): void => {
    if (annotations.length === 0) return;
    const { clientWidth: width, clientHeight: height } = renderer.domElement;
    for (const { point, element, covered } of annotations) {
      projected.copy(point).project(camera);
      // z > 1 is behind the camera, where the projected x/y are mirrored.
      element.style.opacity = projected.z > 1 || covered ? '0' : '1';
      element.style.transform =
        `translate(-50%, -50%) translate(` +
        `${(projected.x * 0.5 + 0.5) * width}px, ${(-projected.y * 0.5 + 0.5) * height}px)`;
    }
    checkOneAnnotationOcclusion();
  };

  window.addEventListener('keydown', (e) => {
    // Single-letter shortcuts: never while a text field has focus, or typing a
    // URL into the welcome box would clear the paint and toggle the sky.
    if (isEditableTarget(e.target)) return;
    if (e.key === 'c' || e.key === 'C') paintTool?.clear();
    // 'v' toggles the .lcc2 environment/background tile (M12).
    if (
      (e.key === 'v' || e.key === 'V') &&
      splats instanceof StreamedSplatMesh &&
      splats.hasEnvironment
    ) {
      splats.setEnvironmentEnabled(!splats.environmentEnabled);
    }
    if ((e.key === 'g' || e.key === 'G') && lastPickedPoint) {
      benchmarkGroundY = lastPickedPoint.y;
    }
    if ((e.key === 'p' || e.key === 'P') && lastPickedPoint) {
      const eyeY = (benchmarkGroundY ?? lastPickedPoint.y) + 1.7;
      const centerX = lastPickedPoint.x + 2.5;
      const centerZ = lastPickedPoint.z + 2.5;
      // Benchmark pose: eye-level orbit around the latest picked street point.
      controls.setLookAt(centerX + 0.75, eyeY, centerZ + 0.75, centerX, eyeY, centerZ, true);
    }
    if ((e.key === 'b' || e.key === 'B') && benchmarkSeconds > 0) {
      benchmark = createFrameBenchmark(Number(params.get('warmupSeconds')) || 15, benchmarkSeconds);
      lastTimestampResolveAt = -Infinity;
      latestComputeGpuMs = undefined;
      latestRenderGpuMs = undefined;
      if (benchmarkOutput) benchmarkOutput.textContent = '';
      console.info('FRAME_BENCHMARK_STARTED');
    }
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    perfHud?.reset();
    if (mirrorDemo) sizeMirrorTarget();
  });

  // M9 spatial-query demo overlay (?query=1). A green marker snaps to the
  // nearest resident splat under the last pick (queryNearest); an amber ring
  // tracks the floor probed straight down from the camera each frame
  // (queryHeight) - a floor probe running across a streamed scene as its LOD
  // churns, with no GPU round-trip and no collision mesh.
  const spatialQueryDemo = params.get('query') === '1';
  const nearestMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x33ff88, depthTest: false }),
  );
  const floorMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.22, 0.36, 28),
    new THREE.MeshBasicMaterial({ color: 0xffaa33, side: THREE.DoubleSide, depthTest: false }),
  );
  floorMarker.rotation.x = -Math.PI / 2;
  for (const marker of [nearestMarker, floorMarker]) {
    marker.renderOrder = 999;
    marker.visible = false;
    if (spatialQueryDemo) scene.add(marker);
  }
  const _probeOrigin = new THREE.Vector3();
  const updateFloorProbe = (): void => {
    if (!spatialQueryDemo) return;
    camera.getWorldPosition(_probeOrigin);
    const hit = splats.queryHeight(_probeOrigin, 10, 1.5);
    floorMarker.visible = hit !== null;
    if (hit) floorMarker.position.copy(hit.point);
  };
  const markNearestSplat = (worldPoint: THREE.Vector3): void => {
    if (!spatialQueryDemo) return;
    const hit = splats.queryNearest(worldPoint, 2);
    nearestMarker.visible = hit !== null;
    if (hit) {
      nearestMarker.position.copy(hit.point);
      console.info(`queryNearest: ${hit.distance.toFixed(3)} m to nearest resident splat`);
    }
  };

  // M10 multi-view demo (?mirror=1). A horizontal mirror plane at the scene
  // floor shows the splats reflected - a second camera per frame, sorted
  // correctly for its own view via SplatMesh.renderView into a render target.
  // The plane samples that target by screen position (as a planar reflector
  // does), so the reflection lines up under the real geometry.
  const mirrorDemo = params.get('mirror') === '1';
  const mirrorTarget = new THREE.RenderTarget(1, 1, { depthBuffer: true });
  const mirrorCamera = new THREE.PerspectiveCamera();
  mirrorCamera.matrixAutoUpdate = false;
  const mirrorReflection = new THREE.Matrix4();
  const mirrorPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    (() => {
      const material = new THREE.NodeMaterial();
      material.colorNode = tslTexture(mirrorTarget.texture, screenUV);
      material.transparent = false;
      return material;
    })(),
  );
  mirrorPlane.rotation.x = -Math.PI / 2;
  mirrorPlane.visible = false;
  let mirrorHeight = 0;
  let mirrorConfiguredMesh: unknown = null;
  const sizeMirrorTarget = (): void => {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    mirrorTarget.setSize(Math.max(1, size.x), Math.max(1, size.y));
  };
  if (mirrorDemo) {
    scene.add(mirrorPlane);
    sizeMirrorTarget();
  }
  const configureMirrorForScene = (): boolean => {
    if (!mirrorDemo || !mounted) return false;
    // Put the mirror plane at the scene's floor, sized to span it. The mesh's
    // geometry is one instanced unit quad, so Box3.setFromObject would measure
    // a ~2-unit box at the origin regardless of content - the splat bounds
    // (local, so mapped through matrixWorld) are the real extent. A streamed
    // scene reports its manifest bounds before any chunk is resident.
    splats.updateWorldMatrix(true, false);
    const bounds = splats.computeSplatBounds().applyMatrix4(splats.matrixWorld);
    if (bounds.isEmpty()) return false;
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    mirrorHeight = bounds.min.y;
    const span = Math.max(size.x, size.z) * 1.5 || 1;
    mirrorPlane.position.set(center.x, mirrorHeight, center.z);
    mirrorPlane.scale.set(span, span, 1);
    mirrorPlane.visible = true;
    // Reflection across the horizontal plane y = mirrorHeight. No oblique
    // near-plane clipping: content below the plane would reflect too, but the
    // plane sits at the scene floor so there is (usually) none.
    mirrorReflection.set(1, 0, 0, 0, 0, -1, 0, 2 * mirrorHeight, 0, 0, 1, 0, 0, 0, 0, 1);
    return true;
  };
  const renderMirror = (): void => {
    if (!mirrorDemo || !mounted) return;
    if (mirrorConfiguredMesh !== splats) {
      // First frame of a newly mounted scene; a static mesh has empty bounds
      // until its first append, so keep retrying until configuration lands.
      if (configureMirrorForScene()) mirrorConfiguredMesh = splats;
    }
    if (!mirrorPlane.visible) return;
    // Mirror camera = main camera reflected across the floor plane, same lens.
    mirrorCamera.matrixWorld.multiplyMatrices(mirrorReflection, camera.matrixWorld);
    mirrorCamera.matrixWorldInverse.copy(mirrorCamera.matrixWorld).invert();
    mirrorCamera.projectionMatrix.copy(camera.projectionMatrix);
    mirrorCamera.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    mirrorPlane.visible = false; // don't reflect the mirror into itself
    try {
      splats.renderView(mirrorCamera, renderer, mirrorTarget);
    } finally {
      // A failed secondary render is surfaced by the frame loop, but must not
      // permanently hide the plane if the host later recovers or remounts.
      mirrorPlane.visible = true;
    }
  };

  const timer = new THREE.Timer();
  const drawingBufferSize = new THREE.Vector2();
  let fatalFrame = false;
  renderer.setAnimationLoop((timestamp) => {
    if (deviceLost || fatalFrame) return;
    const cpuFrameStartedAt = performance.now();
    timer.update();
    const frameDelta = timer.getDelta();
    if (
      adaptiveDpr &&
      pinnedPixelRatio === null &&
      !perfMode.enabled &&
      // In VR the canvas pixel ratio is irrelevant (rendering targets the XR
      // framebuffer) and resizing it mid-session would only churn the DOM.
      !renderer.xr.isPresenting &&
      Number.isFinite(frameDelta) &&
      frameDelta > 0
    ) {
      const suggestion = suggestAdaptivePixelRatio({
        frameMs: frameDelta * 1000,
        current: adaptivePixelRatio,
        max: pixelRatioCeiling(),
        emaMs: adaptiveEmaMs,
        warmupRemaining: adaptiveWarmupRemaining,
      });
      adaptiveEmaMs = suggestion.emaMs;
      adaptiveWarmupRemaining = suggestion.warmupRemaining;
      if (suggestion.pixelRatio !== adaptivePixelRatio) {
        adaptivePixelRatio = suggestion.pixelRatio;
        renderer.setPixelRatio(adaptivePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
      }
    }
    // While presenting, the headset owns the camera's transform (three
    // overwrites it from the viewer pose each frame) and that transform is
    // rig-local. Desktop controls writing into it would fight the runtime and
    // shift the world under the viewer, so they idle until the session ends;
    // the rig carries the position instead.
    const presenting = renderer.xr.isPresenting;
    if (presenting && xrPlacementPending && xrCameraState) {
      // The first XR animation frame is the earliest point at which the
      // runtime has supplied a real local-floor head pose. Resolve it once
      // against an identity rig, cancel that pose into the saved desktop eye
      // transform, then refresh three's head matrices against the placed rig.
      renderer.xr.updateCamera(camera);
      const head = renderer.xr.getCamera();
      if (head.cameras.length > 0) {
        alignXrRigToCamera(xrRig, head, xrCameraState.worldMatrix);
        renderer.xr.updateCamera(camera);
        xrPlacementPending = false;
      }
    }
    if (!presenting) {
      updateTeleportTransition(performance.now());
      const orbitBlend = cinematicOrbitPlaying
        ? cinematicOrbitBlend((performance.now() - cinematicOrbitLastInteraction) / 1000)
        : 0;
      if (orbitBlend > 0 && mounted && !nearL0HoldActive) {
        if (!cinematicOrbitWasMoving) {
          controls.getPosition(cinematicOrbitResumePosition, false);
          controls.getTarget(cinematicOrbitResumeTarget, false);
          cinematicOrbitDistance = baseDistanceForOrbitalCameraPath(
            cinematicOrbitPhase,
            Math.max(cinematicOrbitResumePosition.distanceTo(cinematicOrbitResumeTarget), 1e-4),
            {
              framing: cinematicOrbitFraming,
              verticalSpan: cinematicOrbitVerticalSpan,
              spanHeights: cinematicOrbitSpanHeights,
            },
          );
          cinematicOrbitWasMoving = true;
          syncCameraControlsEnabled();
        }
        cinematicOrbitPhase =
          (cinematicOrbitPhase + (frameDelta * orbitBlend) / CINEMATIC_ORBIT_DURATION) % 1;
        evaluateOrbitalCameraPath(
          cinematicOrbitPhase,
          cinematicOrbitCenter,
          cinematicOrbitDistance,
          cinematicOrbitPosition,
          cinematicOrbitTarget,
          {
            framing: cinematicOrbitFraming,
            verticalSpan: cinematicOrbitVerticalSpan,
            spanHeights: cinematicOrbitSpanHeights,
          },
        );
        cinematicOrbitPosition.lerp(cinematicOrbitResumePosition, 1 - orbitBlend);
        cinematicOrbitTarget.lerp(cinematicOrbitResumeTarget, 1 - orbitBlend);
        controls.setLookAt(
          cinematicOrbitPosition.x,
          cinematicOrbitPosition.y,
          cinematicOrbitPosition.z,
          cinematicOrbitTarget.x,
          cinematicOrbitTarget.y,
          cinematicOrbitTarget.z,
          false,
        );
      }
      if (benchmark && !gizmoDragging && !cinematicOrbitWasMoving) {
        controls.rotate(frameDelta * 0.35, 0, false);
      }
      if (!nearL0HoldActive && !gizmoDragging) {
        if (!cinematicOrbitWasMoving) updatePointerInertia(frameDelta);
        controls.update(frameDelta);
      }
      // camera-controls writes camera.position/quaternion here but not
      // matrixWorld (only renderer.render() does, at the end of the frame).
      // updateMovement below derives its forward/right axes from matrixWorld,
      // so without this it reads last frame's rotation - and commitCameraMove
      // bakes that stale axis back in as the new target. The result is a
      // self-sustaining one-frame ping-pong between the true orientation and a
      // stale one: invisible while the mouse keeps dragging (each pointermove
      // re-syncs both sides before they can diverge), but a small persistent
      // left-right shake the moment you release the mouse and keep moving.
      camera.updateMatrixWorld();
      if (!nearL0HoldActive && !cinematicOrbitWasMoving && !teleportTransition) {
        updateMovement(frameDelta);
      }
    }
    updateEffects?.(timer.getElapsed());
    // The floor probe follows the desktop camera's world position, which is
    // rig-local (and runtime-driven) while presenting.
    if (mounted && !presenting && !nearL0HoldActive) updateFloorProbe();
    // Spray only after a press classified as a splat hit (camera stays locked).
    if (!presenting && sprayPointerId !== null) sprayPaintAtCursor();
    try {
      // Render the mirror view first: it sorts the shared order buffer for the
      // reflected camera, and the main update() below then re-sorts for the
      // primary camera (renderView marks the order foreign), so each view draws
      // in its own depth order.
      // Skip the mirror in VR: renderView re-sorts the shared order buffer for
      // the mirror camera, which would fight the cyclopean order both eyes share.
      if (mounted && !presenting && !nearL0HoldActive) renderMirror();
      if (mounted && !presenting && !nearL0HoldActive) renderRelightPass();
      // `mounted` is false only when the initial scene failed to load: keep
      // drawing the empty scene so a dropped file has a live loop to land in.
      if (mounted && !presenting) separateTool?.update(timer.getElapsed());
      if (mounted && !suppressStreamedUpdate) {
        const sortThisFrame =
          !presenting || backendName !== 'WebGL2' || xrSortCadence.shouldAttempt(timestamp);
        splats.update(camera, renderer, sortThisFrame ? undefined : XR_SKIP_SORT_OPTIONS);
      }
      if (mounted && splats instanceof StreamedSplatMesh && nearL0HoldActive) {
        const reveal = splats.initialRevealState;
        if (reveal.status === 'pending') {
          splats.visible = false;
          if (!presenting) refreshOverlay();
        } else {
          // ready or degraded: reveal and unlock. Fade the overlay briefly.
          splats.visible = true;
          nearL0HoldActive = false;
          syncCameraControlsEnabled();
          nearL0RevealFadeUntil = performance.now() + 150;
          if (reveal.status === 'degraded') {
            console.warn(
              `Startup hold degraded (${reveal.reason}); resuming progressive streaming.`,
            );
          }
          if (!presenting) refreshOverlay();
        }
      }
      if (!presenting && nearL0RevealFadeUntil > 0) {
        const remaining = nearL0RevealFadeUntil - performance.now();
        if (chrome.overlay) {
          if (remaining <= 0) {
            overlay.style.opacity = '';
            nearL0RevealFadeUntil = 0;
          } else {
            overlay.style.opacity = String(Math.max(0, remaining / 150));
          }
        } else if (remaining <= 0) {
          nearL0RevealFadeUntil = 0;
        }
      }
      renderer.render(scene, camera);
      // After the render, so labels use the camera the frame was drawn with.
      if (!presenting) updateAnnotationOverlay();
    } catch (error) {
      // A per-frame failure (e.g. a scene too large for the device's texture
      // limit) would otherwise spam the console and freeze the canvas. Surface
      // it once and stop the loop (M4.2/M4.4).
      fatalFrame = true;
      renderer.setAnimationLoop(null);
      showError({
        title: 'Cannot render this scene',
        message: describeLoadError(error, sceneTitle).message,
      });
      console.error(error);
      return;
    }
    const cpuFrameMs = performance.now() - cpuFrameStartedAt;
    if (presenting && xrDiagnostics) {
      xrDiagnostics.recordFrame(timestamp, cpuFrameMs);
      if (xrDiagnostics.shouldReport(timestamp)) logXrDiagnostics(false);
    }
    if (!presenting) sampleFps();
    if (perfHud && !presenting) {
      const mesh = splats;
      renderer.getDrawingBufferSize(drawingBufferSize);
      perfHud.record(
        {
          cpuFrameMs,
          activeSplats: mesh?.activeSplatCount ?? 0,
          budget: mesh instanceof StreamedSplatMesh ? mesh.budget : (mesh?.activeSplatCount ?? 0),
          ...(mesh instanceof StreamedSplatMesh ? { chunks: mesh.residentChunkCount } : {}),
          shBands: mesh?.shBands ?? 0,
          pixelRatio: renderer.getPixelRatio(),
          nativePixelRatio: window.devicePixelRatio,
          quality: perfMode.enabled ? 'SD' : 'HD',
          msaa: getRendererMsaaSamples(renderer),
          ...(mesh === undefined
            ? {}
            : { maxStdDev: mesh.maxStdDev, performanceProfile: mesh.performanceProfile }),
          ...(perfMode.enabled || pinnedPixelRatio !== null ? {} : { adaptiveDpr }),
          browser: hudBrowser,
          backend: backendName,
          physicalSize: {
            width: drawingBufferSize.x,
            height: drawingBufferSize.y,
          },
          ...(mesh === undefined
            ? {}
            : (() => {
                const sort = sampleSort(mesh, timestamp);
                return sort === undefined ? {} : { sort };
              })()),
          computeGpuMs: latestComputeGpuMs,
          renderGpuMs: latestRenderGpuMs,
          ...(mesh instanceof StreamedSplatMesh
            ? {
                worstPlanApplyMs: mesh.planTimings.worstApplyMs,
                fetchCounts: mesh.fetchCounts,
                ...(mesh.lodStats === undefined ? {} : { lodStats: mesh.lodStats }),
              }
            : {}),
          worstUpdate,
          device: hudDeviceProfile,
        },
        timestamp,
      );
    }
    // Not gated on `benchmark`: `?gpuTimestamps=1` used to do nothing at all
    // without `?benchmarkSeconds=`, which made the compute-vs-render split -
    // the one measurement that separates a sort-bound frame from a fill-bound
    // one - unreachable during ordinary use, and so unreachable on a phone.
    if (gpuTimestampsEnabled && timestamp - lastTimestampResolveAt >= 1000) {
      lastTimestampResolveAt = timestamp;
      void resolveGpuTimestamps();
    }
    const frameSwapEvents = swapPerformanceEvents;
    swapPerformanceEvents = [];
    const benchmarkResult = benchmark?.record(timestamp, frameSwapEvents);
    if (benchmarkResult && benchmarkOutput && benchmarkOutput.textContent === '') {
      benchmark = null;
      benchmarkOutput.textContent = 'resolving';
      void Promise.resolve(timestampResolvePending)
        .then(() => resolveGpuTimestamps())
        // Let the scheduler submit its immediate final-pose sort after
        // auto-rotation stops before reading the GPU order buffer.
        .then(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        )
        .then(async () => {
          const sortVerification =
            backendName === 'WebGPU' ? await verifyGpuSort(splats, camera, renderer) : undefined;
          benchmarkOutput.textContent = JSON.stringify({
            sortStrategy,
            performanceProfile,
            sortIntervalMs: sortIntervalMs ?? 'automatic',
            swapCap: swapCap ?? 32_000,
            ...benchmarkResult,
            computeGpuMs: latestComputeGpuMs,
            renderGpuMs: latestRenderGpuMs,
            sortVerification,
          });
          console.info('FRAME_BENCHMARK', benchmarkOutput.textContent);
        });
    }
  });

  if (chrome.effects) {
    // `paint` is an effect mode internally (it owns the modifier stack) but a
    // *tool* to the user, so the two pickers have to agree: entering paint
    // parks the visual effect and greys its control out, leaving paint puts
    // the parked effect back.
    const effectPicker = buildEffectPicker(
      localPickClearedChrome || effectMode === 'paint' ? null : effectMode,
      (mode) => {
        parkedEffect = mode;
        void setEffect(mode);
      },
      {
        onDofFocusInput: (focusDistance) => {
          if (effectMode !== 'dof' || !mounted) return;
          splats.setDepthOfField({ focusDistance });
        },
        onWarpIntensityInput: (intensity) => {
          if (effectMode !== 'warp' || !liveWarp) return;
          liveWarp.intensity.value = intensity;
        },
      },
    );
    const PAINT_OWNS_EFFECTS = 'Paint owns the modifier stack - switch the tool to change effects.';
    // Paint owns the stack, so `?effects=paint` wins over any other `?tool=`.
    // Otherwise honor `?tool=`, then the legacy `?separate` deep link.
    const initialTool: ViewerTool = localPickClearedChrome
      ? 'none'
      : effectMode === 'paint'
        ? 'paint'
        : (toolFromUrl ?? (separateMode ? 'select' : 'none'));
    const toolPicker = buildToolPicker(initialTool, (tool) => {
      if (tool === 'paint') {
        effectPicker.setValue(null);
        effectPicker.setEnabled(false, PAINT_OWNS_EFFECTS);
        void setEffect('paint');
        setPointerTool('paint');
        return;
      }
      effectPicker.setEnabled(true);
      // Only take the stack back from paint; every other tool leaves it alone.
      if (effectMode === 'paint') {
        effectPicker.setValue(parkedEffect);
        void setEffect(parkedEffect);
      }
      setPointerTool(tool);
    });
    if (effectMode === 'paint') effectPicker.setEnabled(false, PAINT_OWNS_EFFECTS);
    applyPickerReset = () => {
      effectPicker.setEnabled(true);
      effectPicker.setValue(null);
      toolPicker.setValue('none');
      setPointerTool('none');
    };
    // The measure readout and any future per-tool controls live here.
    toolSlot = toolPicker.slot;
    // The picker reports changes, not its starting value - arm the initial
    // tool so `?tool=` / `?separate` / a paint deep link behave like a user pick.
    setPointerTool(initialTool);
    syncDofFocusSlider = effectPicker.syncDofFocus;
    syncWarpIntensitySlider = effectPicker.syncWarpIntensity;
    syncRelightModeVisible = (visible) => effectPicker.setModeVisible('relight', visible);
    refreshRelightEffectOption();
    if (effectMode === 'dof' && mounted) {
      const bounds = splats.computeSplatBounds();
      const span = bounds.getSize(new THREE.Vector3()).length();
      const aperture = Math.min(0.25, Math.max(0.07, 0.22 / Math.sqrt(Math.max(span, 0.5))));
      const lookTarget = new THREE.Vector3();
      const cameraPosition = new THREE.Vector3();
      controls.getTarget(lookTarget, false);
      controls.getPosition(cameraPosition, false);
      const range = dofFocusRangeForMesh(splats, bounds, lookTarget, cameraPosition);
      splats.setDepthOfField({ focusDistance: range.focusDistance, aperture });
      syncDofFocusSlider({
        visible: true,
        value: range.focusDistance,
        min: range.min,
        max: range.max,
      });
    }
    if (effectMode === 'warp') {
      syncWarpIntensitySlider({ visible: true, value: 0.55 });
    }
  }

  // Performance-mode toggle. Applies live: resolution, resident budget,
  // contribution culling, Gaussian cutoff, and renderer MSAA. MSAA is not a
  // public three.js setter - `setRendererMsaa` retargets the cached sample
  // count in place so HD does not need a reload (and a file-picker scene
  // stays mounted). A pinned ?pixelRatio / ?budget / ?maxStdDev /
  // ?rendererAntialias still wins, so A/B runs stay reproducible.
  if (chrome.perfMode) {
    buildPerformanceToggle(perfMode.enabled, (enabled) => {
      perfMode.set(enabled);
      // Snap HD to the quality ceiling and restart warmup so a compile or
      // resize hitch cannot pin the drawing buffer at dpr 1 for the session.
      if (!enabled) resetAdaptivePixelRatio();
      renderer.setPixelRatio(resolvePixelRatio());
      renderer.setSize(window.innerWidth, window.innerHeight);
      if (rendererAntialiasParam === null) {
        setRendererMsaa(renderer, !enabled);
      }
      // Routed through the shared helper so a toggle *during* an immersive
      // session keeps the stereo cap instead of restoring the page budget.
      applySplatBudget();
      if (performanceProfile === undefined) {
        splats.setPerformanceProfile(enabled ? 'smooth' : 'quality');
      }
      if (pinnedMaxStdDev === undefined) {
        splats.setMaxStdDev(enabled ? PERF_MODE_MAX_STD_DEV : qualityMaxStdDev());
      }
    });
  }

  if (chrome.cinematicOrbitToggle) {
    buildCinematicOrbitToggle(cinematicOrbitPlaying, (playing) => {
      cinematicOrbitMode.set(playing);
      cinematicOrbitPlaying = playing;
      // Play starts the path now; pointer/keyboard interrupts still wait the
      // idle delay before the blend ramps back up.
      cinematicOrbitLastInteraction = playing
        ? performance.now() - (CINEMATIC_ORBIT_IDLE_DELAY + CINEMATIC_ORBIT_RAMP_DURATION) * 1000
        : performance.now();
      cinematicOrbitWasMoving = false;
      clearPointerInertia();
      syncCameraControlsEnabled();
    });
    syncCameraControlsEnabled();
  }

  // Shareable view: copies the current URL with camera pose plus the armed
  // tool / effect / FPV walk / paused orbit so a pasted link opens the same
  // looking view and chrome.
  if (chrome.copyView) {
    const sharePosition = new THREE.Vector3();
    const shareTarget = new THREE.Vector3();
    buildCopyViewButton(() => {
      controls.getPosition(sharePosition, false);
      controls.getTarget(shareTarget, false);
      return {
        position: sharePosition,
        target: shareTarget,
        tool: pointerTool,
        effect: effectMode,
        fpv: walkMode,
        orbitPlaying: cinematicOrbitPlaying,
      };
    });
  }

  // Debug handle for the browser console (prototype only). The scene-dependent
  // entries are getters: a dropped file replaces them, and a snapshot taken
  // here would pin the console to the disposed original.
  Object.assign(window, {
    __voluma: {
      THREE,
      renderer,
      scene,
      camera,
      controls,
      get splats(): SplatMesh {
        return splats;
      },
      get splatData(): SplatData | null {
        return splatData;
      },
      get updateEffects(): ((elapsed: number) => void) | null {
        return updateEffects;
      },
      get collisionWorld(): CollisionWorld | null {
        return collisionWorld;
      },
      get separateTool(): SeparateTool | null {
        return separateTool;
      },
    },
  });
  if (params.get('verifySort') === '1' && backendName === 'WebGPU') {
    const runVerification = async (): Promise<void> => {
      if (splats instanceof StreamedSplatMesh && splats.isStreaming) {
        window.setTimeout(() => void runVerification(), 250);
        return;
      }
      console.info(
        'SORT_VERIFICATION',
        JSON.stringify(await verifyGpuSort(splats, camera, renderer)),
      );
    };
    window.setTimeout(() => void runVerification(), 250);
  }
}

/**
 * "Enter VR" button, owning the session request rather than deferring to
 * three's `VRButton`.
 *
 * Two reasons it is worth the forty lines. First, the session must be asked
 * for the right features: three's `XRManager` **throws** out of `setSession`
 * when the renderer holds a WebGPU backend and the session did not enable the
 * `webgpu` feature, and `VRButton` never requests it - so on any browser with
 * both WebGPU and WebXR (a WebGPU-capable headset, or a desktop with a
 * tethered one) entering VR would fail. Requesting it as a *required* feature
 * turns that into a clean `requestSession` rejection we can explain.
 *
 * Second, `VRButton`'s click handler is `requestSession(...).then(...)` with no
 * `.catch`, and its `onSessionStarted` awaits `setSession` unguarded, so both
 * failures surface only as unhandled rejections and the button appears inert.
 *
 * three ships `examples/jsm/webxr/WebGLXRFallback.js` for the backend mismatch,
 * but it swaps the whole renderer for a WebGL one - unusable here, where every
 * pool texture, sorter and worker is bound to the construction renderer. The
 * escape hatch is a reload with `?backend=webgl` instead.
 */
function buildEnterVrButton(
  renderer: THREE.WebGPURenderer,
  onFailure: (message: string, offerWebGl: boolean) => void,
): void {
  const needsWebGpuFeature =
    (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  const sessionOptions = xrSessionInit(renderer, {
    optionalFeatures: ['local-floor', 'bounded-floor', 'layers'],
  });

  const button = document.createElement('button');
  button.id = 'enter-vr';
  button.type = 'button';
  button.textContent = 'Enter VR';
  button.title = 'View this scene in an immersive headset.';
  let session: XRSession | null = null;

  button.addEventListener('click', () => {
    if (session) {
      void session.end();
      return;
    }
    button.disabled = true;
    void (async () => {
      try {
        const next = await navigator.xr!.requestSession('immersive-vr', sessionOptions);
        next.addEventListener('end', () => {
          session = null;
          button.textContent = 'Enter VR';
        });
        await attachXrSession(next, (xrSession) => renderer.xr.setSession(xrSession));
        session = next;
        button.textContent = 'Exit VR';
      } catch (error) {
        console.error('Entering VR failed:', error);
        onFailure(
          needsWebGpuFeature
            ? 'This browser supports WebXR but not WebGPU-backed XR sessions. ' +
                'Reload with the WebGL renderer to view this scene in VR.'
            : `The headset session could not be started (${
                error instanceof Error ? error.message : 'unknown error'
              }).`,
          needsWebGpuFeature,
        );
      } finally {
        button.disabled = false;
      }
    })();
  });
  document.body.appendChild(button);
}

function buildPerformanceToggle(enabled: boolean, onChange: (enabled: boolean) => void): void {
  const button = document.createElement('button');
  button.id = 'perf-mode';
  button.type = 'button';
  const render = (value: boolean): void => {
    button.setAttribute('aria-pressed', String(value));
    button.textContent = value ? 'SD' : 'HD';
    const label = value
      ? 'SD: lower resolution, splat coverage, and MSAA for frame rate. On by default on mobile.'
      : 'HD: full resolution, splat coverage, and MSAA.';
    button.setAttribute('aria-label', label);
    button.title = label;
  };
  render(enabled);
  let current = enabled;
  button.addEventListener('click', () => {
    current = !current;
    render(current);
    onChange(current);
  });
  document.body.appendChild(button);
}

/** Play/pause control for the demo's looping cinematic camera move. */
function buildCinematicOrbitToggle(playing: boolean, onChange: (playing: boolean) => void): void {
  const button = document.createElement('button');
  button.id = 'cinematic-orbit';
  button.type = 'button';
  const render = (): void => {
    button.setAttribute('aria-pressed', String(playing));
    button.setAttribute('aria-label', playing ? 'Pause cinematic orbit' : 'Play cinematic orbit');
    button.title = playing
      ? 'Pause the cinematic camera orbit.'
      : `Play the ${CINEMATIC_ORBIT_DURATION}-second cinematic camera orbit. After a camera move it waits ${CINEMATIC_ORBIT_IDLE_DELAY} seconds before resuming.`;
    button.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>';
  };
  render();
  button.addEventListener('click', () => {
    playing = !playing;
    render();
    onChange(playing);
  });
  document.body.appendChild(button);
}

/**
 * "Copy link" (under the performance toggle). Writes the live camera pose plus
 * the armed tool / effect / FPV walk / paused cinematic orbit into the current
 * URL and copies it, so a pasted link opens the same view and chrome.
 */
function buildCopyViewButton(
  getState: () => {
    position: THREE.Vector3;
    target: THREE.Vector3;
    tool: ViewerTool;
    effect: string | null;
    fpv: boolean;
    orbitPlaying: boolean;
  },
): void {
  const button = document.createElement('button');
  button.id = 'copy-view';
  button.type = 'button';
  const defaultLabel =
    'Copy the page URL with the current camera, tool, effect, FPV walk, and orbit pause so the view can be recreated.';
  const linkIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.6 13.4a4 4 0 0 1 0-5.66l3.18-3.18a4 4 0 1 1 5.66 5.66l-1.42 1.42-1.06-1.06 1.42-1.42a2.5 2.5 0 0 0-3.54-3.54L11.66 9.8a2.5 2.5 0 0 0 0 3.54zm2.8-2.8a4 4 0 0 1 0 5.66l-3.18 3.18a4 4 0 1 1-5.66-5.66l1.42-1.42 1.06 1.06-1.42 1.42a2.5 2.5 0 0 0 3.54 3.54l3.18-3.18a2.5 2.5 0 0 0 0-3.54z"/></svg>';
  const checkIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 16.2 4.8 11.8l1.4-1.4 3 3 8.6-8.6 1.4 1.4z"/></svg>';
  const failIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.3 6.7 13 12l5.3 5.3-1.4 1.4L11.6 13.4 6.3 18.7 4.9 17.3 10.2 12 4.9 6.7 6.3 5.3l5.3 5.3 5.3-5.3z"/></svg>';
  const showIdle = (): void => {
    button.innerHTML = linkIcon;
    button.setAttribute('aria-label', defaultLabel);
    button.title = defaultLabel;
  };
  showIdle();
  let resetLabel: number | undefined;
  button.addEventListener('click', () => {
    const { position, target, tool, effect, fpv, orbitPlaying } = getState();
    const url = new URL(location.href);
    writeShareViewSearchParams(url, {
      position,
      target,
      tool,
      effect,
      fpv,
      orbitPlaying,
    });
    const href = url.toString();
    void (async () => {
      try {
        await navigator.clipboard.writeText(href);
        button.innerHTML = checkIcon;
        button.setAttribute('aria-label', 'Copied');
        button.title = 'Copied';
      } catch {
        button.innerHTML = failIcon;
        button.setAttribute('aria-label', 'Copy failed');
        button.title = 'Copy failed';
      }
      if (resetLabel !== undefined) window.clearTimeout(resetLabel);
      resetLabel = window.setTimeout(() => {
        showIdle();
        resetLabel = undefined;
      }, 1500);
    })();
  });
  document.body.appendChild(button);
}

/** The collision controls' live state, so the caller can drive them back. */
interface CollisionToggles {
  /** Shows or hides the pair - a scene without collision meshes has no use for them. */
  setAvailable(available: boolean): void;
  /** Reflects a mode change the caller made (e.g. the G key). */
  setWalk(walk: boolean): void;
}

/**
 * Collision controls (top left, under the performance toggle): whether to
 * collide at all, and whether to walk or fly. Hidden until a scene that ships
 * collision meshes is mounted, since nothing else can honor them.
 */
function buildCollisionToggles(
  onCollisionChange: (enabled: boolean) => void,
  onWalkChange: (walk: boolean) => void,
): CollisionToggles {
  const group = document.createElement('div');
  group.id = 'collision-controls';
  group.hidden = true;

  const collision = document.createElement('button');
  collision.type = 'button';
  collision.title = 'Collide the camera with the mesh this capture ships beside its splats.';
  let collisionOn = true;
  const renderCollision = (): void => {
    collision.setAttribute('aria-pressed', String(collisionOn));
    collision.textContent = `Collision: ${collisionOn ? 'on' : 'off'}`;
  };

  const walk = document.createElement('button');
  walk.type = 'button';
  walk.title = 'Walk on the collision mesh under gravity (G), or fly freely.';
  let walkOn = false;
  const renderWalk = (): void => {
    walk.setAttribute('aria-pressed', String(walkOn));
    walk.textContent = walkOn ? 'Mode: walk' : 'Mode: fly';
    // Walking without collision has no floor to stand on.
    walk.disabled = !collisionOn;
  };

  collision.addEventListener('click', () => {
    collisionOn = !collisionOn;
    renderCollision();
    renderWalk();
    onCollisionChange(collisionOn);
  });
  walk.addEventListener('click', () => {
    walkOn = !walkOn;
    renderWalk();
    onWalkChange(walkOn);
  });

  renderCollision();
  renderWalk();
  group.append(collision, walk);
  document.body.appendChild(group);

  return {
    setAvailable(available) {
      group.hidden = !available;
    },
    setWalk(value) {
      walkOn = value;
      renderWalk();
    },
  };
}

/**
 * View-space focus defaults for the DoF demo: sharp at the camera look-at
 * distance, slider spanning projected bounds (plus nearer stops for interior
 * viewpoints). Uses CameraControls getPosition/getTarget so we do not depend
 * on whether `controls.update` has already written `camera.matrixWorld`.
 */
function dofFocusRangeForMesh(
  mesh: SplatMesh,
  localBounds: THREE.Box3,
  lookTargetWorld: THREE.Vector3,
  cameraPositionWorld: THREE.Vector3,
): { focusDistance: number; min: number; max: number } {
  mesh.updateWorldMatrix(true, false);
  const world = mesh.matrixWorld;
  const corner = new THREE.Vector3();
  let near = Infinity;
  let far = 0;
  for (let i = 0; i < 8; i++) {
    corner.set(
      i & 1 ? localBounds.max.x : localBounds.min.x,
      i & 2 ? localBounds.max.y : localBounds.min.y,
      i & 4 ? localBounds.max.z : localBounds.min.z,
    );
    corner.applyMatrix4(world);
    const depth = cameraPositionWorld.distanceTo(corner);
    if (!(depth > 0)) continue;
    near = Math.min(near, depth);
    far = Math.max(far, depth);
  }
  // Look-at distance is the intended sharp plane; equals view −z when the
  // target sits on the optical axis (normal for orbit/look controls).
  const contentDepth = Math.max(1e-4, cameraPositionWorld.distanceTo(lookTargetWorld));
  if (!Number.isFinite(near) || far <= 0) {
    const span = localBounds.getSize(new THREE.Vector3()).length();
    const focusDistance = Math.max(1e-4, contentDepth || span * 0.3);
    return {
      focusDistance,
      min: Math.max(1e-4, focusDistance * 0.05),
      max: Math.max(focusDistance * 4, 1),
    };
  }
  // Interior cameras often sit inside the AABB, so the nearest front corner can
  // be far past the look-at - always allow focusing closer than that.
  const min = Math.max(1e-4, Math.min(near * 0.5, contentDepth * 0.15, 0.25));
  const max = Math.max(far * 1.25, contentDepth * 3, min * 1.01);
  const focusDistance = Math.min(max, Math.max(min, contentDepth));
  return { focusDistance, min, max };
}

/**
 * Effect switcher (bottom-right). A `<select>` rather than a button per mode:
 * the list only ever grows, and one row of buttons per effect crowded the
 * chrome off narrow viewports. `onChange` swaps the effect on the live scene,
 * so no reload - and no refetch or redecode of the splats.
 *
 * Pointer-driven modes (paint, annotate, measure, select) live in the tool
 * picker beside this one: an effect changes how the scene looks, a tool
 * changes what clicking does. `paint` is still an *effect mode* internally -
 * it owns the modifier stack - which is why {@link setEnabled} exists for the
 * tool picker to grey this control out while paint holds it.
 */
function buildEffectPicker(
  activeEffect: string | null,
  onChange: (mode: string | null) => void,
  options: {
    onDofFocusInput?: (focusDistance: number) => void;
    onWarpIntensityInput?: (intensity: number) => void;
  } = {},
): {
  element: HTMLElement;
  syncDofFocus: (state: { visible: boolean; value?: number; min?: number; max?: number }) => void;
  syncWarpIntensity: (state: { visible: boolean; value?: number }) => void;
  /** Greys the control out (paint owns the stack) and shows why on hover. */
  setEnabled: (enabled: boolean, reason?: string) => void;
  /** Reflects an effect change this picker did not originate. */
  setValue: (mode: string | null) => void;
  /**
   * Shows or hides a mode option. If the hidden mode is selected, resets to
   * "no effect" and notifies `onChange`.
   */
  setModeVisible: (mode: string, visible: boolean) => void;
} {
  const picker = document.createElement('nav');
  picker.id = 'effects';
  const modes: { label: string; mode: string | null; title: string }[] = [
    { label: 'effect', mode: null, title: 'No effect' },
    { label: 'SDF shapes', mode: 'sdf', title: '16 animated SDF shapes (M7.4)' },
    {
      label: 'relight',
      mode: 'relight',
      title: 'PlayCanvas-style proxy-mesh relight (needs LCC collision or ?proxy= mesh)',
    },
    { label: 'reveal', mode: 'reveal', title: 'wgslFn noise dissolve - WebGPU only (M7.5)' },
    {
      label: 'tiny world',
      mode: 'warp',
      title: 'Walk on the planet (positive) / stand in the bowl (negative)',
    },
    { label: 'depth of field', mode: 'dof', title: 'Depth of field via the modifier hook (M13)' },
    { label: 'pulse', mode: 'demo', title: 'Opacity pulse (breathing alpha) + height tint (M7.2)' },
    {
      label: 'LOD levels',
      mode: 'lod',
      title:
        'Resident LOD level: red=finest. Stays red until coarser runs swap in - use LOD distance to see zoom bands.',
    },
    {
      label: 'Distance',
      mode: 'distance',
      title: 'Camera distance bands: ≤10 red, ≤20 orange, ≤40 yellow, ≤80 green, else blue',
    },
  ];

  const label = document.createElement('label');
  label.className = 'label';
  const select = document.createElement('select');
  select.className = 'picker-select';
  select.setAttribute('aria-label', 'effect');
  // `null` has no string form in an <option>, so the sentinel stands in for it.
  const NONE = '\0none';
  const optionByMode = new Map<string, HTMLOptionElement>();
  for (const { label: text, mode, title } of modes) {
    const option = document.createElement('option');
    option.value = mode ?? NONE;
    option.textContent = text;
    option.title = title;
    // Relight needs cast geometry; stay hidden until the host confirms
    // collision tiles or a `?proxy=` mesh (see refreshRelightEffectOption).
    if (mode === 'relight') {
      option.hidden = true;
      option.disabled = true;
    }
    select.appendChild(option);
    if (mode !== null) optionByMode.set(mode, option);
  }
  label.appendChild(select);
  picker.appendChild(label);

  let current = activeEffect ?? null;

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'paint-color';
  colorInput.title = 'Paint color';
  colorInput.value = getPaintHighlightColorHex();
  colorInput.addEventListener('input', () => setPaintHighlightColor(colorInput.value));
  // Keep the native picker from stealing focus in a way that blocks WASD.
  colorInput.addEventListener('pointerdown', (e) => e.stopPropagation());

  const dofFocus = document.createElement('label');
  dofFocus.className = 'dof-focus';
  dofFocus.title = 'Focal distance (view-space)';
  dofFocus.hidden = true;
  const dofCaption = document.createElement('span');
  dofCaption.textContent = 'focus';
  const dofRange = document.createElement('input');
  dofRange.type = 'range';
  dofRange.min = '0.1';
  dofRange.max = '10';
  dofRange.step = 'any';
  dofRange.value = '1';
  dofRange.setAttribute('aria-label', 'Focal distance');
  const dofValue = document.createElement('output');
  dofValue.textContent = '1.00';
  const formatFocus = (v: number): string =>
    v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  const applyDofReadout = (): void => {
    dofValue.textContent = formatFocus(Number(dofRange.value));
  };
  dofRange.addEventListener('pointerdown', (e) => e.stopPropagation());
  dofRange.addEventListener('input', () => {
    applyDofReadout();
    options.onDofFocusInput?.(Number(dofRange.value));
  });
  dofFocus.appendChild(dofCaption);
  dofFocus.appendChild(dofRange);
  dofFocus.appendChild(dofValue);

  const syncDofFocus = (state: {
    visible: boolean;
    value?: number;
    min?: number;
    max?: number;
  }): void => {
    dofFocus.hidden = !state.visible;
    if (!state.visible) return;
    if (typeof state.min === 'number' && typeof state.max === 'number' && state.max > state.min) {
      dofRange.min = String(state.min);
      dofRange.max = String(state.max);
    }
    if (typeof state.value === 'number' && Number.isFinite(state.value)) {
      const min = Number(dofRange.min);
      const max = Number(dofRange.max);
      dofRange.value = String(Math.min(max, Math.max(min, state.value)));
    }
    applyDofReadout();
  };

  const warpIntensity = document.createElement('label');
  warpIntensity.className = 'warp-intensity';
  warpIntensity.title = 'Planet (positive) / bowl fold (negative)';
  warpIntensity.hidden = true;
  const warpFold = document.createElement('span');
  warpFold.textContent = 'fold';
  const warpRange = document.createElement('input');
  warpRange.type = 'range';
  warpRange.min = '-1';
  warpRange.max = '1';
  warpRange.step = 'any';
  warpRange.value = '0.55';
  warpRange.setAttribute('aria-label', 'World warp intensity');
  const warpPlanet = document.createElement('span');
  warpPlanet.textContent = 'planet';
  const warpValue = document.createElement('output');
  const formatWarp = (v: number): string => (v > 0 ? '+' : '') + v.toFixed(2);
  const applyWarpReadout = (): void => {
    warpValue.textContent = formatWarp(Number(warpRange.value));
  };
  applyWarpReadout();
  warpRange.addEventListener('pointerdown', (e) => e.stopPropagation());
  warpRange.addEventListener('input', () => {
    applyWarpReadout();
    options.onWarpIntensityInput?.(Number(warpRange.value));
  });
  warpIntensity.appendChild(warpFold);
  warpIntensity.appendChild(warpRange);
  warpIntensity.appendChild(warpPlanet);
  warpIntensity.appendChild(warpValue);

  const syncWarpIntensity = (state: { visible: boolean; value?: number }): void => {
    warpIntensity.hidden = !state.visible;
    if (!state.visible) return;
    if (typeof state.value === 'number' && Number.isFinite(state.value)) {
      warpRange.value = String(Math.min(1, Math.max(-1, state.value)));
    }
    applyWarpReadout();
  };

  const syncPaintColorVisibility = (): void => {
    colorInput.hidden = current !== 'paint';
  };

  const render = (): void => {
    select.value = current ?? NONE;
    syncPaintColorVisibility();
    if (current !== 'dof') dofFocus.hidden = true;
    if (current !== 'warp') warpIntensity.hidden = true;
  };

  select.addEventListener('change', () => {
    current = select.value === NONE ? null : select.value;
    render();
    onChange(current);
  });
  // The native dropdown takes focus; without this the keyboard flight controls
  // stop responding until the canvas is clicked again.
  select.addEventListener('pointerdown', (e) => e.stopPropagation());

  // Contextual controls for the mode that needs one. Both keep their class
  // names and `hidden` semantics - `positionStatsAboveEffects` measures them.
  const paintSlot = document.createElement('span');
  paintSlot.className = 'paint-slot';
  paintSlot.appendChild(colorInput);
  picker.appendChild(paintSlot);

  const dofSlot = document.createElement('span');
  dofSlot.className = 'dof-slot';
  dofSlot.appendChild(dofFocus);
  picker.appendChild(dofSlot);

  const warpSlot = document.createElement('span');
  warpSlot.className = 'warp-slot';
  warpSlot.appendChild(warpIntensity);
  picker.appendChild(warpSlot);

  render();
  // Prefer the bottom chrome so narrow viewports can wrap the pickers above stats.
  const chrome = document.querySelector('#bottom-chrome');
  (chrome ?? document.body).appendChild(picker);
  return {
    element: picker,
    syncDofFocus,
    syncWarpIntensity,
    setEnabled: (enabled, reason) => {
      select.disabled = !enabled;
      label.title = enabled ? '' : (reason ?? '');
    },
    setValue: (mode) => {
      current = mode;
      render();
    },
    setModeVisible: (mode, visible) => {
      const option = optionByMode.get(mode);
      if (!option) return;
      option.hidden = !visible;
      // Some browsers ignore `hidden` on <option>; also remove from layout.
      option.disabled = !visible;
      if (!visible && current === mode) {
        current = null;
        render();
        onChange(null);
        return;
      }
      // Re-apply selection after unhiding (disabled options often reject .value).
      if (visible && current === mode) render();
    },
  };
}

/** Parses a comma-separated demo camera vector; malformed values are ignored. */
function parseVector3Param(value: string | null): THREE.Vector3 | null {
  if (value === null) return null;
  const parts = value.split(',').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return new THREE.Vector3(parts[0], parts[1], parts[2]);
}

main().catch((error: unknown) => {
  // A friendly, phase-aware failure card (bad URL, unsupported format, network)
  // instead of a raw message dumped in the corner (M4.4).
  const params = new URLSearchParams(location.search);
  const label = sceneLabel(params.get('scene') ?? DEFAULT_SCENE);
  const info = describeLoadError(error, label);
  showError({
    title: info.title,
    message: info.message,
    action: info.retryable ? { label: 'Retry', onClick: () => location.reload() } : undefined,
  });
  console.error(error);
});
