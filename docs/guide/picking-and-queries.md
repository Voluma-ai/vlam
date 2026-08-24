# Picking & queries

Three ways to ask "what is under / near this point": an asynchronous GPU
pick that follows exactly what is drawn, and two synchronous CPU queries
over the resident splat centers. Background:
the public JSDoc.

## GPU picking: `SplatMesh.pick`

An async one-pixel GPU depth pass returning the world-space hit on the
frontmost **visible** splat, it shares the display material's projection,
modifiers, and Gaussian falloff, so hidden or streamed-out splats are never
picked. Works on WebGPU and WebGL2.

```ts
const ndc = new THREE.Vector2(
  (event.clientX / innerWidth) * 2 - 1,
  -(event.clientY / innerHeight) * 2 + 1,
);
// Async one-pixel GPU depth pass; follows what is actually drawn
// (modifiers, streamed LOD included). Null on a miss, never a throw.
const hit = await splats.pick(ndc, camera, renderer, { alphaThreshold: 0.1 });
if (hit) {
  // hit.point is world space; hit.distance is camera → point.
  console.log('picked', hit.point, hit.distance);
}
```

<!-- full file: docs/guide/samples/picking-basic.ts -->

`alphaThreshold` (default 0.1) is the minimum opacity, falloff × splat
alpha, for a fragment to count; raise it to ignore wispy fringes. The result
is the splat's **rendered center plane** at that pixel, a world point, not a
persistent splat id or collision surface. Suitable for click-to-focus and
placement anchors. It is robust by contract: empty meshes, mid-stream LOD
churn, and dispose during a pending pick all resolve `null`, never a throw.

## CPU queries: `queryNearest` and `queryHeight`

Synchronous, no GPU round-trip, backed by a uniform grid rebuilt only when
the resident set changes:

```ts
// Nearest resident splat center within 0.5 world units, measurements,
// proximity tests, contact points.
const nearest = splats.queryNearest(cameraPosition, 0.5);
if (nearest) console.log('surface at', nearest.point, 'distance', nearest.distance);

// Floor probe: the highest splat at most 3 units below the point (world −Y).
const floor = splats.queryHeight(cameraPosition, 3);
if (floor) {
 console.log(`ground ${floor.drop} below`, floor.point);
} else {
 // Null means "no floor sampled here": out of range, or (on a streamed
 // mesh) a region whose chunks are not resident at the current LOD.
}
```

<!-- full file: docs/guide/samples/picking-queries.ts -->

`queryHeight(point, maxDrop, radius = maxDrop / 2)` searches straight down in
world −Y. Caveats: results are splat **centers**, which sit slightly above
the visual surface and can miss between sparse splats, widen
`radius`/`maxDrop` or treat `null` as "no sample"; on a streamed mesh the
answer covers **resident chunks only** and changes as LOD streams.

## Coordinate spaces and transformed meshes

Picks and queries take and return **world-space** values, mapped through the
mesh's full `matrixWorld` (ancestors included). Move, rotate, or uniformly
scale the mesh and everything keeps answering in the frame it renders in.
The queries assume a rigid transform with uniform scale (the built-in format
transforms are); non-uniform scale distorts the radius tests.

## `orientation: 'source'`

The default `orientation: 'y-up'` correction is part of the mesh transform,
so it is transparent to picks and queries. Load with
`orientation: 'source'` and the mesh renders in the raw data frame, picks
and queries then answer in *that* world frame instead. Remember world −Y in
`queryHeight`: for a Z-up capture rendered in source frame, "down" no longer
matches the capture's gravity. (LCC still applies its own matrix under
`'source'`, that is format semantics, not cosmetics.)

## Unified multi-source picks

`UnifiedSplatRenderer.pick(ndc, camera, options?)` runs a depth pick on
every **visible** registered source; the hit nearest the camera wins and
carries its source (`{ source, point, distance }`), per-splat depth, exactly
what the unified draw composites, so the cursor lands on what the user sees
in front. Hidden sources never hit; in-flight hits whose source is removed or
disposed are dropped, never misattributed. See
[Unified rendering](unified-rendering.md#picking-across-sources) for the
worked sample.

## Which one do I want?

| Need | Use |
| --- | --- |
| Click-to-focus, placement anchor under the cursor | `pick` (GPU, async) |
| Nearest surface to a 3D point, measurements | `queryNearest` (CPU, sync) |
| Floor following, teleport validation | `queryHeight` (CPU, sync) |
| Cursor hit across several unified sources | `UnifiedSplatRenderer.pick` |
| Physics / watertight collision (`.lcc` / `.lcc2`) | `loadCollisionMeshes` + your own BVH |
