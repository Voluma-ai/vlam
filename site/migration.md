# Migrating toward VLAM! 1.0

This guide covers 0.x API changes, newest first. Keep the exact package
version pinned until 1.0 is released.

## 0.12.0: SH fallback reasons

The SH compute cache fallback reason `dynamic-or-shared-pool` is split into
`shared-pool` and `auto-dynamic-pool`. A host that matched the old reason
should match both. The automatic projection reason
`auto-dynamic-or-shared-pool` is unchanged. An explicit
`shEvaluation: 'compute'` now also enables the cache on owned dynamic pools
(`StreamedSplatMesh`, dynamic-capacity `SplatMesh`); `'auto'` keeps them on
vertex SH.

## 0.11.3: RAD options and loading integration

`buildRadScene` from `@voluma/vlam/formats/rad` replaces positional controls
with one `RadSceneOptions` object extending `LodSourceOptions`:

```ts
// Before:
// buildRadScene(source, lodOptions, request, maxShBands, budgetLifts, radStrategy)
// After:
buildRadScene(source, {
  ...lodOptions,
  request,
  signal,
  maxShBands,
  budgetLifts,
  radStrategy,
});
```

Defaults remain `maxShBands: 3`, `budgetLifts: true`, and `radStrategy: 'auto'`.
Move the old second argument into the object along with the old positional
controls; `signal` is newly supported. `StreamedSplatMesh.load` callers need no
signature change.

Custom sources can use `StreamedSplatMesh.loadSource` with an explicit format.
Its default ownership is borrowed; opt into `sourceOwnership: 'owned'` to have
VLAM dispose the source on failure or mesh disposal. Source `size` implementations
now accept an optional `{ signal }` and must preserve cancellation.

Use optional `onStatus` for loading labels instead of inferring decoding from
byte counts. Promise settlement still signals completion, while reveal state
continues to describe rendering readiness. For exact affine SDF previews, use
`SdfShape.transform` instead of approximating scale with radius; do not combine
it with `center` or `rotation`.

## Names and package entries

| Earlier name or import | Current API |
| --- | --- |
| `UnifiedSplatRenderer`, `supportsUnifiedSplatRenderer` | `UnifiedSplatMesh`, `supportsUnifiedSplatMesh` from `@voluma/vlam/unified` |
| `createSplatRenderer()` | `createWebGPURenderer()` from `@voluma/vlam` |
| `SplatScene` | `MergedSplatMesh` from `@voluma/vlam` |
| `loadScene`, `loadSceneFile` | `loadSplatData`, `loadSplatDataFile` from `@voluma/vlam/loaders` |
| `StreamedSplatMesh.loadAutoLod()` | `StaticLodSplatMesh.load()` from `@voluma/vlam/static-lod` |
| Root parser imports | `@voluma/vlam/formats/ply`, `/sog`, `/rad`, `/lcc`, `/spz`, `/splat`, `/ksplat` |

Streaming lives at `@voluma/vlam/streaming`; selection at
`@voluma/vlam/selection`; relighting at `@voluma/vlam/relighting`.
Optional systems have no root re-exports. Keep `three` at **0.186.0 or
newer**. Use `createWebGPURenderer()` to request the device limits used by
large VLAM scenes; an application-owned three.js renderer must request
suitable limits itself.

## Strategies and effects

GPU radix sorting and compute projection are experimental factory options.
Import `radixSort()` or `exactSort()` from
`@voluma/vlam/sorting/radix`, and `computeProjection()` from
`@voluma/vlam/projection/compute`. The strings `'radix'` and `'exact'`
are not sort strategies. Counting sort and vertex projection remain the
baseline paths.

Relighting now uses `attachRelighting(mesh, settings)` from
`@voluma/vlam/relighting`. Update the returned attachment for live settings,
and call its `dispose()` method to restore the previous display modifier.
There is no `mesh.setRelighting()` method.

## Placement, defaults, and lifecycle

Known source formats are normalized to three.js Y-up by default. Remove
application-level 180° X flips that were used solely to stand a capture up.
Pass `orientation: 'source'` when the source coordinate frame is intentional;
preserve the mesh's own rotation when placing it under a parent group.

The device-aware rendering profile defaults to `smooth` on mobile and
fill-constrained desktops and full-detail `quality` elsewhere. `balanced`
remains an explicit SH-preserving culling choice. Budget and projection auto
policies are device-dependent; pin options when an upgrade must preserve a
measured image or memory envelope.

`UnifiedSplatMesh` is the supported high-level WebGPU compositor: construct
with fixed capacity, add static or streamed source meshes, control visibility
and opacity through source methods, call `update(camera)` before rendering,
and dispose it when done. Picking, secondary views, diagnostics, and source
removal follow the [unified guide](https://github.com/Voluma-ai/vlam/blob/main/docs/guide/unified-rendering.md).
`MergedSplatMesh`, static LOD, radix sorting, and compute projection remain
experimental. The low-level `UnifiedSourceView` GPU resource interface is
also experimental; use the high-level compositor where possible.
