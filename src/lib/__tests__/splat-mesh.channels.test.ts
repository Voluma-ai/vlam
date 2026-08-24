import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { vec4, float } from 'three/tsl';
import { SplatMesh } from '../splat-mesh';
import type { SplatModifier } from '../splat-modifier';
import { writeCovariance } from '../splat-data';

const WIDTH = 2048; // SplatMesh.DATA_TEXTURE_WIDTH

function makeSplatData(count: number): {
  count: number;
  positions: Float32Array;
  colors: Uint8Array;
  covariances: Float32Array;
} {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

/** Reaches a channel's private CPU backing array for assertions. */
function channelBacking(mesh: SplatMesh, name: string): Uint8Array | Float32Array {
  const channels = (
    mesh as unknown as { channels: Map<string, { backing: Uint8Array | Float32Array }> }
  ).channels;
  const record = channels.get(name);
  if (!record) throw new Error(`no channel ${name}`);
  return record.backing;
}

function channelPendingRows(mesh: SplatMesh, name: string): { start: number; count: number }[] {
  const channels = (
    mesh as unknown as {
      channels: Map<string, { pendingRows: { start: number; count: number }[] }>;
    }
  ).channels;
  return channels.get(name)!.pendingRows;
}

describe('SplatMesh per-splat channels', () => {
  const meshes: SplatMesh[] = [];
  afterEach(() => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
  });

  function dynamicMesh(capacity = 4 * WIDTH): SplatMesh {
    const mesh = new SplatMesh({ capacity });
    meshes.push(mesh);
    return mesh;
  }

  it('defineChannel rejects a duplicate name', () => {
    const mesh = dynamicMesh();
    mesh.defineChannel('mask', { type: 'byte' });
    expect(() => mesh.defineChannel('mask')).toThrow(/already defined/);
  });

  it('defineChannel honors the fill option', () => {
    const mesh = dynamicMesh();
    mesh.defineChannel('sel', { type: 'byte', fill: 7 });
    const backing = channelBacking(mesh, 'sel');
    expect(backing[0]).toBe(7);
    expect(backing[backing.length - 1]).toBe(7);
  });

  it("writeChannel stores values at the range's pool offset", () => {
    const mesh = dynamicMesh();
    const range = mesh.appendRange(makeSplatData(3));
    mesh.defineChannel('mask', { type: 'byte' });
    mesh.writeChannel(range, 'mask', new Uint8Array([255, 0, 128]));

    const backing = channelBacking(mesh, 'mask');
    expect(Array.from(backing.subarray(0, 4))).toEqual([255, 0, 128, 0]);
    // First append lands at pool row 0, so exactly row 0 is dirty.
    expect(channelPendingRows(mesh, 'mask')).toEqual([{ start: 0, count: 1 }]);
  });

  it('writeChannel writes at an offset within the range', () => {
    const mesh = dynamicMesh();
    const range = mesh.appendRange(makeSplatData(5));
    mesh.defineChannel('mask', { type: 'byte' });
    mesh.writeChannel(range, 'mask', new Uint8Array([9, 9]), 2);

    const backing = channelBacking(mesh, 'mask');
    expect(Array.from(backing.subarray(0, 5))).toEqual([0, 0, 9, 9, 0]);
  });

  it('float channels keep their value verbatim', () => {
    const mesh = dynamicMesh();
    const range = mesh.appendRange(makeSplatData(2));
    mesh.defineChannel('weight'); // default 'float'
    mesh.writeChannel(range, 'weight', new Float32Array([0.25, -3.5]));

    const backing = channelBacking(mesh, 'weight');
    expect(backing).toBeInstanceOf(Float32Array);
    expect(backing[0]).toBeCloseTo(0.25);
    expect(backing[1]).toBeCloseTo(-3.5);
  });

  it('writeChannel rejects unknown channels and ranges', () => {
    const mesh = dynamicMesh();
    const range = mesh.appendRange(makeSplatData(2));
    expect(() => mesh.writeChannel(range, 'nope', new Float32Array([1, 2]))).toThrow(/not defined/);

    mesh.defineChannel('mask');
    const foreign = { count: 2 } as const;
    expect(() => mesh.writeChannel(foreign, 'mask', new Float32Array([1, 2]))).toThrow(
      /unknown range/,
    );
  });

  it('writeChannel rejects writes past the range bounds', () => {
    const mesh = dynamicMesh();
    const range = mesh.appendRange(makeSplatData(3));
    mesh.defineChannel('mask', { type: 'byte' });
    expect(() => mesh.writeChannel(range, 'mask', new Uint8Array([1, 2, 3, 4]))).toThrow(/exceeds/);
    expect(() => mesh.writeChannel(range, 'mask', new Uint8Array([1, 2]), 2)).toThrow(/exceeds/);
  });

  it('a modifier reading an undefined channel fails at material build', () => {
    const mesh = dynamicMesh();
    const reader: SplatModifier = (ctx) => ({
      color: vec4(ctx.channel('missing'), 0, 0, 1),
    });
    expect(() => {
      mesh.modifiers = [reader];
    }).toThrow(/channel "missing"/);
  });

  it('a modifier reading a defined channel builds cleanly', () => {
    const mesh = dynamicMesh();
    mesh.defineChannel('mask', { type: 'byte' });
    const reader: SplatModifier = (ctx) => ({
      color: vec4(ctx.channel('mask'), 0, 0, 1),
    });
    expect(() => {
      mesh.modifiers = [reader];
    }).not.toThrow();
    expect(mesh.modifiers).toHaveLength(1);
  });

  it('a modifier with isotropic covariance mix builds cleanly', () => {
    const mesh = dynamicMesh();
    mesh.appendRange(makeSplatData(2));
    const pointMode: SplatModifier = (ctx) => ({
      isotropicCovarianceMix: float(1),
      isotropicVarianceScale: float(0.35 * 0.35),
      color: ctx.color,
    });
    expect(() => {
      mesh.modifiers = [pointMode];
    }).not.toThrow();
    expect(mesh.modifiers).toHaveLength(1);
  });

  it('isotropic screen-radius cap is opt-in and builds when set', () => {
    const mesh = dynamicMesh();
    mesh.appendRange(makeSplatData(2));
    const capped: SplatModifier = (ctx) => ({
      isotropicCovarianceMix: float(1),
      isotropicScreenRadiusPx: float(1),
      color: ctx.color,
    });
    expect(() => {
      mesh.modifiers = [capped];
    }).not.toThrow();
  });

  it('compact relocates channel data with its range', () => {
    const mesh = dynamicMesh();
    // Two single-row ranges; remove the first to leave a hole at row 0.
    const a = mesh.appendRange(makeSplatData(3));
    const b = mesh.appendRange(makeSplatData(3));
    mesh.defineChannel('mask', { type: 'byte' });
    mesh.writeChannel(b, 'mask', new Uint8Array([11, 22, 33]));

    const backing = channelBacking(mesh, 'mask');
    // b landed at row 1.
    expect(Array.from(backing.subarray(WIDTH, WIDTH + 3))).toEqual([11, 22, 33]);

    mesh.removeRange(a);
    mesh.compact(); // b slides from row 1 down to row 0

    expect(Array.from(backing.subarray(0, 3))).toEqual([11, 22, 33]);
    // The relocated row is queued for GPU re-upload.
    expect(channelPendingRows(mesh, 'mask')).toContainEqual({ start: 0, count: 1 });
  });

  it('flushPendingUploads uploads channel dirty rows and clears them', () => {
    const mesh = dynamicMesh();
    const range = mesh.appendRange(makeSplatData(2));
    mesh.defineChannel('mask', { type: 'byte' });
    mesh.writeChannel(range, 'mask', new Uint8Array([255, 255]));

    const channelTexture = (
      mesh as unknown as { channels: Map<string, { texture: THREE.DataTexture }> }
    ).channels.get('mask')!.texture;

    const copies: { dst: THREE.Texture; y: number }[] = [];
    const renderer = {
      copyTextureToTexture: vi.fn(
        (_src: THREE.Texture, dst: THREE.Texture, _box: unknown, pos: THREE.Vector2) => {
          copies.push({ dst, y: pos.y });
        },
      ),
    } as unknown as THREE.WebGPURenderer;

    (mesh as unknown as { flushPendingUploads(r: THREE.WebGPURenderer): void }).flushPendingUploads(
      renderer,
    );

    // The channel texture was among the upload targets, at row 0.
    expect(copies.some((c) => c.dst === channelTexture && c.y === 0)).toBe(true);
    expect(channelPendingRows(mesh, 'mask')).toHaveLength(0);
  });

  it('dispose frees channel textures', () => {
    const mesh = new SplatMesh({ capacity: WIDTH });
    mesh.defineChannel('mask', { type: 'byte' });
    const texture = (
      mesh as unknown as { channels: Map<string, { texture: THREE.DataTexture }> }
    ).channels.get('mask')!.texture;
    const spy = vi.spyOn(texture, 'dispose');
    mesh.dispose();
    expect(spy).toHaveBeenCalled();
  });
});
