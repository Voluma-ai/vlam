# Unified rendering

Two overlapping splat meshes cannot blend correctly as separate three.js
draws, transparency needs one global back-to-front order.
`UnifiedSplatMesh` gathers every registered source (fully loaded and streamed)
into one work buffer, sorts them together, and draws them as a single
transparent mesh. **WebGPU only.**

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
clouds there, `MergedSplatMesh` inter-sorts them in one shared pool.

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

Rules of the road:

- **Sources keep their own pools, modifiers, and transforms.** Pose and
  animate the registered meshes; the unified mesh stays at identity.
- **Capacity is fixed** at construction. If a frame's sources exceed it,
  whole lowest-`priority` sources are dropped for that frame -
  `droppedSourceCount` / `droppedSplatCount` report it.
- All sources must agree on `srgbOutput` (a constructor option),
  `maxStdDev`, and `antialias`.
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
