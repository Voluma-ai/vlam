import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { estimateSceneDecodedBytes } from '../streaming/streamed-splat-mesh';
import type { LodSource, StreamedScene } from '../streaming/lod-source';

/**
 * This number sizes the page-table worker's cache floor, and it is the whole
 * defence against the frontier thrashing: a cache smaller than the working set
 * evicts chunks the very next traversal asks for again, so streaming never ends
 * and the view never settles.
 *
 * It sizes *decoded chunks*, so it has to count every splat a chunk carries.
 * `contentSplatCount` is not that number for a LOD tree - for `.rad` it is the
 * **leaf** count, while a chunk also holds the internal merged nodes a coarse
 * frontier actually draws.
 */

/** A scene stub carrying only the fields the estimate reads. */
function makeScene(overrides: Partial<StreamedScene>): StreamedScene {
  return {
    source: {} as unknown as LodSource,
    chunkUrls: [],
    bounds: new THREE.Box3(),
    maxResidentSplats: 1_000,
    ...overrides,
  } as StreamedScene;
}

/**
 * Positions 12 + colors 4 + covariances 24 + the LOD tree's `childCount`,
 * `childStart` and `size` (4 each), with no SH. The tree arrays are retained for
 * a cached chunk's whole life and are exactly what the traversal reads, so the
 * worker charges them to its cache - this estimate has to agree, or the floor
 * sits below the working set it was computed to cover.
 */
const BYTES_PER_SPLAT = 52;

describe('estimateSceneDecodedBytes', () => {
  it('counts every splat in the chunks, not just the leaves', () => {
    // The reference `.rad`: 131 chunks x 65536 = 8,585,216 nodes in the tree,
    // against 5,880,090 leaves. Sizing from leaves alone under-counted by 32%
    // and put the floor *below* the working set, which showed up on an iPhone as
    // resident chunks oscillating 75/76 with a refetch every couple of seconds.
    const scene = makeScene({
      chunkSize: 65_536,
      chunkUrls: Array.from({ length: 131 }, (_, i) => `chunk-${i}.radc`),
      contentSplatCount: 5_880_090,
      maxResidentSplats: 1_000_000,
    });
    expect(estimateSceneDecodedBytes(scene)).toBe(131 * 65_536 * BYTES_PER_SPLAT);
  });

  it('is an over-estimate of the leaf count, never an under-estimate', () => {
    // The docstring's contract, and the property that actually matters: the
    // floor must never be the reason a capture cannot hold itself.
    const scene = makeScene({
      chunkSize: 65_536,
      chunkUrls: Array.from({ length: 131 }, (_, i) => `chunk-${i}.radc`),
      contentSplatCount: 5_880_090,
    });
    expect(estimateSceneDecodedBytes(scene)).toBeGreaterThan(5_880_090 * BYTES_PER_SPLAT);
  });

  it('falls back to the content count when the scene has no chunk size', () => {
    // Formats that do not declare `chunkSize` (no page table) keep the old
    // behaviour rather than silently sizing from an empty chunk list.
    const scene = makeScene({ contentSplatCount: 2_000_000, maxResidentSplats: 500_000 });
    expect(estimateSceneDecodedBytes(scene)).toBe(2_000_000 * BYTES_PER_SPLAT);
  });

  it('falls back to the resident ceiling when there is no content count either', () => {
    expect(estimateSceneDecodedBytes(makeScene({ maxResidentSplats: 750_000 }))).toBe(
      750_000 * BYTES_PER_SPLAT,
    );
  });

  it('includes packed SH when the scene carries it', () => {
    // SH is the larger half of a decoded chunk at 3 bands, so a cache floor that
    // ignored it would be wrong by more than the bug above.
    const base = { chunkSize: 1_000, chunkUrls: ['a'] };
    const withSh = estimateSceneDecodedBytes(makeScene({ ...base, shBands: 3 }));
    const withoutSh = estimateSceneDecodedBytes(makeScene(base));
    // 15 coefficients -> 4 RGBA32UI textures -> 64 B/splat on top of the 40.
    expect(withSh).toBe(1_000 * (BYTES_PER_SPLAT + 64));
    expect(withSh).toBeGreaterThan(withoutSh);
  });

  it('never returns zero for a degenerate scene', () => {
    expect(estimateSceneDecodedBytes(makeScene({ maxResidentSplats: 0 }))).toBeGreaterThan(0);
  });
});
