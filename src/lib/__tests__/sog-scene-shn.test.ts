import { describe, expect, it } from 'vitest';
import { buildSogScene } from '../streaming/lod-source';
import type { SplatDatasetSource } from '../streaming/dataset-source';

/**
 * Tests that opting into streamed-SOG view-dependent color (M11) wires the
 * scene the pool and worker need: `shBands` set, and every chunk carrying the
 * pack-bands directive so its palette shN is converted at decode.
 */

const OPTIONS = { budget: 1000, lodBaseDistance: 10, lodMultiplier: 2 };

function httpDataset(): SplatDatasetSource {
  return {
    manifestUrl: 'https://host/lod-meta.json',
    resolve: (path) => `https://host/${path}`,
    size: () => Promise.resolve(null),
    directoryFiles: () => null, // over HTTP the worker resolves images itself
    dispose: () => {},
  };
}

/** A one-leaf, two-chunk Streamed SOG manifest. */
function manifest(): unknown {
  return {
    version: 1,
    counts: [20, 10],
    lodLevels: 2,
    filenames: ['0_0/meta.json', '0_1/meta.json'],
    tree: {
      bound: { min: [0, 0, 0], max: [1, 1, 1] },
      lods: {
        '0': { file: 0, offset: 0, count: 20 },
        '1': { file: 1, offset: 0, count: 10 },
      },
    },
  };
}

describe('buildSogScene view-dependent color (M11)', () => {
  it('leaves SH off by default (historical behavior)', () => {
    const scene = buildSogScene(manifest(), httpDataset(), OPTIONS);
    expect(scene.shBands ?? 0).toBe(0);
    // No per-chunk SH directive over HTTP without files or SH.
    expect(scene.chunkOptions).toBeUndefined();
  });

  it('sets shBands and a pack directive on every chunk when opted in', () => {
    const scene = buildSogScene(manifest(), httpDataset(), OPTIONS, 2);
    expect(scene.shBands).toBe(2);
    expect(scene.chunkOptions).toHaveLength(scene.chunkUrls.length);
    for (const options of scene.chunkOptions ?? []) {
      expect(options?.format).toBe('sog');
      expect(options?.sog).toEqual({ packShBands: 2 });
    }
  });
});
