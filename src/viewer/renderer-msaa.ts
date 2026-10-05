/**
 * Live renderer MSAA for the demo.
 *
 * MSAA only antialiases hard-edged meshes: a splat's quad edge sits at 3σ
 * where the Gaussian is already transparent, while every blended fragment
 * still writes all four samples. Measured on an RTX 3090 (HD, 1755×963,
 * 2026-10) the splat pass dropped from ~14.2 to ~9.5 ms GPU on Tempel and from
 * ~5.6 to ~5.1 ms on a 1.8M static scene with it off, with pixel-identical
 * frames. So the demo starts without it and `createRendererMsaaPolicy` turns
 * it on only while something hard-edged is on screen.
 *
 * three.js records the sample count at construction (`_samples`) and copies it
 * onto the sRGB/tone-map intermediate render target the first time that target
 * is allocated. `_getFrameBufferTarget` then reuses that target forever, so
 * flipping `antialias` on a running `WebGPURenderer` does nothing unless both
 * the private sample count and the cached target are refreshed.
 *
 * Dropping the cache is enough: the next frame allocates a target with the new
 * sample count. Recreating the whole renderer (a new GPU device) would also
 * work, but it invalidates every mesh texture and sorter, so a local file
 * picked in this session would have to be decoded again.
 *
 * `?rendererAntialias=` still pins construction and skips this path.
 */

/** Matches three.js when `antialias: true` (see `Renderer` constructor). */
export const RENDERER_MSAA_SAMPLES = 4;

/** The three.js renderer fields this helper has to touch. */
interface RendererMsaaTarget {
  _samples: number;
  _frameBufferTargets?: Map<unknown, { dispose(): void }>;
}

/** Turns default-framebuffer MSAA on or off on an already-initialized renderer. */
export function setRendererMsaa(renderer: object, enabled: boolean): void {
  // three.js keeps `_samples` / `_frameBufferTargets` off the public type.
  const target = renderer as RendererMsaaTarget;
  const samples = enabled ? RENDERER_MSAA_SAMPLES : 0;
  if (target._samples === samples) return;
  target._samples = samples;
  const cached = target._frameBufferTargets;
  if (!cached) return;
  for (const [key, cachedTarget] of cached) {
    cachedTarget.dispose();
    cached.delete(key);
  }
}

/** Current default-framebuffer MSAA sample count, or `0` when it is off. */
export function getRendererMsaaSamples(renderer: object): number {
  const samples = (renderer as RendererMsaaTarget)._samples;
  return typeof samples === 'number' && Number.isFinite(samples) ? samples : 0;
}

/** Hard-edged overlays the demo can put on screen; each one wants MSAA while it shows. */
export type RendererMsaaReason = 'gizmo' | 'query' | 'mirror' | 'xr';

/** Switches renderer MSAA on only while a hard-edged overlay is on screen. */
export interface RendererMsaaPolicy {
  /** Marks one overlay as on or off screen and re-applies the sample count. */
  set(reason: RendererMsaaReason, active: boolean): void;
  /** Re-applies the sample count after something else changed (the HD/SD toggle). */
  sync(): void;
  /** Whether the policy currently asks for MSAA (before any pin). */
  readonly wanted: boolean;
}

export interface RendererMsaaPolicyOptions {
  /**
   * `?rendererAntialias=0/1`: the construction-time pin. When set, the policy
   * never touches the renderer so A/B runs stay reproducible.
   */
  pinned: boolean | null;
  /** Performance mode (SD) never multisamples, whatever is on screen. */
  performanceMode(): boolean;
}

/**
 * Tracks which hard-edged overlays are on screen and keeps the renderer's
 * sample count in step: 4× while at least one shows and performance mode is
 * off, 0 otherwise. Splat-only frames never pay for MSAA.
 */
export function createRendererMsaaPolicy(
  renderer: object,
  options: RendererMsaaPolicyOptions,
): RendererMsaaPolicy {
  const reasons = new Set<RendererMsaaReason>();
  const wanted = (): boolean => reasons.size > 0 && !options.performanceMode();
  const sync = (): void => {
    if (options.pinned !== null) return;
    setRendererMsaa(renderer, wanted());
  };
  return {
    set(reason, active): void {
      if (active) reasons.add(reason);
      else reasons.delete(reason);
      sync();
    },
    sync,
    get wanted(): boolean {
      return wanted();
    },
  };
}
