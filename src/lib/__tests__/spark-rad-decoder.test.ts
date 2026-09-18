import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installNodeWorkerPolyfill } from './helpers/node-worker-polyfill';
import {
  parseRadChunkStreaming,
  parseRadHeaderMeta,
  RAD_CHUNK_MAGIC,
  RAD_MAGIC,
} from '../formats/rad/parse-rad';
import { explainFrontierNode, frontierView, traverseFrontier } from '../formats/rad/rad-frontier';

installNodeWorkerPolyfill();

/**
 * Spark 2.1 lod-tree packing (`encode_lod_tree` in splat_encode.rs):
 * word0 = f16(x) | f16(y)<<16, word1 = f16(z) | f16(size)<<16,
 * word2 = child_count, word3 = child_start.
 * Size is `2 · expansion(α) · avg(scale)` with expansion 1 at α≤1 and
 * `1 + 0.7·(4α−4)` above, matching VLAM's streamed parser.
 */
function f16FromBits(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * (mantissa / 1024) * 2 ** -14;
  if (exponent === 31) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function unpackSparkLodNode(
  words: Uint32Array,
  index: number,
): {
  center: [number, number, number];
  size: number;
  childCount: number;
  childStart: number;
} {
  const base = index * 4;
  const w0 = words[base] as number;
  const w1 = words[base + 1] as number;
  return {
    center: [f16FromBits(w0 & 0xffff), f16FromBits(w0 >>> 16), f16FromBits(w1 & 0xffff)],
    size: f16FromBits(w1 >>> 16),
    childCount: (words[base + 2] as number) & 0xffff,
    childStart: words[base + 3] as number,
  };
}

interface Property {
  readonly name: string;
  readonly encoding: string;
  readonly bytes: number[];
}

function roundup8(size: number): number {
  return (size + 7) & ~7;
}

function padTo(bytes: number[], length: number): number[] {
  const padded = bytes.slice();
  while (padded.length < length) padded.push(0);
  return padded;
}

function f32Bytes(...values: number[]): number[] {
  const buffer = new ArrayBuffer(values.length * 4);
  const view = new DataView(buffer);
  values.forEach((value, i) => view.setFloat32(i * 4, value, true));
  return Array.from(new Uint8Array(buffer));
}

function u16Bytes(...values: number[]): number[] {
  const buffer = new ArrayBuffer(values.length * 2);
  const view = new DataView(buffer);
  values.forEach((value, i) => view.setUint16(i * 2, value, true));
  return Array.from(new Uint8Array(buffer));
}

function u32Bytes(...values: number[]): number[] {
  const buffer = new ArrayBuffer(values.length * 4);
  const view = new DataView(buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value, true));
  return Array.from(new Uint8Array(buffer));
}

function planarF32(dims: number, rows: readonly number[][]): number[] {
  const bytes: number[] = [];
  for (let d = 0; d < dims; d++) {
    for (const row of rows) bytes.push(...f32Bytes(row[d] as number));
  }
  return bytes;
}

function buildChunk(count: number, properties: readonly Property[]): Uint8Array {
  let offset = 0;
  const propMeta = properties.map((prop) => {
    const meta = { offset, bytes: prop.bytes.length, property: prop.name, encoding: prop.encoding };
    offset += roundup8(prop.bytes.length);
    return meta;
  });
  const payload = properties.flatMap((prop) => padTo(prop.bytes, roundup8(prop.bytes.length)));
  const chunkMeta = {
    version: 1,
    base: 0,
    count,
    payloadBytes: payload.length,
    lodTree: true,
    properties: propMeta,
  };
  const metaJson = Array.from(new TextEncoder().encode(JSON.stringify(chunkMeta)));
  const metaPadded = padTo(metaJson, roundup8(metaJson.length));
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, RAD_CHUNK_MAGIC, true);
  new DataView(header.buffer).setUint32(4, metaJson.length, true);
  const payloadSizeBytes = new Uint8Array(8);
  new DataView(payloadSizeBytes.buffer).setBigUint64(0, BigInt(payload.length), true);
  return new Uint8Array([...header, ...metaPadded, ...payloadSizeBytes, ...payload]);
}

function wrapChunkAsRadFile(chunk: Uint8Array, splatCount: number, chunkSize = 65536): Uint8Array {
  const meta = {
    version: 1,
    type: 'gsplat',
    count: splatCount,
    lodTree: true,
    chunkSize,
    allChunkBytes: chunk.byteLength,
    chunks: [{ offset: 0, bytes: chunk.byteLength }],
  };
  const metaJson = Array.from(new TextEncoder().encode(JSON.stringify(meta)));
  const metaPadded = padTo(metaJson, roundup8(metaJson.length));
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, RAD_MAGIC, true);
  new DataView(header.buffer).setUint32(4, metaJson.length, true);
  const bytes = new Uint8Array(header.length + metaPadded.length + chunk.byteLength);
  bytes.set(header, 0);
  bytes.set(metaPadded, header.length);
  bytes.set(chunk, header.length + metaPadded.length);
  return bytes;
}

