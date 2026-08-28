import { describe, expect, it, vi, afterEach } from 'vitest';
import * as THREE from 'three/webgpu';

import { StorageMirrorReleaser } from '../storage-attribute-mirror';
import { setVlamLogHandler } from '../logging';

/**
 * Releasing the JS mirror of a GPU-only storage buffer is only safe while three
 * never re-reads `.array`. These tests pin the three conditions that make it so:
 * it must not release before the upload (the array is still the upload source),
 * it must leave everything three *does* keep reading intact (`count`,
 * `constructor`, `version`), and it must be inert on any renderer whose backend
 * it cannot probe.
 *
 * The ownership boundary is asserted in `compute-sorter.test.ts` and
 * `unified-splat-mesh.test.ts`: a sorter must free its own working buffers
 * and never the mesh's `splatIndex`/`sourceIndex`, which the CPU rewrites every
 * frame.
 */

/** Simulates three's backend DataMap: a buffer appears only once uploaded. */
function uploadingRenderer() {
  const uploaded = new WeakMap<object, { buffer?: object }>();
  const renderer = {
    backend: {
      isWebGPUBackend: true,
      has: (o: object) => uploaded.has(o),
      get: (o: object) => uploaded.get(o) ?? {},
    },
    /** Stands in for the dispatch that makes three create the GPU buffer. */
    upload(...attributes: THREE.BufferAttribute[]) {
      for (const attribute of attributes) uploaded.set(attribute, { buffer: {} });
    },
  };
  return renderer as typeof renderer & THREE.WebGPURenderer;
}

const makeAttribute = (length = 1024) =>
  new THREE.StorageBufferAttribute(new Float32Array(length), 1);

afterEach(() => setVlamLogHandler(undefined));

describe('StorageMirrorReleaser', () => {
  it('does not release before three has uploaded the attribute', () => {
    const renderer = uploadingRenderer();
    const attribute = makeAttribute();
    const releaser = new StorageMirrorReleaser([attribute]);

    expect(releaser.release(renderer)).toBe(0);
    // Still the upload source - dropping it here would upload nothing.
    expect(attribute.array.length).toBe(1024);
    expect(releaser.settled).toBe(false);
    expect(releaser.pendingBytes).toBe(4096);
  });

  it('releases once uploaded, leaving everything three still reads intact', () => {
    const renderer = uploadingRenderer();
    const attribute = makeAttribute();
    const releaser = new StorageMirrorReleaser([attribute]);
    renderer.upload(attribute);

    expect(releaser.release(renderer)).toBe(4096);

    expect(attribute.array.length).toBe(0);
    // `count` is a plain property, not derived from the array - but assert it,
    // because every draw and every `storage()` binding depends on it.
    expect(attribute.count).toBe(1024);
    // The vertex-layout paths read these two off `.array`, never its contents.
    expect(attribute.array.constructor).toBe(Float32Array);
    expect(attribute.array.BYTES_PER_ELEMENT).toBe(4);
    // A bumped version would make three re-upload from the now-empty array.
    expect(attribute.version).toBe(0);
    expect(releaser.settled).toBe(true);
    expect(releaser.releasedBytes).toBe(4096);
  });

  it('is idempotent', () => {
    const renderer = uploadingRenderer();
    const attribute = makeAttribute();
    const releaser = new StorageMirrorReleaser([attribute]);
    renderer.upload(attribute);
    releaser.release(renderer);

    expect(releaser.release(renderer)).toBe(0);
    expect(releaser.releasedBytes).toBe(4096);
  });

  it('releases each attribute as it becomes ready, not all-or-nothing', () => {
    const renderer = uploadingRenderer();
    const first = makeAttribute();
    const second = makeAttribute();
    const releaser = new StorageMirrorReleaser([first, second]);

    renderer.upload(first);
    releaser.release(renderer);
    expect(first.array.length).toBe(0);
    expect(second.array.length).toBe(1024);
    expect(releaser.settled).toBe(false);

    renderer.upload(second);
    releaser.release(renderer);
    expect(second.array.length).toBe(0);
    expect(releaser.settled).toBe(true);
  });

  it('is a no-op on a renderer whose backend it cannot probe', () => {
    // WebGL2 fallback, and the plain `{ compute: vi.fn() }` doubles the existing
    // suites use. Neither may lose its array, and neither may throw.
    const attribute = makeAttribute();
    for (const backend of [undefined, {}, { isWebGPUBackend: true }]) {
      const renderer = { backend } as unknown as THREE.WebGPURenderer;
      const releaser = new StorageMirrorReleaser([attribute]);
      expect(() => releaser.release(renderer)).not.toThrow();
      expect(attribute.array.length).toBe(1024);
      expect(releaser.settled).toBe(false);
    }
  });

  it('does not pollute the backend map while probing', () => {
    // three's `DataMap.get` *creates* a record on a miss, so probing with `get`
    // alone would both leak entries and always report "uploaded".
    const seen: object[] = [];
    const renderer = {
      backend: {
        isWebGPUBackend: true,
        has: () => false,
        get: (o: object) => {
          seen.push(o);
          return {};
        },
      },
    } as unknown as THREE.WebGPURenderer;
    const attribute = makeAttribute();

    new StorageMirrorReleaser([attribute]).release(renderer);

    expect(seen).toEqual([]);
    expect(attribute.array.length).toBe(1024);
  });

  it('warns once when a released attribute is written from the CPU again', () => {
    // The one silent failure mode: three would upload the zero-length array,
    // a legal no-op, and the data would never reach the GPU.
    const warn = vi.fn();
    setVlamLogHandler((level, message) => {
      if (level === 'warn') warn(message);
    });
    const renderer = uploadingRenderer();
    const attribute = makeAttribute();
    attribute.name = 'testBuffer';
    const releaser = new StorageMirrorReleaser([attribute]);
    renderer.upload(attribute);
    releaser.release(renderer);

    attribute.needsUpdate = true;
    releaser.release(renderer);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('testBuffer');

    releaser.release(renderer);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
