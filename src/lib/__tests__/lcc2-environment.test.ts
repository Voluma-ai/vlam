import { describe, expect, it, vi } from 'vitest';
import { buildLcc2Scene } from '../formats/lcc/lcc2';
import type { SplatDatasetSource } from '../streaming/dataset-source';

/**
 * Tests for the always-resident environment/background tile an `.lcc2`
 * manifest names in `root.data.env` (M12). The tile has no LOD ladder and no
 * declared splat count - only its file index is in the manifest.
 */

const OPTIONS = { budget: 1000, lodBaseDistance: 10, lodMultiplier: 2 };

function dataset(missing: string[] = []): SplatDatasetSource {
  return {
    manifestUrl: 'https://host/scene.lcc2',
    resolve: (path) => (missing.includes(path) ? null : `https://host/${path}`),
    size: () => Promise.resolve(null),
    directoryFiles: () => null,
    dispose: () => {},
  };
}

function box(
  min: number,
  max: number,
): { min: [number, number, number]; max: [number, number, number] } {
  return { min: [min, min, min], max: [max, max, max] };
}

/** A two-leaf octree; `env` names an optional environment tile on the root. */
function manifest(options: { splatFiles?: string[]; env?: number } = {}): unknown {
  const leaf = (index: number) => ({
    boundingBox: box(index, index + 1),
    data: { '3dgs': { name: 0, start: index * 10, count: 10 } },
  });
  return {
    version: '0.0.2',
    totalLevels: 2,
    lodSplats: [20],
    root: {
      boundingBox: box(0, 2),
      splatFiles: options.splatFiles ?? ['data/3dgs/0_0.sog', 'data/3dgs/env.sog'],
      ...(options.env !== undefined ? { data: { env: { name: options.env } } } : {}),
      child: { '0': leaf(0), '1': leaf(1) },
    },
  };
}

describe('buildLcc2Scene environment tile', () => {
  it('exposes the env tile named by root.data.env, pinned', () => {
    const scene = buildLcc2Scene(manifest({ env: 1 }), dataset(), OPTIONS);

    expect(scene.environment).toEqual({ file: 1 });
    // Pinned so an LOD reschedule never cancels its fetch.
    expect(scene.pinnedFiles.has(1)).toBe(true);
    // Its URL is a normal chunk URL (env.sog is just another splatFiles entry).
    expect(scene.chunkUrls[1]).toBe('https://host/data/3dgs/env.sog');
  });

  it('reports no environment for a manifest without root.data.env', () => {
    const scene = buildLcc2Scene(manifest(), dataset(), OPTIONS);

    expect(scene.environment).toBeUndefined();
  });

  it('warns and skips an env index the manifest does not list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = buildLcc2Scene(manifest({ env: 7 }), dataset(), OPTIONS);

    expect(scene.environment).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
