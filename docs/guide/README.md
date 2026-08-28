# VLAM! guides

User-facing guides for embedding VLAM! in a three.js app, in reading order.
Every multi-line code sample is a real TypeScript file under
[`samples/`](samples/), type-checked against the current source by
`npm run docs:samples` (see [CONTRIBUTING.md](../../CONTRIBUTING.md)).

1. [Getting started](getting-started.md): install, WebGPU renderer setup,
   first scene, the per-frame update loop, cleanup, and the WebGL2 fallback.
2. [Loading scenes](loading-scenes.md): `loadScene`/`loadSceneFile`, format
   auto-detection and subpaths, structured errors, progress, cancellation.
3. [Streaming & LOD](streaming-and-lod.md): `StreamedSplatMesh` for scenes
   larger than GPU memory: budgets, `BudgetGovernor`, local folders,
   collision meshes, the environment tile.
4. [Multi-mesh budgets](multi-mesh-budgets.md): one shared splat
   budget across a main scene and several additional meshes, reweighted from the
   camera so the near one is sharp: `CameraBudgetGovernor`, `maxBudget` pool
   headroom, Spark `lodScale` parity, and what it buys on `.rad`.
5. [Unified rendering](unified-rendering.md): depth-correct compositing of
   several static and streamed sources in one WebGPU draw, with per-source
   control and unified picking.
6. [Effects & modifiers](effects-and-modifiers.md): the `@voluma/vlam/effects`
   presets, `ModifierSlots` stacks, the rebuild-vs-uniform-update contract,
   and writing custom TSL modifiers.
7. [Proxy-mesh relighting](relighting.md): PlayCanvas-style screen-space
   modulate from a lit proxy RT (`setRelighting`).
8. [Picking & queries](picking-and-queries.md): GPU picks, CPU spatial
   queries, coordinate spaces, and multi-source pick semantics.
9. [Troubleshooting](troubleshooting.md): symptom → cause → fix for the
   failures embedders hit most: colour space, WebGPU storage-buffer limits,
   `206 Range` requirements, WebGL2 differences, and tuning knobs.

Reference material lives beside these: the
[capability matrix](../capabilities.md) for exact format/backend support and
the generated API reference (`npm run dev`, then `/api/`) for every exported symbol.
