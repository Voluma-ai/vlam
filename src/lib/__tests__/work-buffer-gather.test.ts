import * as THREE from 'three/webgpu';
import { bool } from 'three/tsl';
import { describe, expect, it, vi } from 'vitest';
import { WorkBuffer, WorkBufferGather } from '../unified/work-buffer-gather';
import {
  WORK_BUFFER_BYTES_PER_SLOT,
  estimateUnifiedWorkBufferBytes,
  estimateUnifiedWorkBufferPeakBytes,
} from '../unified/unified-work-buffer';

function textures(width: number) {
  return {
    centersTexture: new THREE.DataTexture(new Float32Array(width * 4), width, 1),
    colorsTexture: new THREE.DataTexture(new Uint8Array(width * 4), width, 1),
    covarianceATexture: new THREE.DataTexture(new Float32Array(width * 4), width, 1),
    covarianceBTexture: new THREE.DataTexture(new Float32Array(width * 4), width, 1),
    dataTextureWidth: width,
  };
}

describe('WorkBufferGather', () => {
  it('gathers only active source slots into the requested work-buffer range', () => {
    const gather = new WorkBufferGather({
      capacity: 16,
      sourceCapacity: 8,
      sourceIndex: new THREE.StorageBufferAttribute(new Uint32Array(8), 1),
      ...textures(8),
    });
    const compute = vi.fn();
    gather.gather(
      { compute } as unknown as THREE.WebGPURenderer,
      3,
      5,
      new THREE.Matrix4().makeTranslation(1, 2, 3),
    );
    expect(compute).toHaveBeenCalledOnce();
    const pass = (gather as unknown as { pass: THREE.ComputeNode }).pass;
    expect(compute).toHaveBeenCalledWith(pass);
    expect(pass.count).toBe(3);
    expect(gather.centers.itemSize).toBe(4);
    gather.dispose();
  });

  it('rejects a gather range that would overflow the work buffer', () => {
    const gather = new WorkBufferGather({
      capacity: 2,
      sourceCapacity: 2,
      sourceIndex: new THREE.StorageBufferAttribute(new Uint32Array(2), 1),
      ...textures(2),
    });
    expect(() =>
      gather.gather(
        { compute: vi.fn() } as unknown as THREE.WebGPURenderer,
        2,
        1,
        new THREE.Matrix4(),
      ),
    ).toThrow(/exceeds/);
    gather.dispose();
  });

  it('allows independent source passes to target one shared work buffer', () => {
    const shared = new WorkBuffer(8);
    const source = new THREE.StorageBufferAttribute(new Uint32Array(4), 1);
    const tex = textures(4);
    const first = new WorkBufferGather({
      capacity: 4,
      sourceCapacity: 4,
      sourceIndex: source,
      ...tex,
      workBuffer: shared,
    });
    const second = new WorkBufferGather({
      capacity: 4,
      sourceCapacity: 4,
      sourceIndex: source,
      ...tex,
      workBuffer: shared,
    });
    expect(first.centers).toBe(second.centers);
    first.dispose();
    second.dispose();
  });

  it('builds a RAD gather that keeps original alpha out of the source-opacity uniform', () => {
    const gather = new WorkBufferGather({
      capacity: 2,
      sourceCapacity: 2,
      sourceIndex: new THREE.StorageBufferAttribute(new Uint32Array(2), 1),
      ...textures(2),
      lodAlpha: true,
    });
    const compute = vi.fn();
    const opacities = [1, 0.75, 0.5, 0.25, 0] as const;
    for (const opacity of opacities) {
      gather.gather(
        { compute } as unknown as THREE.WebGPURenderer,
        2,
        0,
        new THREE.Matrix4(),
        opacity,
      );
      expect((gather as unknown as { opacity: { value: number } }).opacity.value).toBe(opacity);
    }
    expect(compute).toHaveBeenCalledTimes(opacities.length);
    gather.dispose();
  });

  it('builds a gather that stamps display opacity into center.w while keeping stable slots', () => {
    const gather = new WorkBufferGather({
      capacity: 4,
      sourceCapacity: 4,
      sourceIndex: new THREE.StorageBufferAttribute(new Uint32Array(4), 1),
      ...textures(4),
      // Modifier-hidden entries still occupy work slots; centers.w is 0.
      modifiers: [() => ({ visible: bool(false) })],
    });
    const compute = vi.fn();
    gather.gather({ compute } as unknown as THREE.WebGPURenderer, 4, 0, new THREE.Matrix4());
    expect(compute).toHaveBeenCalledOnce();
    expect((gather as unknown as { pass: THREE.ComputeNode }).pass.count).toBe(4);
    gather.dispose();
  });
});

