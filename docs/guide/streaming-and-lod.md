# Streaming & LOD

`StreamedSplatMesh` opens scenes larger than GPU memory: chunks load
coarse-first and refine near the camera, kept within a per-device splat
budget. It extends `SplatMesh`, so the render loop, picking, queries, and
modifiers all work unchanged.

Supported streamed formats: Streamed SOG (`lod-meta.json`), XGRIDS `.lcc`
(manifest v3–v5) and `.lcc2`, and Spark `.rad`/`.radc`, see the
[capability matrix](../capabilities.md#formats).

## Opening a streamed scene

`StreamedSplatMesh.load` takes the manifest URL (`string | URL`); the
extension picks the format (`.lcc2`, `.lcc`, `.rad`, otherwise Streamed SOG),
overridable with `format`:

```ts
import { StreamedSplatMesh } from '@voluma/vlam';

export async function openStreamed(scene: THREE.Scene, signal: AbortSignal) {
  const splats = await StreamedSplatMesh.load('/capture/lod-meta.json', {
    signal, // aborting rejects with AbortError and disposes the partial mesh
    baseUrl: document.baseURI, // relative manifest URLs resolve against this
    budget: 2_000_000, // active-splat cap; defaults to a per-device value
    lodBaseDistance: 10, // world units inside which the finest LOD is used
  });
  scene.add(splats);
  // Per frame, exactly like a static mesh:
  //   splats.update(camera, renderer); renderer.render(scene, camera);
  return splats;
}
```

<!-- full file: docs/guide/samples/streaming-basic.ts -->

Other options worth knowing: `request` (headers/credentials for manifest and
chunk fetches), `shBands` (view-dependent color in the streamed pool, on by
default for LCC `Quality`, strictly opt-in for Streamed SOG), and
`lodBaseDistance`, which is scene-scale-dependent, the default 10 assumes
roughly unit-scale scenes, so tune it for captures spanning hundreds of
units.

## Budgets and `setBudget`

The budget is the maximum number of **active** (resident, drawn) splats. It
defaults to a per-device value (`resolveSplatBudget`); distance sets chunk
priority, the budget sets the reach, leftover budget refines nearest-first,
and out-of-view regions fall back to the coarsest level, so the budget is
never exceeded and the view is never blank.

`splats.setBudget(n)` changes it live (say, after a quality-settings change).
It returns the value actually in effect, which may be lower when the mesh
clamps to its ceiling, `splats.maxBudget`, which defaults to the construction
budget because the pool is allocated once and never grows.

To leave room to be raised *above* the starting budget, which anything sharing
a budget across meshes needs, construct with `maxBudget`:

```ts
const marker = await StreamedSplatMesh.load(url, {
  budget: 800_000, // where it starts
  maxBudget: 1_500_000, // the most it may be given; sizes the pool
});
```

The pool costs the ceiling whether or not the budget reaches it, so price it
with `estimateSplatPoolBytes` first.

## Sharing one budget: `BudgetGovernor`

Several streamed meshes at once (a main scene plus marker or inset meshes)
must not each claim the whole device budget, their pools are separate, so
the costs add. Register them with a `BudgetGovernor`, which splits one total
across members by priority weight and reallocates on membership or weight
changes (with hysteresis, so brief churn does not thrash LOD schedules):

```ts
import { BudgetGovernor, StreamedSplatMesh } from '@voluma/vlam';

const main = await StreamedSplatMesh.load('/city/lod-meta.json');
const markers = await StreamedSplatMesh.load('/markers/lod-meta.json');

// The governor splits one total (default: the per-device budget) across
// members by weight, steering each through its public setBudget.
const governor = new BudgetGovernor();
governor.register(main, { weight: 7 }); // main gets 0.7 of the total…
governor.register(markers, { weight: 3 }); // …markers the remaining 0.3

// Later, closing the marker layer returns its share to the main mesh:
//   governor.unregister(markers);
```

<!-- full file: docs/guide/samples/streaming-governor.ts -->

Meshes never registered with a governor keep the standalone behavior, so
adoption is opt-in per mesh.

`weight: 0` **suspends** a member, excluded from the split, held at a 1-splat
floor, its share released to the others, but still registered so bringing it
back is free. Use `setWeights` when several weights change together: one
reallocation instead of N, each of which would force an LOD reschedule on every
member.

For weights that should follow the camera rather than app state, several marker
meshes where the near one should be sharp, see
[Multi-mesh & marker budgets](multi-mesh-budgets.md), which also covers why
`maxBudget` is required for a governor to be able to grow a mesh at all.

## Local folders: `loadLocal`

A streamed dataset dropped into the page as a **folder** streams straight off
disk, each file is read through a `blob:` URL, which serves range requests
just like an HTTP origin, so a 300 MB `data.bin` is never read whole:

```ts
import { StreamedSplatMesh } from '@voluma/vlam';

export async function openDroppedFolder(files: ReadonlyMap<string, File>) {
  // `files` maps relative paths ("lod-meta.json", "chunks/0.webp", …) to File
  // objects, e.g. collected from a drag-and-drop directory traversal. Files
  // are read in place through blob: URLs, ranged reads, no upload.
  const splats = await StreamedSplatMesh.loadLocal(files);

  // .lcc / .lcc2 captures may ship collision geometry as plain triangles; VLAM!
  // builds no BVH and runs no physics, that is the host's job. Resolves []
  // for scenes without collision geometry.
  const collision = await splats.loadCollisionMeshes();
  console.log(`${collision.length} collision tiles`);

  // The always-resident environment/sky tile (outside the LOD budget) can be
  // toggled live; a no-op for scenes that ship none.
  splats.setEnvironmentEnabled(false);
  return splats;
}
```

<!-- full file: docs/guide/samples/streaming-local.ts -->

## Collision meshes and the environment tile

- **`loadCollisionMeshes()`** (also in the sample above) returns the triangle
 tiles some `.lcc` / `.lcc2` captures ship, source-local, so apply the mesh's
  `matrixWorld`. VLAM! hands them over and nothing more: BVH building,
  raycasts, and character controllers are host code (the demo's
  `src/viewer/collision.ts` shows one).
- **`setEnvironmentEnabled(enabled)`** toggles the always-resident
 environment/sky tile (`.lcc2`) live; the `environmentEnabled` load option
 sets its initial state. Both are no-ops for scenes without one.

## Backend note

Streaming runs on WebGPU and the WebGL2 fallback alike, but the WebGL2 CPU
sorter can flicker under camera motion on streamed scenes. WebGPU is the
polished path there
([scope statement](../capabilities.md#webgl2-scope-statement)).

## Next

[Unified rendering](unified-rendering.md), depth-correct compositing of
several static and streamed sources in one draw.
