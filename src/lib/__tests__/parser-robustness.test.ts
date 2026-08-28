import { describe, expect, it } from 'vitest';
import { parseLodManifest } from '../streaming/lod-manifest';
import type { SplatDatasetSource } from '../streaming/dataset-source';
import { sliceSplatData } from '../streaming/streamed-splat-mesh';
import { releaseRowSpan } from '../core/splat-mesh-pool';
import { parsePlyHeader } from '../loaders/ply-header';
import { packPaletteSh, shCoefficientCount } from '../core/sh-pack';
import { parseSplat } from '../formats/splat/parse-splat';
import type { SplatData, SplatShData } from '../core/splat-data';

/**
 * Regression tests for robustness against hostile or corrupt scene files
 * and manifests - cases without a natural home in a per-format test file.
 */

const source: SplatDatasetSource = {
  manifestUrl: 'https://example.test/scene/lod-meta.json',
  resolve: (path) => `https://example.test/scene/${path}`,
  size: () => Promise.resolve(null),
  directoryFiles: () => null,
  dispose: () => {},
};

function leaf(lods: Record<string, unknown> = {}): Record<string, unknown> {
  return { bound: { min: [0, 0, 0], max: [1, 1, 1] }, lods };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    counts: [10],
    lodLevels: 1,
    filenames: ['0_0/meta.json'],
    tree: leaf({ 0: { file: 0, offset: 0, count: 10 } }),
    ...overrides,
  };
}

describe('parseLodManifest robustness', () => {
  it('parses a well-formed manifest', () => {
    const parsed = parseLodManifest(manifest(), source);
    expect(parsed.leaves.length).toBe(1);
    expect(parsed.leaves[0]?.lods[0]).toEqual({ file: 0, offset: 0, count: 10 });
  });

  it('rejects non-array filenames and counts', () => {
    expect(() => parseLodManifest(manifest({ filenames: 'nope' }), source)).toThrow(
      /"filenames" must be an array of strings/,
    );
    expect(() => parseLodManifest(manifest({ counts: { 0: 1 } }), source)).toThrow(
      /"counts" must be an array of non-negative integers/,
    );
    expect(() => parseLodManifest(manifest({ counts: [-1] }), source)).toThrow(
      /"counts" must be an array of non-negative integers/,
    );
  });

  it('rejects an insane lodLevels', () => {
    for (const lodLevels of [0, -1, 2.5, 1e9, 'many']) {
      expect(() => parseLodManifest(manifest({ lodLevels }), source)).toThrow(/invalid lodLevels/);
    }
  });

  it('rejects a range whose file index is out of bounds', () => {
    const tree = leaf({ 0: { file: 3, offset: 0, count: 10 } });
    expect(() => parseLodManifest(manifest({ tree }), source)).toThrow(/invalid LOD range/);
  });

  it('rejects negative or non-integer range offset/count', () => {
    for (const range of [
      { file: 0, offset: -1, count: 1 },
      { file: 0, offset: 0, count: -5 },
      { file: 0, offset: 0.5, count: 1 },
      { file: 0, offset: 0, count: Number.MAX_SAFE_INTEGER + 2 },
    ]) {
      const tree = leaf({ 0: range });
      expect(() => parseLodManifest(manifest({ tree }), source)).toThrow(/invalid LOD range/);
    }
  });

  it('survives a pathologically deep tree without overflowing the call stack', () => {
    // Deep chain: each node's second child is the next level down.
    let node: Record<string, unknown> = leaf({ 0: { file: 0, offset: 0, count: 1 } });
    for (let i = 0; i < 200_000; i++) {
      node = { bound: { min: [0, 0, 0], max: [1, 1, 1] }, children: [leaf(), node] };
    }
    const parsed = parseLodManifest(manifest({ tree: node }), source);
    expect(parsed.leaves.length).toBe(200_001);
    // Leaf order is depth-first, children[0] before children[1]: the lone
    // ranged leaf sits at the very end.
    expect(parsed.leaves[parsed.leaves.length - 1]?.lods[0]?.count).toBe(1);
  });

  it('rejects a malformed children node', () => {
    const tree = { bound: { min: [0, 0, 0], max: [1, 1, 1] }, children: [leaf()] };
    expect(() => parseLodManifest(manifest({ tree }), source)).toThrow(/exactly two children/);
  });
});