function syntheticLodRad(): { file: Uint8Array; leaf: number; merged: number } {
  const properties: Property[] = [
    {
      name: 'center',
      encoding: 'f32',
      bytes: planarF32(3, [
        [1, 2, 3],
        [4, 5, 6],
      ]),
    },
    { name: 'alpha', encoding: 'f32', bytes: planarF32(1, [[1], [2]]) },
    {
      name: 'rgb',
      encoding: 'f32',
      bytes: planarF32(3, [
        [1, 1, 1],
        [1, 1, 1],
      ]),
    },
    {
      name: 'scales',
      encoding: 'f32',
      bytes: planarF32(3, [
        [1, 1, 1],
        [1, 1, 1],
      ]),
    },
    {
      name: 'orientation',
      encoding: 'f32',
      bytes: planarF32(3, [
        [0, 0, 0],
        [0, 0, 0],
      ]),
    },
    { name: 'child_count', encoding: 'u16', bytes: u16Bytes(0, 2) },
    { name: 'child_start', encoding: 'u32', bytes: u32Bytes(0, 7) },
  ];
  const chunk = buildChunk(2, properties);
  return { file: wrapChunkAsRadFile(chunk, 2, 65536), leaf: 0, merged: 1 };
}

const SPARK_21_MODULE = resolve(
  import.meta.dirname,
  '../../../.tmp/spark-2.1/package/dist/spark.module.js',
);
const JG_CHUNK0 = resolve(import.meta.dirname, '../../../.tmp/jg-chunk0.radc');

type SparkPacked = {
  PackedSplats: new (options: { fileBytes: ArrayBuffer | Uint8Array; fileName: string }) => {
    initialized: Promise<unknown>;
    numSplats: number;
    extra: Record<string, unknown>;
    getSplat?: (index: number) => { center: { x: number; y: number; z: number } };
  };
};

async function decodeWithSpark(fileBytes: Uint8Array, fileName: string) {
  const spark = (await import(SPARK_21_MODULE)) as SparkPacked;
  const packed = new spark.PackedSplats({
    fileBytes: new Uint8Array(fileBytes),
    fileName,
  });
  await packed.initialized;
  const decoded =
    packed.numSplats > 0 ? packed : ((packed as { lodSplats?: typeof packed }).lodSplats ?? packed);
  const extra = decoded.extra ?? {};
  const lodTree = (extra.lodTree ?? extra.lod_tree) as Uint32Array | undefined;
  if (!(lodTree instanceof Uint32Array)) {
    throw new Error(
      `Spark lodTree missing; extra keys: ${Object.keys(extra).join(',') || '(none)'}; numSplats=${decoded.numSplats}`,
    );
  }
  return { packed: decoded, lodTree };
}

function chunkBuffer(file: Uint8Array): ArrayBuffer {
  const copy = file.slice();
  const { chunksStart } = parseRadHeaderMeta(copy.buffer);
  return copy.subarray(chunksStart).slice().buffer;
}

