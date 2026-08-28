import { describe, expect, it } from 'vitest';
import type { WebGPURenderer } from 'three/webgpu';
import {
  WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
  assertStorageBufferFitsDevice,
  deviceMaxStorageBufferBindingSize,
  recommendedWebGpuRequiredLimits,
  supportsWebGpuPowerPreference,
  webGpuPowerPreferenceOptions,
} from '../core/webgpu-limits';
import {
  estimateLargestStorageBufferBytes,
  WORK_BUFFER_CENTERS_BYTES_PER_SPLAT,
} from '../unified/unified-work-buffer';
import { UnifiedSplatMesh } from '../unified/unified-splat-mesh';

describe('recommendedWebGpuRequiredLimits', () => {
  it('copies the adapter maxima for requestDevice requiredLimits', () => {
    expect(
      recommendedWebGpuRequiredLimits({
        limits: {
          maxStorageBufferBindingSize: 2_147_483_644,
          maxBufferSize: 2_147_483_648,
          maxTextureDimension2D: 16_384,
        },
      }),
    ).toEqual({
      maxStorageBufferBindingSize: 2_147_483_644,
      maxBufferSize: 2_147_483_648,
      // Left at WebGPU's 8192 default, a pool past 8192 rows (≈11.2M resident
      // splats) cannot create its data textures at all.
      maxTextureDimension2D: 16_384,
    });
  });

  it('falls back to the spec minimum when the adapter reports no texture limit', () => {
    // requestDevice rejects an undefined limit value, so a legal number has to
    // go out even when the probe cannot supply one.
    expect(
      recommendedWebGpuRequiredLimits({
        limits: {
          maxStorageBufferBindingSize: 2_147_483_644,
          maxBufferSize: 2_147_483_648,
        },
      }).maxTextureDimension2D,
    ).toBe(8192);
  });
});

describe('webGpuPowerPreferenceOptions', () => {
  it('keeps high-performance on non-Windows platforms', () => {
    expect(
      supportsWebGpuPowerPreference({
        platform: 'MacIntel',
        userAgent: 'Mozilla/5.0 (Macintosh)',
      }),
    ).toBe(true);
    expect(
      webGpuPowerPreferenceOptions('high-performance', {
        platform: 'Linux x86_64',
        userAgent: 'Mozilla/5.0 (X11; Linux)',
      }),
    ).toEqual({ powerPreference: 'high-performance' });
  });

  it('omits powerPreference on Windows to avoid the Chrome warning', () => {
    expect(
      supportsWebGpuPowerPreference({
        platform: 'Win32',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      }),
    ).toBe(false);
    expect(
      webGpuPowerPreferenceOptions('high-performance', {
        platform: 'Win32',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      }),
    ).toEqual({});
    expect(
      supportsWebGpuPowerPreference({
        platform: 'Linux',
        userAgent: 'Mozilla/5.0',
        userAgentData: { platform: 'Windows' },
      }),
    ).toBe(false);
  });
});

describe('estimateLargestStorageBufferBytes', () => {
  it('sizes the unified centers buffer at 16 bytes per splat', () => {
    expect(estimateLargestStorageBufferBytes(0)).toBe(0);
    expect(estimateLargestStorageBufferBytes(1)).toBe(WORK_BUFFER_CENTERS_BYTES_PER_SPLAT);
    expect(estimateLargestStorageBufferBytes(8_388_608)).toBe(
      WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE,
    );
  });

  it('rejects non-finite negative capacity', () => {
    expect(() => estimateLargestStorageBufferBytes(-1)).toThrow(RangeError);
    expect(() => estimateLargestStorageBufferBytes(Number.NaN)).toThrow(RangeError);
  });
});

describe('assertStorageBufferFitsDevice', () => {
  function rendererWithLimit(limit: number | undefined, isWebGPU = true): WebGPURenderer {
    return {
      backend: {
        isWebGPUBackend: isWebGPU,
        ...(limit === undefined
          ? {}
          : { device: { limits: { maxStorageBufferBindingSize: limit } } }),
      },
    } as unknown as WebGPURenderer;
  }

  it('reads the device bind limit on a WebGPU backend', () => {
    expect(deviceMaxStorageBufferBindingSize(rendererWithLimit(134_217_728))).toBe(134_217_728);
    expect(deviceMaxStorageBufferBindingSize(rendererWithLimit(undefined))).toBe(0);
    expect(deviceMaxStorageBufferBindingSize(rendererWithLimit(134_217_728, false))).toBe(0);
  });

  it('throws when capacity exceeds the default 128 MiB bind limit', () => {
    const capacity = 14_401_536;
    const renderer = rendererWithLimit(WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE);
    expect(() =>
      assertStorageBufferFitsDevice(
        renderer,
        estimateLargestStorageBufferBytes(capacity),
        capacity,
      ),
    ).toThrow(/recommendedWebGpuRequiredLimits/);
  });

  it('allows the same capacity when the host raised the limit', () => {
    const capacity = 14_401_536;
    const renderer = rendererWithLimit(2_147_483_644);
    expect(() =>
      assertStorageBufferFitsDevice(
        renderer,
        estimateLargestStorageBufferBytes(capacity),
        capacity,
      ),
    ).not.toThrow();
  });

  it('skips the check when the backend has no readable limit', () => {
    const capacity = 14_401_536;
    expect(() =>
      assertStorageBufferFitsDevice(
        rendererWithLimit(undefined),
        estimateLargestStorageBufferBytes(capacity),
        capacity,
      ),
    ).not.toThrow();
  });

  it('rejects UnifiedSplatMesh construction under the default limit', () => {
    const capacity = 14_401_536;
    const renderer = rendererWithLimit(WEBGPU_DEFAULT_MAX_STORAGE_BUFFER_BINDING_SIZE);
    expect(() => new UnifiedSplatMesh(renderer, capacity)).toThrow(/maxStorageBufferBindingSize/);
  });
});
