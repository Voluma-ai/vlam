/**
 * One-call WebGPU renderer construction for VLAM! scenes.
 *
 * Every host needs the same four things right - adapter, device, raised limits
 * and the platform-dependent `powerPreference` - and getting any of them wrong
 * fails *late*: past ~8.4 M unified splats, or with MSAA silently dropped.
 * {@link createWebGPURenderer} is that block, once.
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

/** The device handle `createWebGPURenderer` hands to `WebGPURenderer`. */
export interface WebGPURendererGpuDevice {
  readonly features: ReadonlySet<string>;
}

/** The adapter surface `createWebGPURenderer` reads limits and features from. */
export interface WebGPURendererGpuAdapter {
  readonly features: ReadonlySet<string>;
  readonly limits: {
    readonly maxStorageBufferBindingSize: number;
    readonly maxBufferSize: number;
    readonly maxTextureDimension2D?: number;
  };
  requestDevice(descriptor?: {
    requiredFeatures?: readonly string[];
    requiredLimits?: Record<string, number>;
  }): Promise<WebGPURendererGpuDevice>;
}

/** The `navigator.gpu` surface `createWebGPURenderer` probes. */
export interface WebGPURendererGpu {
  requestAdapter(options?: {
    powerPreference?: WebGpuPowerPreference;
  }): Promise<WebGPURendererGpuAdapter | null>;
}

/**
 * Options for {@link createWebGPURenderer}.
 *
 * Everything `THREE.WebGPURenderer` accepts passes straight through -
 * `antialias`, `forceWebGL`, `trackTimestamp`, `canvas`, `alpha`, `samples`,
 * `getFallback`, … - except the three members the helper owns (`device`,
 * `requiredLimits`, and `powerPreference`, which is widened here to allow
 * `null`).
 */
export interface CreateWebGPURendererOptions extends Omit<
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
  gpu?: WebGPURendererGpu | null;
}

function ambientGpu(): WebGPURendererGpu | null {
  const nav = typeof navigator !== 'undefined' ? (navigator as { gpu?: unknown }) : undefined;
  const gpu = nav?.gpu;
  return gpu ? (gpu as WebGPURendererGpu) : null;
}

/**
 * Chromium can destroy the Dawn instance when a `GPUAdapter` is collected even
 * though the `GPUDevice` it created is still in use. Three's synchronous
 * `render()` / `compute()` path then rejects an untracked `popErrorScope` as
 * "Instance dropped". Pin the adapter on an ordinary JS owner (the renderer),
 * not only the `GPUDevice` host object: Chromium's GC of WebIDL wrappers is
 * not always tied to expandos or WeakMap keys on those wrappers.
 */
const retainedGpuAdapters = new WeakMap<object, WebGPURendererGpuAdapter>();

type GpuAdapterOwner = { __vlamGpuAdapter?: WebGPURendererGpuAdapter };

function retainGpuAdapter(owner: object, adapter: WebGPURendererGpuAdapter): void {
  retainedGpuAdapters.set(owner, adapter);
  try {
    (owner as GpuAdapterOwner).__vlamGpuAdapter = adapter;
  } catch {
    // Some GPUDevice host objects reject expandos; the WeakMap is the pin.
  }
}

/**
 * Three creates render and compute pipelines with a fire-and-forget
 * `popErrorScope().then(...)`. If Dawn has already dropped the instance
 * (adapter GC, Linux SwiftShader, dispose racing an in-flight compile), that
 * promise rejects as an unhandled "Instance dropped" instead of resolving to
 * `null` (no validation error). Swallow only that teardown; real validation
 * failures still throw.
 */
function guardDroppedInstance(device: WebGPURendererGpuDevice): void {
  const gpuDevice = device as WebGPURendererGpuDevice & {
    popErrorScope?: () => Promise<unknown>;
  };
  const popErrorScope = gpuDevice.popErrorScope;
  if (typeof popErrorScope !== 'function') return;
  const guarded = function popErrorScopeGuarded(this: unknown): Promise<unknown> {
    return Promise.resolve(popErrorScope.call(this)).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Instance dropped')) return null;
      throw error;
    });
  };
  try {
    gpuDevice.popErrorScope = guarded;
  } catch {
    // GPUDevice.popErrorScope may be non-writable; adapter retention still applies.
  }
}

