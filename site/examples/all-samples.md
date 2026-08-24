# All samples

Every source file behind the docs, in one place. Expand a card to read or copy the full file.

Two kinds live here. **Example apps** are the complete programs the walkthroughs show and the live runners execute, the same file, no second copy. **Guide fragments** are short reference snippets, usually exported functions rather than whole apps.

## Example apps

Each is a standalone program. Follow the link for the explanation and a live run.

### Start here

::: details first-viewer.ts, renderer, scene, camera, `SplatMesh`, orbit controls · [walkthrough](/examples/first-viewer)
<<< ../../docs/examples/samples/first-viewer.ts
:::

::: details open-local-file.ts, `loadSceneFile`, progress, abort, `SplatLoadError` · [walkthrough](/examples/open-local-file)
<<< ../../docs/examples/samples/open-local-file.ts
:::

::: details big-scenes.ts, `StreamedSplatMesh.load`, budget, `setBudget` · [walkthrough](/examples/big-scenes)
<<< ../../docs/examples/samples/big-scenes.ts
:::

::: details click-the-world.ts. GPU `pick` under the cursor · [walkthrough](/examples/click-the-world)
<<< ../../docs/examples/samples/click-the-world.ts
:::

::: details splats-and-objects.ts, a capture and lit three.js geometry in one scene · [walkthrough](/examples/splats-and-objects)
<<< ../../docs/examples/samples/splats-and-objects.ts
:::

::: details many-captures.ts, `SplatScene` with three sources · [walkthrough](/examples/many-captures)
<<< ../../docs/examples/samples/many-captures.ts
:::

### Going further

::: details frame-the-camera.ts, `computeSplatBounds` and fitting the view · [walkthrough](/examples/frame-the-camera)
<<< ../../docs/examples/samples/frame-the-camera.ts
:::

::: details stand-on-surface.ts, `queryHeight` floor probes and `queryNearest` · [walkthrough](/examples/surface-queries)
<<< ../../docs/examples/samples/stand-on-surface.ts
:::

::: details change-the-look.ts, stacked `sdfEffects` + `lightingPreset` + `revealPreset` · [walkthrough](/examples/shader-effects)
<<< ../../docs/examples/samples/change-the-look.ts
:::

::: details select-and-cut.ts, transform gizmo, `createSelectionVolume`, `partitionSplatData` · [walkthrough](/examples/select-and-cut)
<<< ../../docs/examples/samples/select-and-cut.ts
:::

::: details depth-of-field.ts, `setDepthOfField`, sliders, click-to-focus · [walkthrough](/examples/depth-of-field)
<<< ../../docs/examples/samples/depth-of-field.ts
:::

::: details custom-effect.ts, a hand-written TSL `SplatModifier` · [walkthrough](/examples/custom-effect)
<<< ../../docs/examples/samples/custom-effect.ts
:::

### Shipping it

::: details react-viewer.tsx, the `<SplatViewer>` component and its cleanup · [walkthrough](/examples/react-viewer)
<<< ../../docs/examples/samples/react-viewer.tsx
:::

::: details react-main.tsx, mounting it under `StrictMode` · [walkthrough](/examples/react-viewer)
<<< ../../docs/examples/samples/react-main.tsx
:::

::: details annotations.ts. HTML labels projected and occlusion-tested · [walkthrough](/examples/annotations)
<<< ../../docs/examples/samples/annotations.ts
:::

::: details fast-on-phones.ts, device profile, pixel-ratio cap, adaptive DPR · [walkthrough](/examples/fast-on-phones)
<<< ../../docs/examples/samples/fast-on-phones.ts
:::

::: details webgl-fallback.ts, backend detection and `forceWebGL` · [walkthrough](/examples/webgl-fallback)
<<< ../../docs/examples/samples/webgl-fallback.ts
:::

::: details in-vr.ts, `xrSessionInit`, `resolveXrSplatBudget`, framebuffer scale · [walkthrough](/examples/in-vr)
<<< ../../docs/examples/samples/in-vr.ts
:::

::: details share-a-viewpoint.ts, camera pose in the URL, eased flights · [walkthrough](/examples/share-a-viewpoint)
<<< ../../docs/examples/samples/share-a-viewpoint.ts
:::

## Guide fragments

Short reference snippets from `docs/guide/samples/`, mostly exported functions rather than whole apps.

### Getting started

::: details getting-started-basic.ts, minimal renderer + `loadScene` + `SplatMesh`
<<< ../../docs/guide/samples/getting-started-basic.ts
:::

::: details getting-started-file-input.ts, load a local `File` with `loadSceneFile`
<<< ../../docs/guide/samples/getting-started-file-input.ts
:::

::: details getting-started-dispose.ts, tear down mesh and renderer
<<< ../../docs/guide/samples/getting-started-dispose.ts
:::

::: details getting-started-nonuniform-scale.ts, per-axis `scale.set(...)`
<<< ../../docs/guide/samples/getting-started-nonuniform-scale.ts
:::

### Loading

::: details loading-formats.ts, format detection and direct parsers
<<< ../../docs/guide/samples/loading-formats.ts
:::

::: details loading-errors.ts, progress, abort, and `SplatLoadError`
<<< ../../docs/guide/samples/loading-errors.ts
:::

### Streaming

::: details streaming-basic.ts, `StreamedSplatMesh.load`
<<< ../../docs/guide/samples/streaming-basic.ts
:::

::: details streaming-governor.ts, shared `BudgetGovernor`
<<< ../../docs/guide/samples/streaming-governor.ts
:::

::: details streaming-local.ts, dropped folder via `loadLocal`
<<< ../../docs/guide/samples/streaming-local.ts
:::

::: details multi-mesh-budgets.ts, camera-weighted budgets across meshes
<<< ../../docs/guide/samples/multi-mesh-budgets.ts
:::

### Effects & picking

::: details effects-presets.ts, `@voluma/vlam/effects` presets
<<< ../../docs/guide/samples/effects-presets.ts
:::

::: details effects-slots.ts, stacked `ModifierSlots`
<<< ../../docs/guide/samples/effects-slots.ts
:::

::: details effects-custom-modifier.ts, a hand-written TSL modifier
<<< ../../docs/guide/samples/effects-custom-modifier.ts
:::

::: details effects-contract.ts, rebuild vs uniform-update, as a do/don't pair
<<< ../../docs/guide/samples/effects-contract.ts
:::

::: details relighting.ts, proxy-mesh screen-space `setRelighting`
<<< ../../docs/guide/samples/relighting.ts
:::

::: details picking-basic.ts. GPU `pick` under the cursor
<<< ../../docs/guide/samples/picking-basic.ts
:::

::: details picking-queries.ts. CPU `queryNearest` / `queryHeight`
<<< ../../docs/guide/samples/picking-queries.ts
:::

### Unified rendering

::: details unified-basic.ts, `UnifiedSplatRenderer` on WebGPU
<<< ../../docs/guide/samples/unified-basic.ts
:::

::: details unified-pick.ts, unified pick with source id
<<< ../../docs/guide/samples/unified-pick.ts
:::

::: details unified-capacity.ts, sizing the unified splat pool
<<< ../../docs/guide/samples/unified-capacity.ts
:::

Try scenes live in the <a href="/demo/" target="_self">full viewer</a>.
