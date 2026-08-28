# Terminology

Words VLAM! uses in the public API and guides, and what they do *not* mean.

## Capture, data, mesh, source, scene

**Capture** (or **dataset**) is the input: a `.ply` / `.sog` / `.rad` file, an
LCC folder, a `lod-meta.json` tree. It is bytes on disk or over HTTP, not a
three.js object.

**Splat data** is the decoded arrays (`SplatData`): positions, colors,
covariances, optional SH. `loadSplatData` / `loadSplatDataFile` produce this.
Nothing is on the GPU yet.

**Mesh** is the renderable three.js object: `SplatMesh`, `StreamedSplatMesh`,
`MergedSplatMesh`, `UnifiedSplatMesh`, `StaticLodSplatMesh`. Add it to a
`THREE.Scene` and call `update` each frame.

**Source** is a mesh registered with a composite. `MergedSplatMesh.addSource`
copies fully decoded `SplatData` into one pool. `UnifiedSplatMesh.addSource`
registers an existing mesh (fully loaded or streamed) into one draw.
`UnifiedSplatSourceOptions` and `addSource` / `removeSource` keep that meaning.

**Scene** in application code is almost always `THREE.Scene`. Guides also say
"scene" for the rendered content in ordinary English. Internal format builders
still have types such as `StreamedScene`; those are not public.

`orientation: 'source'` is unrelated to composite sources. It keeps the
**native/source coordinate frame** (no cosmetic 180° X flip). LCC still applies
its mandatory Z-up→Y-up format transform in both `'y-up'` and `'source'` modes.

## Fully loaded versus streamed

A **fully loaded mesh** (`new SplatMesh(data)`) holds every splat in the pool
up front. Guides used to say "static mesh" for this; that phrasing is gone
because it collided with **static LOD** (`StaticLodSplatMesh` on
`@voluma/vlam/static-lod`), which is a different API: decode the whole capture,
then build a resident LOD cut.

A **streamed mesh** (`StreamedSplatMesh`) keeps a budgeted resident set and
fetches chunks as the camera moves. `MergedSplatMesh` only accepts fully
decoded `SplatData`. `UnifiedSplatMesh` accepts both fully loaded and streamed
meshes as sources.

Whole-file loaders decode one self-contained file. Internal worker filenames
(`one-shot-worker.ts`) still use the old "one-shot" name; public docs say
whole-file or fully decoded.

## Pool, capacity, and budgets

The **pool** is GPU storage for splat rows (`SplatPool`). **Capacity** is how
many rows that pool was allocated with. It does not grow.

**Budget** on a streamed mesh is the active-splat cap the scheduler tries to
hold. `setBudget(n)` changes it live and returns the value actually in effect.

**`maxBudget`** is the ceiling `setBudget` may climb to. It sizes the pool. If
you omit it, the mesh cannot be given more splats than it started with.

**`drawBudget`** is the page-table frontier's drawn-splat target (Spark's
`maxSplats`). It is `0` outside `'page-table'` mode. A governor that calls
`setBudget` on a `.rad` page-table mesh updates this too.

**`activeSplatCount`** is how many splats the mesh is currently drawing. On a
page-table `.rad` that is the frontier's drawn count, not the whole slab.

**`contentSplatCount`** is how many splats the capture contains, independent of
the budget. Use it to size UI or decide whether the capture is "small", not as
the GPU cap.

## LOD vocabulary

**LOD** is the tree (or flat leaf list) that lets a capture coarser than a
pixel stay cheap, and finer near the camera.

A **level** is one resolution band. A **leaf** is a finest-level node.

The **cut** (or **frontier**) is the set of nodes actually selected for this
view: one node per root-to-leaf ray, coarse in the distance, fine nearby.

**Residency** is which chunks currently occupy the pool or CPU cache. The cut
can only refine into chunks that are resident.

**Foveation** is a cut that spends budget on the view center (and, for `.rad`
page-table, a cone around the look direction) rather than a uniform screen
band. Canonical mode name: `'page-table'`. `'pagetable'` is a deprecated
spelling of the same mode.

## What not to say

- Do not call a splat mesh a scene. The three.js scene is the container.
- Do not call a capture a mesh. Decode first.
- Do not call a fully loaded mesh "static" unless you mean `StaticLodSplatMesh`.
- Do not call the application a "host" unless you mean an HTTP host or a DOM
  host element.
