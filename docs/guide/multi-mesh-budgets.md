# Multi-mesh splat budgets

A scene of one main capture plus several additional meshes has a budget problem
that a single mesh does not: each `StreamedSplatMesh` owns its own pool, so their
costs add. The obvious fix, give each one `total / N`, is what makes the mesh
you fly up to look blurry, because a quarter of the budget is exactly as much as
it gets when the camera is inside it as when it is 200 m away.

This guide covers sharing one budget across meshes and steering it from the
camera, so detail concentrates where the viewer is looking.

## The short version

```ts
const governor = new CameraBudgetGovernor({ totalBudget: 4_000_000 });
governor.register(main, { fixedWeight: 4 }); // steady share
for (const extra of extras) governor.register(extra); // camera-weighted

// once per frame, before the meshes update:
governor.update(camera);
```

…plus the part that is easy to miss and without which none of the above does
anything: **construct the additional meshes with `maxBudget`.**

```ts
const extra = await StreamedSplatMesh.load(url, {
  budget: 800_000, // where it starts
  maxBudget: 1_500_000, // where a governor may take it
});
```

<!-- full file: docs/guide/samples/multi-mesh-budgets.ts -->

## Why `maxBudget` is mandatory here

A mesh's pool is allocated **once, at construction, from its budget**, and it
never grows. `setBudget` clamps to that ceiling and returns what actually took
effect. So a mesh built at `total / 4`:

- can be shrunk below `total / 4` by a governor, and
- can **never** be raised above it, however close the camera gets.

That is the whole reason an evenly-split pool stays coarse. `maxBudget`
separates the two numbers: `budget` is where the mesh starts, `maxBudget` is the
most it may ever be given and the size its pool is built for.

Read it back with `mesh.maxBudget`, and check it against what your governor is
trying to hand out, a share above the ceiling is silently truncated.

## Pricing the ceilings

Pools cost their **ceilings**, not the shared budget. Four additional meshes that
could each reach 4M splats cost four 4M pools whether the total is 4M or 400k.
So a governor redistributes *sharpness inside a fixed memory envelope*; it does
not shrink the envelope.

`estimateSplatPoolBytes` makes that concrete:

```ts
const envelope =
 estimateSplatPoolBytes(4_000_000) + 4 * estimateSplatPoolBytes(1_500_000);
```

| Setup | Envelope (GPU + CPU backing) |
| --- | --- |
| main 4M, 4 extras @ 4M ceiling | 3720 MB, will not fit |
| main 4M, 4 extras @ 1.5M ceiling | 1860 MB |
| main 4M, 4 extras @ 750k ceiling | 1302 MB |
| main 4M, 4 extras @ 1.5M, `poolFloatTextures: 'float16'` | 1620 MB (13% less overall, 24% less GPU-side) |

A ceiling around **1.5–2× a member's fair share** is usually the right trade: a
focused additional mesh gets a real step up in detail without every mesh being
sized for the whole budget. Pick it from what the device has, not from the total.

## How the camera weighting works

Each update, `CameraBudgetGovernor` measures every member's projected size and
writes weights to the underlying `BudgetGovernor`:

```
weight = priority × clamp((radius / distance) ^ falloff) × onScreen
```

- `radius / distance` is the tangent of the member's half angular size, measured
  from its world bounding sphere's **surface**, the same `size / distance`
  measure Spark's `pixel_scale` traversal ranks LOD nodes by, one level up at
  whole-mesh granularity. `StreamedSplatMesh.computeSplatBounds()` reports the
  whole scene's bounds from the manifest, so this is correct on the first frame,
  before any chunk has loaded.
- `falloff` (default `1`) weights by angular size; `2` weights by projected area
  and concentrates harder on the nearest member.
- `onScreen` is `1` inside the frustum and `offScreenWeight` (default `0.25`)
  outside it, suppressed, never starved. An off-screen member must keep enough
  budget for its coarse shell or turning the camera exposes an unpainted region.
- `priority` is the host's tier, multiplied on top: Spark's `lodScale` values map
  directly, focused `2`, default `1`, adjacent `0.25`, hidden `0`.

`minWeight` / `maxWeight` bound the size term, so a distant member keeps a shell
and a member the camera is *inside* cannot take the entire total.

### Hiding a member

`priority: 0`, or the member's own `visible = false`, suspends it: excluded from
the split, held at a 1-splat floor, its whole share released. It stays
registered, so bringing it back costs nothing.

Suspended is not free. The pool was allocated at construction and is not
released, and a streamed mesh keeps its pinned coarse shell resident, so it
holds **≈0 of the budget, not exactly 0**. To give the memory back, dispose the
mesh.

### Cadence

Call `update(camera)` once per frame. It throttles internally to
`minIntervalMs` (default `250`, matching `StreamedSplatMesh`'s own idle
reschedule interval) and additionally skips the reallocation when no weight moved
more than `weightDeadband` (default `0.15`). Reweighting faster than a mesh
reschedules buys nothing and costs a forced reschedule on every member.

Membership changes and `setPriority` bypass both damps, so a deliberate focus
change lands on the next frame rather than waiting out the interval.

## What this buys on `.rad`, honestly

`.rad` takes one of two LOD paths, chosen on leaf count, and a bigger budget
buys something different on each. Which one you are on decides what to expect:

