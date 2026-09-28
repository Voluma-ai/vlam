import * as THREE from 'three';
import type { StreamedSplatMesh } from '../lib/streaming/streamed-splat-mesh';

/** Benchmark-only CPU publication snapshot, collected after frame sampling. */
export interface RadSelectionSnapshot {
  scope: 'cpu-published-rad-selection';
  capturedAtMs: number;
  chunkSize: number;
  globalIds: number[];
  positionSamples: { globalId: number; worldPosition: number[] }[];
  sourceAttributes?: Record<string, number>;
}

function assertGlobalIds(ids: number[]): void {
  if (new Set(ids).size !== ids.length)
    throw new Error('RAD selection contains duplicate node IDs');
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 0 || id >= 0xffffffff)) {
    throw new Error('RAD selection contains invalid node IDs');
  }
}

export function snapshotVlamRadSelection(mesh: StreamedSplatMesh): RadSelectionSnapshot {
  if (mesh.radStrategy !== 'page-table')
    throw new Error('RAD selection requires page-table sources');
  const view = mesh.getUnifiedSourceView();
  const adapter = mesh as unknown as {
    pageTableGlobals: Uint32Array;
    scene: { chunkSize?: number };
  };
  const slots = view.sourceIndex.array;
  if (view.activeCount > slots.length) throw new Error('RAD active list exceeds its buffer');
  const globalIds = Array.from({ length: view.activeCount }, (_, i) => {
    const slot = slots[i]!;
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= adapter.pageTableGlobals.length) {
      throw new Error('RAD source slot is outside its node map');
    }
    return adapter.pageTableGlobals[slot]!;
  });
  assertGlobalIds(globalIds);
  const chosen = new Set([...globalIds].sort((a, b) => a - b).slice(0, 1024));
  const texture = view.centersTexture;
  const data = texture.image.data as Uint32Array | Uint16Array | Float32Array;
  const word = new Uint32Array(1);
  const float = new Float32Array(word.buffer);
  const scalar = (index: number): number => {
    const value = data[index]!;
    if (texture.format === THREE.RGBAIntegerFormat) {
      word[0] = value;
      return float[0]!;
    }
    return texture.type === THREE.HalfFloatType ? THREE.DataUtils.fromHalfFloat(value) : value;
  };
  const point = new THREE.Vector3();
  const positionSamples: RadSelectionSnapshot['positionSamples'] = [];
  for (let i = 0; i < globalIds.length; i++) {
    const id = globalIds[i]!;
    if (!chosen.has(id)) continue;
    const offset = slots[i]! * 4;
    if (offset + 2 >= data.length) throw new Error('RAD center sample exceeds its texture data');
    point
      .set(scalar(offset), scalar(offset + 1), scalar(offset + 2))
      .applyMatrix4(view.matrixWorld);
    if (![point.x, point.y, point.z].every(Number.isFinite))
      throw new Error('RAD center sample is not finite');
    positionSamples.push({ globalId: id, worldPosition: point.toArray() });
  }
  return {
    scope: 'cpu-published-rad-selection',
    capturedAtMs: performance.now(),
    chunkSize: adapter.scene.chunkSize ?? 65536,
    globalIds,
    positionSamples,
    sourceAttributes: {
      modifierCount: view.modifiers.length,
      centerTextureFormat: texture.format,
      centerTextureType: texture.type,
      activeListVersion: view.activeListVersion,
      contentRevision: view.contentRevision,
    },
  };
}

/** Direct resident indices are provisional global IDs until decoded positions match. */
export function copyResidentRadSelection(
  indices: Uint32Array,
  count: number,
  total: number,
): number[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > indices.length)
    throw new Error('RAD resident selection is incomplete');
  const ids = Array.from(indices.subarray(0, count));
  assertGlobalIds(ids);
  if (ids.some((id) => id >= total)) throw new Error('RAD resident index exceeds its node buffer');
  return ids;
}

/** Opt-in viewer hook; the CLI invokes it only after frame sampling finishes. */
export function installRadSelectionSnapshot(
  snapshot: () => RadSelectionSnapshot | Promise<RadSelectionSnapshot>,
): void {
  (
    globalThis as typeof globalThis & {
      __VLAM_BENCHMARK_RAD_SELECTION__?: typeof snapshot;
    }
  ).__VLAM_BENCHMARK_RAD_SELECTION__ = snapshot;
}
