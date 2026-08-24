import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSplatRenderer,
  type SplatRendererGpu,
  type SplatRendererGpuAdapter,
} from '../create-splat-renderer';
import { setVlamLogHandler } from '../logging';
import { recommendedWebGpuRequiredLimits } from '../webgpu-limits';

/*
 * The one place in the suite that mocks `three/webgpu`.
 *
 * Everything this helper does is *the parameters object it builds*, and a value
 * cast of a fake renderer (the pattern elsewhere, e.g. dispose-lifecycle.test.ts)
 * cannot observe a constructor argument. So `WebGPURenderer` is replaced with a
 * class that records its params, and nothing else in the module is touched.
 */
vi.mock('three/webgpu', () => {
  class WebGPURenderer {
    static lastParams: Record<string, unknown> | undefined;
    constructor(params?: Record<string, unknown>) {
      WebGPURenderer.lastParams = params;
    }
  }
  return { WebGPURenderer };
});

const { WebGPURenderer } = (await import('three/webgpu')) as unknown as {
  WebGPURenderer: { lastParams?: Record<string, unknown> };
};

function lastParams(): Record<string, unknown> {
  const params = WebGPURenderer.lastParams;
  if (!params) throw new Error('WebGPURenderer was never constructed.');
  return params;
}

const LIMITS = {
  maxStorageBufferBindingSize: 2_147_483_648,
  maxBufferSize: 2_147_483_648,
  maxTextureDimension2D: 16_384,
};

const DEVICE = { features: new Set(['core-features-and-limits']) };

function fakeGpu(
  overrides: {
    features?: readonly string[];
    requestAdapter?: SplatRendererGpu['requestAdapter'];
    requestDevice?: SplatRendererGpuAdapter['requestDevice'];
  } = {},
): { gpu: SplatRendererGpu; adapterOptions: () => unknown; deviceDescriptor: () => unknown } {
  let adapterOptions: unknown;
  let deviceDescriptor: unknown;
  const adapter: SplatRendererGpuAdapter = {
    features: new Set(overrides.features ?? ['core-features-and-limits', 'timestamp-query']),
    limits: LIMITS,
    requestDevice:
      overrides.requestDevice ??
      ((descriptor) => {
        deviceDescriptor = descriptor;
        return Promise.resolve(DEVICE);
      }),
  };
  const gpu: SplatRendererGpu = {
    requestAdapter:
      overrides.requestAdapter ??
      ((options) => {
        adapterOptions = options;
        return Promise.resolve(adapter);
      }),
  };
  return { gpu, adapterOptions: () => adapterOptions, deviceDescriptor: () => deviceDescriptor };
}

let warnings: Array<[string, unknown[]]>;

beforeEach(() => {
  WebGPURenderer.lastParams = undefined;
  warnings = [];
  setVlamLogHandler((_level, message, ...details) => warnings.push([message, details]));
  // Non-Windows by default, so powerPreference is expected to flow through.
  vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mac OS X' });
});

afterEach(() => {
  setVlamLogHandler();
  vi.unstubAllGlobals();
});

