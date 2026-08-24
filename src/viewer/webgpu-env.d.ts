/**
 * Minimal WebGPU navigator surface used by the demo, declared locally so the
 * project does not need the full `@webgpu/types` package. Only the members the
 * demo actually touches are declared: adapter discovery, the buffer limits read
 * by `recommendedWebGpuRequiredLimits`, and the device request the demo owns
 * itself (see `requestRenderDevice` in main.ts).
 */
interface NavigatorGpuDevice {
  readonly features: ReadonlySet<string>;
  destroy(): void;
}

interface NavigatorGpuAdapter {
  readonly features: ReadonlySet<string>;
  readonly limits: {
    readonly maxStorageBufferBindingSize: number;
    readonly maxBufferSize: number;
    readonly maxTextureDimension2D?: number;
  };
  requestDevice(descriptor?: {
    requiredFeatures?: readonly string[];
    requiredLimits?: Record<string, number>;
  }): Promise<NavigatorGpuDevice>;
}

interface NavigatorGpu {
  requestAdapter(options?: {
    powerPreference?: 'low-power' | 'high-performance';
  }): Promise<NavigatorGpuAdapter | null>;
}

interface Navigator {
  readonly gpu?: NavigatorGpu;
}
