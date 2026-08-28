import type { WebGPURenderer } from 'three/webgpu';

/**
 * WebGPU device limits hosts should request for VLAM beyond the spec defaults.
 *
 * The WebGPU default `maxStorageBufferBindingSize` is 128 MiB. Unified work
 * buffers and large streamed pools allocate storage attributes past that
 * (16 bytes per splat for an RGBA32F centers buffer). Desktop adapters often
 * advertise ~2 GiB, but only when those values are passed as `requiredLimits`
 * to `adapter.requestDevice()` / Three.js `WebGPURenderer`.
 *
 * `maxTextureDimension2D` is here for the same reason: the default is 8192,
 * which caps a pool at 8192 rows of {@link SPLAT_DATA_TEXTURE_WIDTH} (≈16.7 M
 * splats of *capacity*, so ≈11.2 M resident at the usual 1.5 slack). Desktop
 * adapters commonly advertise 16384 and double that ceiling for free.
 */
export interface WebGpuRequiredLimits {
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
  maxTextureDimension2D: number;
  // Assignable to the `Record<string, number>` Three.js WebGPURenderer takes
  // as `requiredLimits`, and open to further WebGPU limit names.
  [limit: string]: number;
}

/**
 * WebGPU's default `maxStorageBufferBindingSize` when the host does not raise
 * it via `requiredLimits` (128 MiB).
 */
export const WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE = 134_217_728;

/**
 * Copies the adapter's advertised buffer maxima for use as
 * `WebGPURenderer({ requiredLimits })`.
 *
 * Does not call `requestDevice` - the host owns device creation.
 */
export function recommendedWebGpuRequiredLimits(adapter: {
  limits: {
    maxStorageBufferBindingSize: number;
    maxBufferSize: number;
    maxTextureDimension2D?: number;
  };
}): WebGpuRequiredLimits {
  return {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
    // Spec minimum, so an adapter that somehow reports nothing still requests a
    // legal value rather than `undefined` (which requestDevice rejects).
    maxTextureDimension2D: adapter.limits.maxTextureDimension2D ?? 8192,
  };
}

/** Mirrors WebGPU `GPUPowerPreference` without requiring `@webgpu/types`. */
export type WebGpuPowerPreference = 'high-performance' | 'low-power';

type NavigatorPlatformProbe = Pick<Navigator, 'platform' | 'userAgent'> & {
  userAgentData?: { platform?: string };
};

/**
 * Whether the host should pass `powerPreference` to `navigator.gpu.requestAdapter`
 * / Three.js `WebGPURenderer`.
 *
 * Chrome on Windows ignores the option and logs a console warning when it is
 * present ([crbug.com/369219127](https://crbug.com/369219127)). Prefer
 * {@link webGpuPowerPreferenceOptions} so Windows hosts omit it automatically.
 */
export function supportsWebGpuPowerPreference(
  nav: NavigatorPlatformProbe | undefined = typeof navigator !== 'undefined'
    ? navigator
    : undefined,
): boolean {
  if (!nav) return true;

  const uaDataPlatform = nav.userAgentData?.platform;
  if (typeof uaDataPlatform === 'string' && uaDataPlatform.length > 0) {
    return uaDataPlatform !== 'Windows';
  }

  // `navigator.platform` is "Win32" on both 32- and 64-bit Windows browsers.
  if (/^Win/i.test(nav.platform ?? '')) return false;
  return !/Windows/i.test(nav.userAgent ?? '');
}

/**
 * Options to spread into `requestAdapter(...)` and `WebGPURenderer({...})`.
 * Empty on Windows so Chrome does not warn about an ignored `powerPreference`.
 */
export function webGpuPowerPreferenceOptions(
  powerPreference: WebGpuPowerPreference = 'high-performance',
  nav?: NavigatorPlatformProbe,
): { powerPreference: WebGpuPowerPreference } | Record<string, never> {
  return supportsWebGpuPowerPreference(nav) ? { powerPreference } : {};
}

/**
 * The renderer's WebGPU `maxStorageBufferBindingSize`, or 0 when it cannot be
 * read (WebGL2 fallback, or device not yet available). Callers skip the check
 * when 0 rather than falsely reject.
 */
export function deviceMaxStorageBufferBindingSize(renderer: WebGPURenderer): number {
  const backend = renderer.backend as
    | {
        isWebGPUBackend?: boolean;
        device?: { limits?: { maxStorageBufferBindingSize?: number } };
      }
    | undefined;
  if (backend?.isWebGPUBackend !== true) return 0;
  const limit = backend.device?.limits?.maxStorageBufferBindingSize;
  return typeof limit === 'number' && limit > 0 ? limit : 0;
}

/**
 * Throws when a planned storage buffer would exceed the device bind limit.
 * No-ops when the limit cannot be read (WebGL2 / uninitialized backend).
 */
export function assertStorageBufferFitsDevice(
  renderer: WebGPURenderer,
  byteSize: number,
  capacity: number,
): void {
  const limit = deviceMaxStorageBufferBindingSize(renderer);
  if (limit <= 0 || byteSize <= limit) return;

  const needMiB = (byteSize / (1024 * 1024)).toFixed(1);
  const limitMiB = (limit / (1024 * 1024)).toFixed(1);
  const defaultMiB = (WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE / (1024 * 1024)).toFixed(0);
  throw new Error(
    `vlam: storage buffer needs ${needMiB} MiB for ${capacity.toLocaleString('en-US')} splats, ` +
      `but device maxStorageBufferBindingSize is ${limitMiB} MiB ` +
      `(WebGPU default is ${defaultMiB}). Pass recommendedWebGpuRequiredLimits(adapter) to ` +
      `WebGPURenderer, or lower the splat budget.`,
  );
}