describe('WorkBuffer memory accounting', () => {
  it('matches the per-slot constant the estimator prices with', () => {
    // Pins `WORK_BUFFER_BYTES_PER_SLOT` to what the constructor actually
    // allocates, so adding an attribute cannot silently make every host's
    // memory estimate wrong.
    const capacity = 1024;
    const buffer = new WorkBuffer(capacity);
    const slots = capacity + WorkBuffer.SCRATCH_SLOTS;
    const bytes = [
      buffer.centers,
      buffer.colors,
      buffer.covarianceA,
      buffer.covarianceB,
      buffer.isotropicMix,
      buffer.isotropicScreenRadius,
    ].reduce((total, attribute) => total + attribute.array.byteLength, 0);
    expect(bytes).toBe(slots * WORK_BUFFER_BYTES_PER_SLOT);
  });

  it('allocates a CPU mirror that costs double until the first dispatch releases it', () => {
    // The gather pass writes these buffers entirely on the GPU and nothing ever
    // reads the JS array back - but three's WebGPU backend never calls the
    // `attribute.onUploadCallback()` that would free it, so the array used to
    // stay resident for the renderer's lifetime. `releaseCpuMirrors` drops it
    // after the upload, which is why the steady-state estimate is now the GPU
    // side alone and only the *peak* still doubles.
    const capacity = 1000;
    const buffer = new WorkBuffer(capacity);
    expect(buffer.centers.array.byteLength).toBeGreaterThan(0);
    expect(estimateUnifiedWorkBufferBytes(capacity)).toBe(capacity * WORK_BUFFER_BYTES_PER_SLOT);
    expect(estimateUnifiedWorkBufferPeakBytes(capacity)).toBe(
      capacity * WORK_BUFFER_BYTES_PER_SLOT * 2,
    );
  });

  it('releases every work-buffer mirror once three has uploaded them', () => {
    const capacity = 1000;
    const buffer = new WorkBuffer(capacity);
    const attributes = [
      buffer.centers,
      buffer.colors,
      buffer.covarianceA,
      buffer.covarianceB,
      buffer.isotropicMix,
      buffer.isotropicScreenRadius,
    ];
    const uploaded = new WeakMap<object, { buffer?: object }>();
    const renderer = {
      backend: {
        isWebGPUBackend: true,
        has: (o: object) => uploaded.has(o),
        get: (o: object) => uploaded.get(o) ?? {},
      },
    } as unknown as THREE.WebGPURenderer;

    // Before the upload the arrays are still the upload source.
    buffer.releaseCpuMirrors(renderer);
    for (const attribute of attributes) expect(attribute.array.byteLength).toBeGreaterThan(0);

    for (const attribute of attributes) uploaded.set(attribute, { buffer: {} });
    buffer.releaseCpuMirrors(renderer);

    for (const attribute of attributes) expect(attribute.array.length).toBe(0);
    // `count` drives the draw and every `storage()` binding; it is a plain
    // property rather than a view over the array, so it must survive intact.
    expect(buffer.centers.count).toBe(capacity + WorkBuffer.SCRATCH_SLOTS);
  });

  it('rejects a nonsensical capacity rather than returning NaN', () => {
    expect(() => estimateUnifiedWorkBufferBytes(-1)).toThrow(RangeError);
    expect(() => estimateUnifiedWorkBufferBytes(Number.NaN)).toThrow(RangeError);
    expect(() => estimateUnifiedWorkBufferPeakBytes(-1)).toThrow(RangeError);
  });
});
