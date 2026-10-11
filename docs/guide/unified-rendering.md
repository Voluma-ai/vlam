# Unified rendering

Two overlapping splat meshes cannot blend correctly as separate three.js
draws, transparency needs one global back-to-front order.
`UnifiedSplatMesh` gathers every registered source (fully loaded and streamed)
into one work buffer, sorts them together, and draws them as a single
transparent mesh. **WebGPU only.** Its constructor, source registration and
removal, visibility and opacity controls, update, picking, secondary views,
diagnostics, and disposal form the high-level 1.0 compatibility contract.
The GPU-facing `UnifiedSourceView` returned by
`SplatMesh.getUnifiedSourceView()` remains experimental even though the
compositor consumes it internally.

## Gate on support

```ts
import { UnifiedSplatMesh, supportsUnifiedSplatMesh } from '@voluma/vlam/unified';

// Check after renderer init: answers false on WebGL2 (and before the
// backend exists). Fall back to standalone draws there.
if (!supportsUnifiedSplatMesh(renderer)) {
 scene.add(main, statue); // standalone SplatMesh draws, or MergedSplatMesh
}
```

On WebGL2, standalone meshes remain first-class; for several fully loaded
clouds there, `MergedSplatMesh` inter-sorts them in one shared pool, and for a
streamed scene plus other meshes the pooled draw below does.

## WebGL2: the pooled unified draw

`PooledUnifiedSplatMesh` (`@voluma/vlam/unified/pooled`, a separate entry so a
WebGPU host never loads it) gives WebGL2 the same global order without compute
passes. The trade: every source must draw from **one** `SplatPool` that the
host allocates up front, because a single draw can only index one set of pool
textures. The sources' exact active lists are concatenated into one worker
sort keyed by each source's world matrix, and the resulting order feeds the
draw's `splatIndex` / `sourceId` instance attributes - nothing is gathered or
copied.

```ts
import { SplatPool } from '@voluma/vlam';
import { supportsUnifiedSplatMesh } from '@voluma/vlam/unified';

const pool = new SplatPool({ capacity: 6_000_000, allowLatePackedSh: true });
const main = await StreamedSplatMesh.load('/city/lod-meta.json', { pool, budget: 4_000_000 });
const statue = new SplatMesh(await loadSplatData('/statue.sog'), { pool });

if (!supportsUnifiedSplatMesh(renderer)) {
  const { PooledUnifiedSplatMesh } = await import('@voluma/vlam/unified/pooled');
  const unified = new PooledUnifiedSplatMesh(renderer, pool, { sortMetric: 'depth' });
  unified.addSource(main);
  unified.addSource(statue, { opacity: 0.8 });
  scene.add(unified); // each frame: unified.update(camera)
}
```

What carries over from the compute path: `addSource` / `removeSource`,
`setSourceVisible`, `setSourceOpacity`, `update`, `pick`, `setDepthOfField`,
`displayColorModifier`, `getDrawPublicationSnapshot`, and the same
compatibility rules (`srgbOutput`, `maxStdDev`, `antialias`, the projected
filter profile and the contribution culls must agree). Per-source placement,
LOD alpha (`.rad` next to plain sources) and packed-SH range are applied per
source. `allowLatePackedSh` lets a pool created before the main's manifest is
known take that main's SH request instead of downgrading it.

What differs:

- **Stacks are handed over explicitly.** Call
  `unified.setSourceModifiers(source, source.modifiers)` for each source (every
  frame is fine: an element-wise identical list is a no-op). Each stack runs in
  its source's local frame, as the compute gather runs it, behind a branch on
  the splat's source id, so a splat pays only for its own source's effects. The
  pooled mesh's own `modifiers` then run on every splat in world space. Drive
  whole-source fades through `setSourceOpacity`, not an opacity modifier.
  Modifiers that read per-splat channels cannot build on it.
- **Mind WebGL2's uniform blocks.** Three emits each `uniformArray` as its own
  block and a vertex stage may bind as few as 12; many per-source effects
  should keep their rows in one shared data texture. After a structural change,
  `await unified.checkShaderBudget(camera)` compares the program's blocks and
  samplers with the device limits. An over-budget program draws nothing, so on
  `ok: false` hand every source an empty stack (`setSourceModifiers(source,
  [])`): the scene keeps its one global order and loses only the per-source
  effects. Falling back to separate draws instead would bring back the very
  artifact this mesh exists to remove.
- **Publication is asynchronous.** Like a standalone WebGL2 mesh, a changed
  stream or camera waits one worker round trip; the previous complete frame
  stays up meanwhile. `renderView` draws a secondary view through the primary
  order rather than re-sorting.
- **Capacity is the pool.** Nothing is ever dropped; size the pool for the
  main's staged-swap headroom plus every marker.
- A source may belong to one pooled mesh at a time; on WebGPU prefer
  `UnifiedSplatMesh`.

## Creating and registering sources

```ts
const main = await StreamedSplatMesh.load('/city/lod-meta.json');
const statue = new SplatMesh(await loadSplatData('/statue.sog'));
statue.position.set(4, 0, -2); // pose the SOURCE meshes, not the unified mesh

const unified = new UnifiedSplatMesh(renderer, main.capacity + statue.capacity);
unified.addSource(main);
unified.addSource(statue, { priority: 1, opacity: 0.8 });
scene.add(unified); // add the unified mesh INSTEAD of the sources

// Each frame: unified.update(camera) before renderer.render(scene, camera).
```