/**
 * Optional convenience for creating a standard `THREE.WebGPURenderer` with
 * raised WebGPU limits. `SplatMesh` also works with a renderer constructed
 * directly by the application; this function does not return a VLAM-specific
 * renderer.
 *
 * ### What the helper adds
 *
 * | Call | Added parameters |
 * | --- | --- |
 * | `navigator.gpu.requestAdapter` | `powerPreference: 'high-performance'`, except on Windows where Chrome ignores it and warns |
 * | `adapter.requestDevice` | Every advertised adapter feature as `requiredFeatures`, plus `maxStorageBufferBindingSize`, `maxBufferSize`, and `maxTextureDimension2D` at the adapter's advertised maxima as `requiredLimits` |
 * | `new THREE.WebGPURenderer` | `antialias: true`, the supported `powerPreference`, and the requested `device` (or just the raised `requiredLimits` when device creation failed and Three.js must retry); caller options can override `antialias` |
 *
 * These settings matter late rather than loudly. Without the limits, large
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
 * ### Manual equivalent
 *
 * Applications that own renderer or device creation can apply the same
 * successful WebGPU setup themselves. The two exported helpers keep the exact
 * limit selection and Windows `powerPreference` behavior reusable:
 *
 * ```ts
 * import * as THREE from 'three/webgpu';
 * import {
 *   recommendedWebGpuRequiredLimits,
 *   webGpuPowerPreferenceOptions,
 * } from '@voluma/vlam';
 *
 * const powerOptions = webGpuPowerPreferenceOptions('high-performance');
 * const adapter = await navigator.gpu?.requestAdapter(powerOptions);
 * if (!adapter) throw new Error('WebGPU is unavailable.');
 *
 * const requiredLimits = recommendedWebGpuRequiredLimits(adapter);
 * const device = await adapter.requestDevice({
 *   requiredFeatures: [...adapter.features],
 *   requiredLimits,
 * });
 *
 * const renderer = new THREE.WebGPURenderer({
 *   antialias: true,
 *   ...powerOptions,
 *   device,
 * });
 * // Keep `adapter` on an ordinary JS object for as long as `device` is
 * // (the renderer, not only the GPUDevice host object). Chromium can reject
 * // three's pipeline-validation `popErrorScope` with "Instance dropped" if the
 * // adapter is collected first.
 * ```
 *
 * That version deliberately leaves failure policy to the application. This
 * helper instead falls back to Three.js device creation or WebGL2 unless
 * `requireWebGpu` is set, and routes recoverable warnings through
 * {@link setVlamLogHandler}.
 *
 * @example
 * const renderer = await createWebGPURenderer();
 * renderer.setSize(innerWidth, innerHeight);
 * document.body.appendChild(renderer.domElement);
 *
 * @throws {TypeError} if `requireWebGpu` and `forceWebGL` are both set.
 */
export async function createWebGPURenderer(
  options: CreateWebGPURendererOptions = {},
): Promise<WebGPURenderer> {
  const {
    powerPreference = 'high-performance',
    requireWebGpu = false,
    gpu,
    ...rendererOptions
  } = options;
  const powerOptions =
    powerPreference === null ? {} : webGpuPowerPreferenceOptions(powerPreference);

  let adapter: WebGPURendererGpuAdapter | null = null;
  let device: WebGPURendererGpuDevice | null = null;

  if (rendererOptions.forceWebGL === true) {
    if (requireWebGpu) {
      throw new TypeError(
        'vlam: createWebGPURenderer cannot honour both requireWebGpu and forceWebGL.',
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
          retainGpuAdapter(device, adapter);
          guardDroppedInstance(device);
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

  const renderer = new WebGPURenderer({
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
  // The renderer is a normal JS object, so this pin survives Chromium collecting
  // a GPUDevice wrapper even while three still holds the C++ device.
  if (adapter) retainGpuAdapter(renderer, adapter);
  return renderer;
}
