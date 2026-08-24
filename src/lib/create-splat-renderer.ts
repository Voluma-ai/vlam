/**
 * One-call WebGPU renderer construction for VLAM! scenes.
 *
 * Every host needs the same four things right - adapter, device, raised limits
 * and the platform-dependent `powerPreference` - and getting any of them wrong
 * fails *late*: past ~8.4 M unified splats, or with MSAA silently dropped.
 * {@link createSplatRenderer} is that block, once.
 *
 * The primitives it composes ({@link recommendedWebGpuRequiredLimits},
 * {@link webGpuPowerPreferenceOptions}) stay exported for hosts that own device
 * creation themselves - an XR session sharing a device, say.
 */
import { WebGPURenderer, type WebGPURendererParameters } from 'three/webgpu';

import { warn } from './logging';
import {
  recommendedWebGpuRequiredLimits,
  webGpuPowerPreferenceOptions,
  type WebGpuPowerPreference,
} from './webgpu-limits';

/*
 * The WebGPU surface is declared structurally, not via `navigator.gpu`.
 * `tsconfig.lib.json` compiles `src/lib` alone (`rootDir`, and an `include`
 * listing only the published entry points), so the ambient
 * `interface Navigator { gpu?: ... }` the viewer declares is not in scope for
 * the published build. A module here that reaches for `navigator.gpu`'s type
 * passes `npm run typecheck` and fails `npm run build:lib`.
 */

/** The device handle `createSplatRenderer` hands to `WebGPURenderer`. */
export interface SplatRendererGpuDevice {
  readonly features: ReadonlySet<string>;
}

/** The adapter surface `createSplatRenderer` reads limits and features from. */
export interface SplatRendererGpuAdapter {
  readonly features: ReadonlySet<string>;
  readonly limits: {
    readonly maxStorageBufferBindingSize: number;
    readonly maxBufferSize: number;
    readonly maxTextureDimension2D?: number;
  };
  requestDevice(descriptor?: {
    requiredFeatures?: readonly string[];
    requiredLimits?: Record<string, number>;
  }): Promise<SplatRendererGpuDevice>;
}

/** The `navigator.gpu` surface `createSplatRenderer` probes. */
export interface SplatRendererGpu {
  requestAdapter(options?: {
    powerPreference?: WebGpuPowerPreference;
  }): Promise<SplatRendererGpuAdapter | null>;
}

/**
 * Options for {@link createSplatRenderer}.
 *
 * Everything `THREE.WebGPURenderer` accepts passes straight through -
 * `antialias`, `forceWebGL`, `trackTimestamp`, `canvas`, `alpha`, `samples`,
 * `getFallback`, … - except the three members the helper owns (`device`,
 * `requiredLimits`, and `powerPreference`, which is widened here to allow
 * `null`).
 */
export interface CreateSplatRendererOptions extends Omit<
  WebGPURendererParameters,
  'device' | 'requiredLimits' | 'powerPreference'
> {
  /**
   * Adapter/renderer power hint. Omitted automatically on Windows, where Chrome
   * ignores it and warns ([crbug.com/369219127](https://crbug.com/369219127)).
   * Pass `null` to never send it.
   *
   * @defaultValue `'high-performance'`
   */
  powerPreference?: WebGpuPowerPreference | null;
  /**
   * Throw instead of degrading to three's WebGL2 backend. Adapter and device
   * failures rethrow their original error, unwrapped.
   *
   * @defaultValue `false`
   */
  requireWebGpu?: boolean;
  /**
   * The WebGPU entry point to probe. Defaults to `navigator.gpu`; pass `null`
   * to skip the probe entirely (tests, non-DOM hosts).
   */
  gpu?: SplatRendererGpu | null;
}

function ambientGpu(): SplatRendererGpu | null {
  const nav = typeof navigator !== 'undefined' ? (navigator as { gpu?: unknown }) : undefined;
  const gpu = nav?.gpu;
  return gpu ? (gpu as SplatRendererGpu) : null;
}