| Mesh leaf count | Path | Effect of a larger budget |
| --- | --- | --- |
| **≤ 6M leaves** | coarse→fine chunk **prefix**, refinement uniform and camera-independent | **Everything.** At `budget ≥ leafCount` every chunk is resident and the mesh renders its full leaf set, zero blobs, full resolution. Below that it is uniformly coarse *everywhere*, worst up close. There is no foveation on this path and none is needed. |
| **> 6M leaves** | `foveationMode: 'pagetable'`. Spark's per-splat frontier traversal | Detail is already concentrated near the camera and off-cone content already kept coarse. A larger **draw** budget lets the traversal descend further before the budget stops it, so the near surface sharpens. |

Two consequences worth knowing:

- **Do not pass an explicit `budget` if you want the auto-lift.** A `.rad` (and
  `.lcc`) with no `budget` set has its budget lifted to the capture's full leaf
 count when that fits, which is what makes a moderate additional mesh sharp.
  Passing `budget: total / N` suppresses it. Under a governor, pass `maxBudget ≥
  leafCount` instead and let the governor set the working budget.
- **The lift is desktop-only.** Mobile is exempt on purpose: its cap is a
  fill-rate limit, not a sizing accident. On a phone, four additional meshes
  cannot all be full-resolution, camera weighting still delivers "the near one is
  sharp", not "all four are sharp".

Watch `mesh.drawBudget` (the governed page-table draw target) and
`mesh.activeSplatCount` (what is actually drawn) rather than `mesh.budget` when
checking a page-table mesh: `budget` is the pool's allowance, `drawBudget` is
what gets spent.

### Spark's `lodScale`

For page-table `.rad` meshes, `StreamedSplatMesh.lodScale` is Spark's knob
exactly, it scales the frontier cut (`pixel_scale × lodScale ≤ limit`), so `2`
refines further and `0.5` coarsens. It is mutable per frame.

It does nothing on a mesh with no per-splat cut to scale, a moderate `.rad` read
as a chunk prefix, or a Streamed SOG / LCC scene. For the GPU cut modes
(`'band'` / `'frontier'`) the equivalent is `foveationTargetPx = 1 / lodScale`.

The governor deliberately drives **budget only**, not `lodScale`: budget is the
shared resource, so it is the thing that has to be allocated. Use `lodScale` as
an extra per-mesh trim on top.

## Comparison with SparkJS

| Spark | VLAM |
| --- | --- |
| One `lodSplatCount` across all meshes | `CameraBudgetGovernor` / `BudgetGovernor` `totalBudget` |
| GPU traversal favors near, on-screen detail across meshes | Per-mesh pools, so the near/far bias is applied to the **budget**, `CameraBudgetGovernor.update(camera)` |
| Per-mesh `lodScale` tiers (2 / 1 / 0.25 / 0) | `priority` on `register` / `setPriority`; `0` suspends |
| Paged meshes fetch root chunks nearest-camera-first | Already the behavior: the `.rad` traversal requests `touched` chunks biggest-on-screen first, ahead of the file-order sweep |
| One shared pool | Per-mesh pools sized at construction, hence `maxBudget` |

The shapes differ where the memory model differs. Spark shares one pool, so a
mesh's share is decided at traversal time; VLAM's meshes own their pools, so a
share has to be *reserved* (`maxBudget`) before it can be *allocated*
(`totalBudget` + weights).

## Who owns what

| VLAM owns | Your app still owns |
| --- | --- |
| Splitting one total by weight, cap-aware | Choosing `totalBudget` (start from `resolveSplatBudget()`) |
| Reallocating on membership, weight and total changes | Choosing each mesh's `maxBudget`, and affording the sum |
| The `sum(budgets) ≤ total` invariant | Calling `governor.update(camera)` once per frame |
| Measuring projected size, frustum test, throttling | Focus/adjacent/hidden tiers, which mesh is "focused" is app state |
| Driving the `.rad` page-table draw target from the governed budget | Loading, placing, hiding and disposing meshes |
| Restoring a member's budget on `unregister` / `dispose` | Passing the head camera (not the idle app camera) during an XR session |

## Fixed weights without a camera

If your weights come from app state rather than distance, use `BudgetGovernor`
directly, same total, same invariant, no per-frame call:

```ts
const governor = new BudgetGovernor({ totalBudget: 4_000_000 });
governor.register(main, { weight: 7 });
governor.register(extra, { weight: 3 });
governor.setWeights([
  [main, 5],
  [extra, 5],
]); // one reallocation, not two
```

`setWeights` matters whenever more than one weight changes together: each
reallocation pushes `setBudget` to every member and forces an LOD reschedule.

The two mix, pass an existing `BudgetGovernor` as `CameraBudgetGovernor`'s
`governor` option and register some members on each. Members registered directly
on the governor are never camera-weighted, and `CameraBudgetGovernor.dispose()`
leaves them alone.

## Related

- [Streaming & LOD](streaming-and-lod.md), budgets on a single mesh,
  `setBudget`, local folders, the environment tile.
- [Unified rendering](unified-rendering.md): depth-correct compositing when
  those meshes have to blend with each other.
- [`formats/rad-notes.md`](../formats/rad-notes.md): the `.rad` LOD paths, the
  6M threshold, and the page-table frontier in detail.
