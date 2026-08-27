# Walk with collision detection

**What you get:** a first-person walk through De Haar with solid floors and
walls, gravity, steps, and jumping.

<ExampleEmbed
  slug="collision-walk"
  hint="Give collision a moment to index, then click · WASD move · Shift run · Space jump"
/>

Click **Start walking** to capture the mouse. Move with WASD, hold Shift to run,
press Space to jump, and press Escape when you want the pointer back.

## The splats are not the collider

A splat capture is a transparent point cloud, not a watertight surface. Testing
the camera against every splat would be both expensive and physically vague.
De Haar's `.lcc2` ships ordinary triangle meshes beside its splats for exactly
this job:

```ts
const tiles = await splats.loadCollisionMeshes();
```

Those tiles are still only geometry. VLAM! deliberately does not decide whether
your app needs a sphere, capsule, character controller, vehicle, or full physics
engine. This example chooses a small sphere around the camera and uses
[`three-mesh-bvh`](https://github.com/gkjohnson/three-mesh-bvh) for fast triangle
queries:

```sh
npm install three-mesh-bvh
```

`three-mesh-bvh` is an application dependency for this example, not a dependency
of `@voluma/vlam`.

## Make the source-local triangles match the rendered capture

Collision tiles use the capture's source-local coordinates. The splat mesh may
carry an orientation correction, so the helper copies each tile and applies
`splats.matrixWorld` before building its BVH. Mutating the original buffers would
break any second consumer, such as collision-based relighting.

A De Haar tile can contain tens of thousands of triangles. Building all 24 BVHs
in one task would pause the page, so the helper builds one per browser idle
period. Tiles nearest the starting camera go first. Walking becomes available as
soon as the first tile is queryable while the rest finish in the background.

## Walking is three separate queries

Each frame does three pieces of work:

1. Project WASD onto the horizontal plane, move a sphere, and push it out of any
   walls it overlaps. Substeps keep a fast or delayed frame from tunnelling
   through thin geometry.
2. Cast straight down for a walkable triangle. A small correction holds the
   camera at eye height and lets it step onto low rises.
3. Apply vertical velocity for gravity and jumping, then depenetrate once more
   so a jump cannot pass through a ceiling.

Collision geometry covers the reconstructed walkable area, not every visible
splat. When the floor probe finds no triangle, the example hovers at its current
height instead of falling forever through an unmapped part of the capture.

## The code

::: code-group

<<< ../../docs/examples/samples/collision-walk.ts [main.ts]

<<< ../../docs/examples/samples/collision-world.ts [collision-world.ts]

<<< ../../example-apps/collision-walk/index.html [index.html]

:::

## Tune it for your controller

`EYE_HEIGHT`, `COLLISION_RADIUS`, `WALK_SPEED`, and `GROUND_SNAP` are policy,
not format facts. They work for this metric LCC capture. A real character is
usually better represented by a capsule, and a non-metric capture needs these
values scaled to its own units.

The slope cutoff is policy too. The helper treats surfaces up to 50 degrees as
ground and steeper ones as walls. Lower that angle for a cautious controller;
raise it for scrambling over rough reconstruction geometry.

## Next

- [Huge scenes that load as you walk](/examples/big-scenes): streaming and
  quality budgets without collision
- [Surface queries](/examples/surface-queries): lightweight height and nearest
  probes when you do not need solid walls
- [Relight a capture](/examples/relight): reuse De Haar's collision geometry as
  a shadow proxy