<!-- full file: docs/guide/samples/unified-basic.ts -->

The default uses counting sort and vertex projection. Experimental GPU paths
stay on their opt-in entries. Do not pass the strings `'radix'` or `'exact'`;
those are not valid `sortStrategy` values.

```ts
import { exactSort } from '@voluma/vlam/sorting/radix';
import { computeProjection } from '@voluma/vlam/projection/compute';

const experimental = new UnifiedSplatMesh(renderer, capacity, {
  sortStrategy: exactSort(),
  projectionStrategy: computeProjection(),
});
```

<!-- full file: docs/guide/samples/unified-experimental.ts -->

Rules of the road:

- **Sources keep their own pools, modifiers, and transforms.** Pose and
  animate the registered meshes; the unified mesh stays at identity.
- **Capacity is fixed** at construction. If a frame's sources exceed it,
  whole lowest-`priority` sources are dropped for that frame -
  `droppedSourceCount` / `droppedSplatCount` report it.
- All sources must agree on `srgbOutput` (a constructor option),
  `maxStdDev`, `antialias`, and the resolved `minPixelSize` /
  `minContribution` contribution culls. `UnifiedSplatMesh` defaults to the
  same device-aware profile as `SplatMesh`: `smooth` on mobile and
  fill-constrained desktops, `quality` elsewhere. Keep the same profile on the
  unified mesh and its sources.
- `unified.update(camera)` replaces the per-mesh `update` calls; do not also
  call `source.update()` yourself.

## Visibility, opacity, removal

```ts
unified.setSourceOpacity(statue, 0.5); // whole-source, after its modifiers
unified.setSourceVisible(statue, false); // excluded from draw AND pick
unified.removeSource(statue); // → true; restores standalone state
```

`removeSource` returns whether the source was registered, and, like
`dispose()`, restores the source's standalone visibility and picking, so
you can `scene.add(statue)` again afterwards.

## Per-source modifiers

Effects stay per source: set `mesh.modifiers` (or drive a `ModifierSlots`
stack) on each registered mesh exactly as in
[Effects & modifiers](effects-and-modifiers.md); the unified gather folds each
source's stack in. Keep modifier identities stable, the unified renderer
rebuilds a source's gather pipeline only when that source's stack structurally
changes.

## Depth of field

`unified.setDepthOfField({ focusDistance, aperture })` applies the core
projected-2D camera DoF across all sources at draw time, a pure uniform
write, no recompile (`aperture: 0` turns it off).

## Picking across sources

Every **visible** source runs its own depth pick; the hit nearest the camera
wins and identifies its source, exactly what the unified draw composites:

```ts
const ndc = new THREE.Vector2(
  (event.clientX / innerWidth) * 2 - 1,
  -(event.clientY / innerHeight) * 2 + 1,
);
// Every VISIBLE source runs its own depth pick; the hit nearest the camera
// wins and names its source. Hidden sources never hit; null on a miss.
const hit = await unified.pick(ndc, camera, { alphaThreshold: 0.1 });
if (hit) {
  console.log(hit.source === mainMesh ? 'main scene' : 'other source', hit.point, hit.distance);
  // Rack the shared camera depth of field onto whatever was clicked -
  // a pure uniform write, applied at draw time across all sources.
  unified.setDepthOfField({ focusDistance: hit.distance, aperture: 0.02 });
}
```

<!-- full file: docs/guide/samples/unified-pick.ts -->

Hidden sources never hit; a hit whose source was removed or disposed while
its readback was in flight is dropped, never misattributed; no sources, all
misses, or a pick pending across `dispose()` resolve `null`.

## Capacity planning and WebGPU limits

Unified work buffers cost **16 bytes of storage per splat of capacity**, and
WebGPU's default `maxStorageBufferBindingSize` is 128 MiB, so capacities
above ~8M splats need raised limits, requested at renderer creation.
`createWebGPURenderer()` requests them for you; the explicit adapter below is
here because the optional pre-flight check needs the `adapter` handle itself.

```ts
import { deviceMaxStorageBufferBindingSize, recommendedWebGpuRequiredLimits } from '@voluma/vlam';
import {
  UnifiedSplatMesh,
  estimateLargestStorageBufferBytes,
} from '@voluma/vlam/unified';

const adapter = await navigator.gpu?.requestAdapter();
const renderer = new THREE.WebGPURenderer({
 ...(adapter ? { requiredLimits: recommendedWebGpuRequiredLimits(adapter) } : {}),
});
await renderer.init();

// Optional pre-flight: how much storage would this capacity bind, and what
// does the device allow? (The constructor performs this check itself and
// throws a clear error instead of cascading GPUValidationErrors.)
const needed = estimateLargestStorageBufferBytes(capacity);
const allowed = deviceMaxStorageBufferBindingSize(renderer);
console.log(`need ${needed} B of ${allowed} B allowed`);

const unified = new UnifiedSplatMesh(renderer, capacity, { srgbOutput: false });
```

<!-- full file: docs/guide/samples/unified-capacity.ts -->

## Dispose

`unified.dispose()` frees the work buffers and sorter and restores every
remaining source's standalone visibility and picking, the sources themselves
are yours to keep or `dispose()` separately.

## Next

[Terminology](terminology.md) for source vs mesh.
[Effects & modifiers](effects-and-modifiers.md), per-source shader effects
that survive unified rendering.
