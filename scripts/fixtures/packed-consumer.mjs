import assert from 'node:assert/strict';
import { SplatMesh, createWebGPURenderer } from '@voluma/vlam';
import { loadSplatData } from '@voluma/vlam/loaders';
import { UnifiedSplatMesh } from '@voluma/vlam/unified';
import { radixSort } from '@voluma/vlam/sorting/radix';
import { computeProjection } from '@voluma/vlam/projection/compute';

assert.equal(typeof SplatMesh, 'function');
assert.equal(typeof createWebGPURenderer, 'function');
assert.equal(typeof loadSplatData, 'function');
assert.equal(typeof UnifiedSplatMesh, 'function');
assert.equal(typeof radixSort, 'function');
assert.equal(typeof computeProjection, 'function');

for (const path of [
  '@voluma/vlam/static-lod',
  '@voluma/vlam/relighting',
  '@voluma/vlam/streaming',
  '@voluma/vlam/selection',
  '@voluma/vlam/effects',
  '@voluma/vlam/formats/ply',
  '@voluma/vlam/formats/sog',
  '@voluma/vlam/formats/rad',
  '@voluma/vlam/formats/lcc',
  '@voluma/vlam/formats/spz',
  '@voluma/vlam/formats/splat',
  '@voluma/vlam/formats/ksplat',
]) {
  assert.ok(Object.keys(await import(path)).length > 0, path);
}