/**
 * Creates a `THREE.WebGPURenderer` configured for splat rendering: the
 * adapter's advertised buffer/texture maxima as `requiredLimits`, every adapter
 * feature as `requiredFeatures`, and `powerPreference` only where the platform
 * honours it.
 *
 * Both raised values matter late rather than loudly. Without the limits, large
 * unified or streamed scenes throw past ~8.4 M splats. Without
 * `core-features-and-limits` among the requested features, three treats the
 * backend as compatibility-mode and **silently drops MSAA** - which is why the
 * device is requested here rather than left to `WebGPUBackend.init`. Owning the
 * request also keeps the real failure: three's `getFallback` hook logs a flat
 * "WebGPU is not available" and drops the cause.
 *
 * Degrades to three's WebGL2 backend exactly as an unconfigured
 * `new THREE.WebGPURenderer()` would, warning through
 * {@link setVlamLogHandler} when the cause was a fixable failure rather than a
 * browser without WebGPU. Pass `requireWebGpu: true` to throw instead.
 *
 * Does **not** call `setSize`, `renderer.init()`, or append the canvas - those
 * stay in host code - and does not touch `outputColorSpace`, whose three.js
 * default (sRGB) is already what the splat shader expects.
 *
 * @example
 * const renderer = await createSplatRenderer();
 * renderer.setSize(innerWidth, innerHeight);
 * document.body.appendChild(renderer.domElement);
 *
 * @throws {TypeError} if `requireWebGpu` and `forceWebGL` are both set.
 */
export async function createSplatRenderer(
  options: CreateSplatRendererOptions = {},
): Promise<WebGPURenderer> {
  const {
    powerPreference = 'high-performance',
    requireWebGpu = false,
    gpu,
    ...rendererOptions
  } = options;
  const powerOptions =
    powerPreference === null ? {} : webGpuPowerPreferenceOptions(powerPreference);

  let adapter: SplatRendererGpuAdapter | null = null;
  let device: SplatRendererGpuDevice | null = null;

  if (rendererOptions.forceWebGL === true) {
    if (requireWebGpu) {
      throw new TypeError(
        'vlam: createSplatRenderer cannot honour both requireWebGpu and forceWebGL.',
      );
    }
  } else {
    const entry = gpu === undefined ? ambientGpu() : gpu;
    if (!entry) {
      // Not a warning: a browser without WebGPU is not a fixable misconfiguration.
      if (requireWebGpu) {
        throw new Error('vlam: WebGPU is unavailable (no navigator.gpu) and requireWebGpu is set.');
      }
    } else {
      let adapterFailed = false;
      try {
        adapter = await entry.requestAdapter({ ...powerOptions });
      } catch (error) {
        if (requireWebGpu) throw error;
        // One warning per failure: an adapter that threw has already explained
        // itself, so the "no adapter" branch below must not warn again.
        adapterFailed = true;
        warn('WebGPU adapter request failed; falling back to WebGL2.', error);
      }
      if (!adapter && !adapterFailed) {
        if (requireWebGpu) {
          throw new Error('vlam: no WebGPU adapter was available and requireWebGpu is set.');
        }
        warn('No WebGPU adapter was available; falling back to WebGL2.');
      }
      if (adapter) {
        try {
          device = await adapter.requestDevice({
            // Every feature the adapter advertises. `core-features-and-limits`
            // is the one that matters: without it three treats the backend as
            // compatibility-mode and forces the sample count to 0.
            requiredFeatures: [...adapter.features],
            requiredLimits: recommendedWebGpuRequiredLimits(adapter),
          });
        } catch (error) {
          if (requireWebGpu) throw error;
          // The error object itself, not just a message: this is the value
          // three's `getFallback` swallows, and it distinguishes a fixable
          // failure (a GPU process out of memory) from an absent backend.
          warn('WebGPU device request failed; requesting limits without an owned device.', error);
        }
      }
    }
  }

  return new WebGPURenderer({
    antialias: true,
    ...rendererOptions,
    ...powerOptions,
    // Without a device, leave three to its own request - it fails the same way,
    // but the WebGL2 fallback behind it is still the right outcome.
    ...(device
      ? { device }
      : adapter
        ? { requiredLimits: recommendedWebGpuRequiredLimits(adapter) }
        : {}),
  });
}