describe('createSplatRenderer', () => {
  it('requests every adapter feature and the recommended limits, then passes the device', async () => {
    const { gpu, adapterOptions, deviceDescriptor } = fakeGpu();

    await createSplatRenderer({ gpu });

    expect(adapterOptions()).toEqual({ powerPreference: 'high-performance' });
    const descriptor = deviceDescriptor() as {
      requiredFeatures: string[];
      requiredLimits: Record<string, number>;
    };
    expect(descriptor.requiredFeatures).toEqual(['core-features-and-limits', 'timestamp-query']);
    expect(descriptor.requiredLimits).toEqual(recommendedWebGpuRequiredLimits({ limits: LIMITS }));

    const params = lastParams();
    expect(params.device).toBe(DEVICE);
    // The device already carries the limits; sending both is redundant.
    expect(params).not.toHaveProperty('requiredLimits');
    expect(params.antialias).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('warns and falls back to WebGL2 when no adapter is available', async () => {
    const { gpu } = fakeGpu({ requestAdapter: () => Promise.resolve(null) });

    await createSplatRenderer({ gpu });

    expect(lastParams()).not.toHaveProperty('device');
    expect(lastParams()).not.toHaveProperty('requiredLimits');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toContain('No WebGPU adapter');
  });

  it('warns and falls back when requestAdapter throws', async () => {
    const boom = new Error('adapter exploded');
    const { gpu } = fakeGpu({ requestAdapter: () => Promise.reject(boom) });

    await createSplatRenderer({ gpu });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toContain(boom);
  });

  it('keeps the original device error and still requests raised limits', async () => {
    const boom = new Error('D3D12 command queue create failed');
    const { gpu } = fakeGpu({ requestDevice: () => Promise.reject(boom) });

    await createSplatRenderer({ gpu });

    // The error *instance*, not a message - this is the value three's
    // `getFallback` hook swallows.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toContain(boom);

    const params = lastParams();
    expect(params).not.toHaveProperty('device');
    expect(params.requiredLimits).toEqual(recommendedWebGpuRequiredLimits({ limits: LIMITS }));
  });

  it('is silent when there is no WebGPU at all', async () => {
    await createSplatRenderer({ gpu: null });

    // A browser without WebGPU is not a fixable misconfiguration.
    expect(warnings).toEqual([]);
    expect(lastParams()).not.toHaveProperty('device');
  });

  it('throws instead of degrading when requireWebGpu is set', async () => {
    await expect(createSplatRenderer({ gpu: null, requireWebGpu: true })).rejects.toThrow(
      /WebGPU is unavailable/,
    );

    const noAdapter = fakeGpu({ requestAdapter: () => Promise.resolve(null) });
    await expect(createSplatRenderer({ gpu: noAdapter.gpu, requireWebGpu: true })).rejects.toThrow(
      /no WebGPU adapter/,
    );

    const adapterBoom = new Error('adapter exploded');
    const badAdapter = fakeGpu({ requestAdapter: () => Promise.reject(adapterBoom) });
    await expect(createSplatRenderer({ gpu: badAdapter.gpu, requireWebGpu: true })).rejects.toBe(
      adapterBoom,
    );

    const deviceBoom = new Error('device exploded');
    const badDevice = fakeGpu({ requestDevice: () => Promise.reject(deviceBoom) });
    // Rethrown unwrapped, so hosts can inspect the original.
    await expect(createSplatRenderer({ gpu: badDevice.gpu, requireWebGpu: true })).rejects.toBe(
      deviceBoom,
    );
  });

  it('rejects requireWebGpu together with forceWebGL', async () => {
    await expect(createSplatRenderer({ forceWebGL: true, requireWebGpu: true })).rejects.toThrow(
      TypeError,
    );
  });

  it('skips the WebGPU probe entirely under forceWebGL', async () => {
    const requestAdapter = vi.fn(() => Promise.resolve(null));
    const { gpu } = fakeGpu({ requestAdapter });

    await createSplatRenderer({ gpu, forceWebGL: true });

    expect(requestAdapter).not.toHaveBeenCalled();
    expect(lastParams().forceWebGL).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('passes renderer options through and lets them override the defaults', async () => {
    const { gpu } = fakeGpu();

    await createSplatRenderer({
      gpu,
      antialias: false,
      trackTimestamp: true,
      alpha: false,
      // @ts-expect-error the helper owns the device.
      device: {},
    });

    const params = lastParams();
    expect(params.antialias).toBe(false);
    expect(params.trackTimestamp).toBe(true);
    expect(params.alpha).toBe(false);
    // The helper's own device wins over the (ill-typed) caller value.
    expect(params.device).toBe(DEVICE);

    // Excess-property checking reports only the first unknown key, so
    // `requiredLimits` needs its own call to be rejected.
    // @ts-expect-error the helper owns requiredLimits.
    await createSplatRenderer({ gpu, requiredLimits: { maxBufferSize: 1 } });
  });

  it('omits powerPreference on Windows and sends it elsewhere', async () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows NT 10.0' });
    const windows = fakeGpu();
    await createSplatRenderer({ gpu: windows.gpu });
    expect(windows.adapterOptions()).toEqual({});
    expect(lastParams()).not.toHaveProperty('powerPreference');

    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mac OS X' });
    const mac = fakeGpu();
    await createSplatRenderer({ gpu: mac.gpu });
    expect(mac.adapterOptions()).toEqual({ powerPreference: 'high-performance' });
    expect(lastParams().powerPreference).toBe('high-performance');
  });

  it('honours an explicit powerPreference, and null to never send one', async () => {
    const lowPower = fakeGpu();
    await createSplatRenderer({ gpu: lowPower.gpu, powerPreference: 'low-power' });
    expect(lowPower.adapterOptions()).toEqual({ powerPreference: 'low-power' });
    expect(lastParams().powerPreference).toBe('low-power');

    const none = fakeGpu();
    await createSplatRenderer({ gpu: none.gpu, powerPreference: null });
    expect(none.adapterOptions()).toEqual({});
    expect(lastParams()).not.toHaveProperty('powerPreference');
  });
});
