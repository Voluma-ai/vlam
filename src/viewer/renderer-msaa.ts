/**
 * Live renderer MSAA for the demo HD/SD toggle.
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
