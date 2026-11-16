import { describe, expect, it } from 'vitest';
import { SkinnedSplatMesh, loadSplatGltf } from '../dynamic';
import { SplatMesh } from '../core/splat-mesh';

/**
 * `loadSplatGltf` on a minimal `KHR_gaussian_splatting` file built here by
 * hand: unskinned splats, float attributes, no animation. VLAM only reads
 * splat glTF; the writer that round-trips skins and clips through this loader
 * lives with Voluma's avatar tooling.
 */

const KHR = 'KHR_gaussian_splatting';
const FLOAT = 5126;

/** A `.glb` of `count` splats from per-attribute float arrays, as a POINTS primitive. */
function minimalGlb(
  count: number,
  attributes: Record<string, { type: 'SCALAR' | 'VEC3' | 'VEC4'; values: number[] }>,
): ArrayBuffer {
  const chunks: Float32Array[] = [];
  const bufferViews: Record<string, number>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const indices: Record<string, number> = {};
  let offset = 0;
  for (const [name, { type, values }] of Object.entries(attributes)) {
    const array = Float32Array.from(values);
    chunks.push(array);
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: array.byteLength,
      target: 34962,
    });
    const accessor: Record<string, unknown> = {
      bufferView: bufferViews.length - 1,
      componentType: FLOAT,
      count,
      type,
    };
    if (name === 'POSITION') {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < 3; c++) {
          min[c] = Math.min(min[c]!, array[i * 3 + c]!);
          max[c] = Math.max(max[c]!, array[i * 3 + c]!);
        }
      }
      Object.assign(accessor, { min, max });
    }
    accessors.push(accessor);
    indices[name] = accessors.length - 1;
    offset += array.byteLength;
  }
  const json = {
    asset: { version: '2.0' },
    extensionsUsed: [KHR],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'splats', mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            mode: 0,
            attributes: indices,
            extensions: { [KHR]: { kernel: 'ellipse', colorSpace: 'srgb_rec709_display' } },
          },
        ],
      },
    ],
    buffers: [{ byteLength: offset }],
    bufferViews,
    accessors,
  };
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.byteLength / 4) * 4;
  const glb = new Uint8Array(12 + 8 + jsonLength + 8 + offset);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  glb.fill(0x20, 20, 20 + jsonLength);
  glb.set(text, 20);
  view.setUint32(20 + jsonLength, offset, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true); // 'BIN\0'
  let at = 28 + jsonLength;
  for (const chunk of chunks) {
    glb.set(new Uint8Array(chunk.buffer), at);
    at += chunk.byteLength;
  }
  return glb.buffer;
}

describe('splat glTF', () => {
  it('loads unskinned splats as a plain SplatMesh', async () => {
    const glb = minimalGlb(2, {
      POSITION: { type: 'VEC3', values: [0, 0, 0, 1, 2, 3] },
      [`${KHR}:ROTATION`]: { type: 'VEC4', values: [0, 0, 0, 1, 0, 0, 0, 1] },
      [`${KHR}:SCALE`]: { type: 'VEC3', values: [0.1, 0.2, 0.3, 0.05, 0.05, 0.05] },
      [`${KHR}:OPACITY`]: { type: 'SCALAR', values: [1, 0.5] },
      [`${KHR}:SH_DEGREE_0_COEF_0`]: { type: 'VEC3', values: [0, 0, 0, 1, 1, 1] },
    });
    const loaded = await loadSplatGltf(glb);
    expect(loaded.meshes).toHaveLength(1);
    expect(loaded.meshes[0]).toBeInstanceOf(SplatMesh);
    expect(loaded.meshes[0]).not.toBeInstanceOf(SkinnedSplatMesh);
    expect(loaded.animations).toEqual([]);
    loaded.meshes[0]!.dispose();
  });

  it('names a missing splat attribute instead of loading nothing', async () => {
    const glb = minimalGlb(1, {
      POSITION: { type: 'VEC3', values: [0, 0, 0] },
      [`${KHR}:ROTATION`]: { type: 'VEC4', values: [0, 0, 0, 1] },
    });
    await expect(loadSplatGltf(glb)).rejects.toThrow(KHR);
  });
});