describe('Spark 2.1 RAD decoder parity', () => {
  it('decodes a synthetic lod-tree chunk through VLAM with tagged 3.8 sizes', async () => {
    const { file } = syntheticLodRad();
    const data = await parseRadChunkStreaming(chunkBuffer(file), undefined, undefined, false);
    const merged = data.radTree!.childCount[0] === 2 ? 0 : 1;
    const leaf = 1 - merged;
    expect(data.radTree?.childCount[leaf]).toBe(0);
    expect(data.radTree?.childCount[merged]).toBe(2);
    expect(data.radTree?.childStart[merged]).toBe(7);
    expect(data.radTree?.size[merged]).toBeCloseTo(7.6, 5);
    expect(data.positions[merged * 3]).toBeCloseTo(4, 5);
  });

  it.skipIf(!existsSync(SPARK_21_MODULE))(
    'matches Spark 2.1 WASM child links and hierarchy sizes on a synthetic fixture',
    async () => {
      const { file } = syntheticLodRad();
      const vlam = await parseRadChunkStreaming(chunkBuffer(file), undefined, undefined, false);
      const { lodTree, packed } = await decodeWithSpark(file, 'fixture.rad');
      expect(packed.numSplats).toBe(vlam.count);
      expect(lodTree.length).toBe(vlam.count * 4);
      for (let i = 0; i < vlam.count; i++) {
        const sparkNode = unpackSparkLodNode(lodTree, i);
        expect(sparkNode.childCount).toBe(vlam.radTree!.childCount[i]);
        expect(sparkNode.childStart).toBe(vlam.radTree!.childStart[i]);
        const vlamSize = vlam.radTree!.size[i] as number;
        expect(Math.abs(sparkNode.size - vlamSize)).toBeLessThan(0.05 * Math.max(1, vlamSize));
        const dx = Math.abs(sparkNode.center[0] - (vlam.positions[i * 3] as number));
        const dy = Math.abs(sparkNode.center[1] - (vlam.positions[i * 3 + 1] as number));
        const dz = Math.abs(sparkNode.center[2] - (vlam.positions[i * 3 + 2] as number));
        const flipped =
          Math.abs(sparkNode.center[1] + (vlam.positions[i * 3 + 1] as number)) +
          Math.abs(sparkNode.center[2] + (vlam.positions[i * 3 + 2] as number));
        expect(Math.min(dx + dy + dz, dx + flipped)).toBeLessThan(0.05);
      }
    },
    60_000,
  );

  it.skipIf(!existsSync(SPARK_21_MODULE) || !existsSync(JG_CHUNK0))(
    'matches Spark 2.1 WASM on the actual JG chunk 0 and reports the first differing node',
    async () => {
      const chunk = new Uint8Array(readFileSync(JG_CHUNK0));
      const vlam = await parseRadChunkStreaming(chunk.buffer, undefined, undefined, false);
      const file = wrapChunkAsRadFile(chunk, vlam.count, 65536);
      const { lodTree } = await decodeWithSpark(file, 'jg-chunk0.rad');
      expect(vlam.radTree).toBeDefined();
      expect(lodTree.length).toBe(vlam.count * 4);
      let internals = 0;
      let firstDiff: {
        index: number;
        field: string;
        vlam: number;
        spark: number;
      } | null = null;
      for (let i = 0; i < vlam.count; i++) {
        const sparkNode = unpackSparkLodNode(lodTree, i);
        const childCount = vlam.radTree!.childCount[i] as number;
        const childStart = vlam.radTree!.childStart[i] as number;
        const size = vlam.radTree!.size[i] as number;
        if (childCount > 0) internals++;
        if (firstDiff) continue;
        if (sparkNode.childCount !== childCount) {
          firstDiff = {
            index: i,
            field: 'childCount',
            vlam: childCount,
            spark: sparkNode.childCount,
          };
        } else if (sparkNode.childStart !== childStart) {
          firstDiff = {
            index: i,
            field: 'childStart',
            vlam: childStart,
            spark: sparkNode.childStart,
          };
        } else if (Math.abs(sparkNode.size - size) > 0.05 * Math.max(1, size)) {
          firstDiff = { index: i, field: 'size', vlam: size, spark: sparkNode.size };
        }
      }
      expect(internals).toBeGreaterThan(0);
      expect(firstDiff).toBeNull();
      const isChild = new Uint8Array(vlam.count);
      for (let i = 0; i < vlam.count; i++) {
        const childCount = vlam.radTree!.childCount[i] as number;
        if (childCount === 0) continue;
        const start = vlam.radTree!.childStart[i] as number;
        for (let k = 0; k < childCount; k++) {
          const local = start + k;
          if (local >= 0 && local < vlam.count) isChild[local] = 1;
        }
      }
      let roots = 0;
      for (let i = 0; i < vlam.count; i++) if (isChild[i] === 0) roots++;
      expect(vlam.radTree!.childCount[0]).toBeGreaterThan(0);
      expect(
        roots,
        `chunk-0 roots=${roots} node0 childCount=${vlam.radTree!.childCount[0]} childStart=${vlam.radTree!.childStart[0]} internals=${internals}`,
      ).toBe(1);
    },
    60_000,
  );

  it.skipIf(!existsSync(JG_CHUNK0))(
    'refuses to subdivide JG chunk-0 internals whose children live in later chunks',
    async () => {
      const chunk = new Uint8Array(readFileSync(JG_CHUNK0));
      const vlam = await parseRadChunkStreaming(chunk.buffer, undefined, undefined, false);
      const cache = new Map([[0, vlam]]);
      const origin = {
        x: vlam.positions[0] as number,
        y: vlam.positions[1] as number,
        z: (vlam.positions[2] as number) - 1,
      };
      const view = frontierView(origin, { x: 0, y: 0, z: 1 });
      const result = traverseFrontier(cache, [0], 65536, view, 1e-6, 7_500_000, {
        collectDiagnostics: true,
      });
      expect(result.touched.size).toBeGreaterThan(0);
      const missing = result.notables
        .map((node) =>
          explainFrontierNode(cache, node.global, 65536, view, 1e-6, 7_500_000, {
            count: result.count,
            budgetClamped: result.budgetClamped,
          }),
        )
        .find((sample) => sample?.reason === 'missing-children');
      expect(missing, JSON.stringify(result.notables.slice(0, 3))).toMatchObject({
        reason: 'missing-children',
        childCount: expect.any(Number),
      });
      expect(missing!.childCount).toBeGreaterThan(0);
      expect(missing!.missingFiles.length).toBeGreaterThan(0);
    },
  );
});