function chunkData(count: number): SplatData {
  return {
    count,
    positions: new Float32Array(count * 3),
    colors: new Uint8Array(count * 4),
    covariances: new Float32Array(count * 6),
  };
}

describe('sliceSplatData', () => {
  it('slices a valid in-bounds range', () => {
    const slice = sliceSplatData(chunkData(10), 2, 5);
    expect(slice.count).toBe(5);
    expect(slice.positions.length).toBe(15);
  });

  it('rejects a range that over-declares against its chunk', () => {
    expect(() => sliceSplatData(chunkData(10), 8, 5)).toThrow(/exceeds its chunk's 10 splats/);
    expect(() => sliceSplatData(chunkData(10), -1, 5)).toThrow(/exceeds its chunk/);
    expect(() => sliceSplatData(chunkData(10), 0, 11)).toThrow(/exceeds its chunk/);
  });
});

describe('releaseRowSpan', () => {
  it('coalesces adjacent spans', () => {
    let spans = releaseRowSpan([], 0, 4);
    spans = releaseRowSpan(spans, 4, 4);
    expect(spans).toEqual([{ start: 0, count: 8 }]);
  });

  it('throws on a double release instead of double-allocating rows', () => {
    const spans = releaseRowSpan([], 0, 4);
    expect(() =>
      releaseRowSpan(
        spans.map((s) => ({ ...s })),
        0,
        4,
      ),
    ).toThrow(/overlap an already-free span/);
  });

  it('throws on a partially overlapping release', () => {
    const spans = releaseRowSpan([], 0, 4);
    expect(() =>
      releaseRowSpan(
        spans.map((s) => ({ ...s })),
        2,
        4,
      ),
    ).toThrow(/overlap an already-free span/);
  });
});

describe('parsePlyHeader robustness', () => {
  it('reports an oversized header distinctly from a non-PLY file', () => {
    // 'ply' magic present, but no end_header within the 64 KiB window.
    const text = `ply\nformat binary_little_endian 1.0\n${'comment x\n'.repeat(10_000)}`;
    const buffer = new TextEncoder().encode(text).buffer;
    expect(() => parsePlyHeader(buffer)).toThrow(/no "end_header" within the first 64 KiB/);
    expect(() => parsePlyHeader(buffer)).not.toThrow(/Not a PLY file/);
  });

  it('still reports a non-PLY file as such', () => {
    const buffer = new TextEncoder().encode('hello world').buffer;
    expect(() => parsePlyHeader(buffer)).toThrow(/Not a PLY file/);
  });

  it('rejects duplicate property names within an element', () => {
    const text =
      'ply\nformat binary_little_endian 1.0\nelement vertex 1\n' +
      'property float x\nproperty float y\nproperty float x\nend_header\n';
    expect(() => parsePlyHeader(new TextEncoder().encode(text).buffer)).toThrow(
      /Duplicate PLY property "x" in element "vertex"/,
    );
  });

  it('rejects a scalar property duplicating a list property name', () => {
    const text =
      'ply\nformat binary_little_endian 1.0\nelement face 1\n' +
      'property list uchar int vertex_indices\nproperty float vertex_indices\nend_header\n';
    expect(() => parsePlyHeader(new TextEncoder().encode(text).buffer)).toThrow(
      /Duplicate PLY property "vertex_indices"/,
    );
  });
});

describe('packPaletteSh row bounds', () => {
  it('rejects a label whose entry would wrap past the palette row', () => {
    const bands = 1 as const;
    const have = shCoefficientCount(bands); // 3 texels per entry
    // Width fits exactly one entry; label 1 starts at column 3 and would
    // wrap onto the next row. The linear index still lands inside the
    // palette, so only the per-row check catches it.
    const sh: SplatShData = {
      bands,
      labels: Uint32Array.from([1]),
      palette: new Float32Array(have * 4 * 4),
      paletteWidth: have,
      paletteHeight: 4,
    };
    expect(() => packPaletteSh(sh, 1, bands)).toThrow(/SH label 1 outside the palette/);
  });
});

describe('parseSplat sanity checks', () => {
  it('rejects a 32-byte-divisible file whose first position is not finite', () => {
    const buffer = new ArrayBuffer(32);
    new DataView(buffer).setFloat32(0, Number.NaN, true);
    expect(() => parseSplat(buffer)).toThrow(/non-finite position/);
  });
});
