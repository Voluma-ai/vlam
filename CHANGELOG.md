# Changelog

All notable changes to **VLAM!** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0 versioning.** `0.2.0` is the first public release. While the
> version is `0.x`, the public API may change between releases. **`1.0.0`**
> is the stability contract (documented API, green CI, capability matrix,
> critical device validation, demo policy, migration notes, release tag). Pin
> an exact version until then.
>
> `0.1.0` is skipped: that version was published to npm on 2026-07-18 as a
> name-reservation placeholder (a single 442-byte file, no `exports`) before
> the scope was settled. It is not this library, and a published version
> cannot be replaced, so the first real release is `0.2.0`.

> **Git history.** The public repository starts at `0.2.0`. Earlier `0.0.x`
> package.json bumps were internal: they are recorded below, not as tags. Do
> not invent historical tags. Comparison links use commit history until tags
> exist.

## [Unreleased]

### Added

- Quest XR stability harness: recognized standalone headsets use a 0.7 WebGL
  framebuffer scale and 30 Hz worker-sort attempt ceiling while pose/projection
  still update every frame. `?xrScale=`, `?xrSortHz=`, `?xrStability=`, and the
  opt-in `?xrDepth=` depth experiment support A/B runs; `?xrDiagnostics=1`
  adds an opaque reference cube and periodic frame/sort timing JSON. The
  headset-friendly `/xr-test` page launches the full comparison matrix without
  typing query strings, including streamed Sandwijck SOG and Dehaar LCC2 runs.
  Fixed foveation now actually defaults to maximum; the absent query parameter
  had previously parsed as explicit `?foveation=0`.

- Proxy-mesh splat relighting (PlayCanvas-style): `SplatMesh.setRelighting` /
  `UnifiedSplatRenderer.setRelighting` multiply baked splat color from a
  screen-space lit-proxy RT; `createRelightingProxy` /
  `createRelightingShadowFactorMaterial` in `@voluma/vlam/effects`; demo
  `?effects=relight` (LCC collision tiles or `?proxy=` surface GLB). See
  `docs/guide/relighting.md`. Worked example: `site/examples/relight.md`.
- `worldWarpPreset` (`@voluma/vlam/effects`): camera-centered planet / bowl
  splat wrap. Demo: `?effects=warp`. Worked example: `site/examples/tiny-planet.md`.
- Docs streaming walkthrough (`site/examples/big-scenes.md`) runs Dehaar `.lcc2`
  live via `/remote/`, with a quality slider on `setBudget`.
- Demo `?hud=1` names the SD/HD toggle and the browser, so a pinned
  `?pixelRatio=` cannot be read as the quality preset. The same panel lists
  MSAA, Gaussian cutoff, contribution profile, native dpr, and whether
  adaptive dpr is armed.
- `.lcc2` `initialReveal: 'hold-coverage'` (library default): hide the
  mesh until every in-view octree cell has coarsest coverage resident
  **and** the environment tile is in the pool, then keep that cover until
  finer tiles replace it so first paint does not flash empty cells or a
  missing sky. The env tile is fetched at priority. `?initialReveal=progressive`
  opts out. See `docs/formats/lcc2-notes.md`.

### Fixed

- Demo proxy relight: tree-canopy shadow sparkle. Collision foliage no longer
  self-receives (`receiveUpMin` on `createRelightingShadowFactorMaterial`);
  a 20 / 50 / 160 m cascade stack (`midLight`, `outerLight`) plus a scene-sized
  far cascade (`farLight`) so close and mid-range trees stay stable without
  clipping distant umbras. Outer uses a 4096 map so the 40–100 m band stays dense.

- The viewer now releases its GPU renderer when entering the browser's
  back-forward cache and reloads if that disposed page is restored. Repeated
  Quest XR A/B runs no longer retain WebGL contexts until new contexts fail.

### Verified

- Discrete Windows NVIDIA Ampere classifies as `gpuClass: 'discrete'` on
  `goose.sog`. MacBook Air M3 Safari WebGPU classifies as `integrated`
  (`?hud=1`, `mem - desktop integrated`). Galaxy S24 Ultra Chrome 151 WebGPU
  classifies as `mem 8 mobile discrete` (Adreno probe default; phone caps
  still apply). Remaining mobile matrix: non-Pro iPhone 15.
- MacBook Air M3 (8 GB, Chrome and Safari WebGPU): demo performance mode
  stays default-on for `integrated`. Goose 149k is 60 fps and looks fine in
  SD. Streamed ~1M (Dehaar `.lcc2`, sandwijck SOG, RAD canopy) is already
  fill-bound in SD; HD MSAA is tens to hundreds of milliseconds of GPU. No
  Mac-specific HD default. See `docs/capabilities.md`.
- Galaxy S24 Ultra Chrome 151 WebGPU: goose.sog SD (149k) 60 rAF / 9.6 ms
  GPU, p99 60 fps, missed 0. HD (MSAA 4) ~58 rAF / 14.5 ms GPU, p99 30 fps.
  Dehaar SD at the 600k cap is ~48 rAF / 21 ms GPU vs HD ~26 rAF / 27 ms. A
  one-tab 5 s orbit at a lighter cut is ~54 rAF / 14 ms GPU and still
  streaming. sandwijck stays mid-stream at 5 s; GPU rises toward the 1M cap.
  Keep the phone SD default. See `docs/capabilities.md`.

### Changed

- Demo `?effects=relight` adds a warm directional Lambert boost
  (`0xffa040`, `diffuse` 0.8) on top of the shadow-factor multiplier, so
  sun-facing proxy coverage brightens and tints instead of only darkening
  in umbra. `createRelightingShadowFactorMaterial` accepts optional
  `color` / `diffuse` / `direction`; default `diffuse` 0 keeps the
  previous identity-when-lit behaviour.

- Docs "Open demo" / nav Demo load Dehaar (`.lcc2`) via `/remote/`. The
  home-page embed stays on `goose.sog`. Open demo also expands the file
  pickers (`?welcome=1`). Both CTA links opt into goose fallback with
  `?fallback=goose` if Dehaar cannot be fetched; a constructed `?scene=`
  still surfaces the error.

- Demo HD/SD now retargets renderer MSAA in place. A reload is no longer
  required, so a splat opened from the file picker stays on screen.

- The demo relight effect no longer places an orange cylinder in the scene.

- Copy-view links restore walk mode from `?fpv=1` after the collision BVH has
  its first tile, instead of dropping the flag because the world was not ready
  yet.

- The `/demo/` cinematic-orbit control starts paused. The home-page embed still
  orbits on load. A play/pause click is still remembered across reloads.
  Pressing play starts the orbit immediately; a camera interruption still waits
  five seconds before the path resumes.

- Transitive `nanoid` is pinned at `3.3.18` (CVE-2026-67213 / GHSA-2v37)
  and the existing PostCSS override is raised to `8.5.26`. Vite, Vitest, and
  VitePress still pull PostCSS, which cannot use nanoid 5.x. Dev-tooling only;
  the published package is unchanged (its only dependency is the `three`
  peer).

- Demo chrome: HD/SD, copy-view, and cinematic play sit under the hamburger
  as matching 30px circles. Tool/effect pickers drop the prefix in favor of
  that word as the empty option. On a narrow viewport the pickers share a
  row and the splat readout sits under them.

- Double-click and double-tap teleports now ease the camera to a point three
  units from the selected splat over half a second instead of moving instantly.

- **Mobile coverage now floors only undersized splats.** Mobile keeps the
  reference 3σ cutoff and defaults `minSplatSizePx` to 1.5 px, closing distant
  gaps without growing every splat and bringing expensive fill-bound frames
  back. Desktops, including integrated/fallback devices, retain a disabled
  floor. Explicit `maxStdDev` and `minSplatSizePx` options still override the
  device defaults, including `minSplatSizePx: 0`.

- **Subject-aware demo framing.** Object captures with a compact, finely
  reconstructed subject inside a coarse environment sphere now fit and orbit
  around the detailed covariance cluster instead of starting outside the full
  shell. Besides presenting the intended subject, starting inside avoids the
  severe fill-rate cost of projecting the sphere's large background Gaussians
  across the viewport.

- **Demo performance mode now includes the iPhone fill cuts.** On an iPhone 15
  Pro, a 600k LCC-class scene at dpr 1 still missed vsync on hard orbits
  because the mobile 4σ Gaussian cutoff and renderer MSAA together pushed GPU
  render past 16.6 ms. Performance mode (already default-on on phones) now
  uses the reference 3σ cutoff and disables renderer MSAA. Coverage tails and
  MSAA return when the mode is off (`?maxStdDev=` / `?rendererAntialias=1`
  still pin A/B). `SplatMesh.setMaxStdDev` applies the cutoff live, the same
  way `setPerformanceProfile` already did for contribution culling.

- Run the cinematic camera orbit in the home-page goose viewer while keeping
  its play/pause control exclusive to the full viewer.

- **Landscape-aware cinematic orbit.** Wide ground captures (a disk of terrain,
  including a cloud/sky dome) now orbit from inside at eye height instead of
  turning around the bounding box from outside. Compact objects such as
  `goose.sog` keep the existing outside path. Streamed landscapes use LOD leaf
  heights (SOG/LCC) or the `.rad` chunk-0 overview to find the terrain, so
  underground AABB outliers no longer place the camera below the ground. A
  flat splat slab (wide ≫ tall) raises that in-scene camera by the same
  height fractions as an object orbit, so the eye sits above the surface
  instead of inside the gaussians.

- **Higher object cinematic orbit.** Compact captures place the demo camera
  and look-at from the splat's vertical span (a -9 to 9 splat starts at camera
  y = 8 looking at y = 3, and climbs to 12). Camera height still bobs during
  the orbit, but stays above a relative floor of 2. Zoom now swings ±30%
  around the fitted distance (±20% for landscapes).

- Render GPU picking through a persistent 1×1 target instead of allocating and clearing a
  full-viewport color and depth target for every pick.

- **Lean, source-backed documentation.** Removed checked-in TypeDoc output,
  implementation diaries, superseded designs, and milestone archives. The API
  reference is now generated locally or with the site, while the roadmap and
  documentation index cover only current behavior and open work.

### Fixed

- Adaptive pixel ratio no longer treats WebGPU pipeline-compile frames as
  fill pressure. `suggestAdaptivePixelRatio` ignores a short warmup and
  hitches several times the EMA, and the demo HD button snaps to the quality
  ceiling live (MSAA, cutoff, budget, and drawing-buffer size) without a
  reload. A 60 Hz display cannot climb back from dpr 1 once vsync is 16.7 ms.
  HD's ceiling is `recommendedMaxPixelRatio` (1.5 on this Air), not
  `min(devicePixelRatio, …)`, so a window that reports native dpr 1 can still
  supersample. The ratio is re-applied after `renderer.init()`, which was
  resetting a pre-init `setPixelRatio` back to 1.

- Classic `.lcc` loading now survives production rebundling by lazy-loading
  through the stable public LCC format entry instead of synthetic internal
  chunk exports. LCC2 and collision helpers use the same safe import path.

- Make demo double-tap teleport independent of iOS GPU pick readback by using
  a synchronous resident-splat ray query, capturing gestures at the window,
  and accepting the browser's double-click-count fallback.
- Remember the demo's cinematic-orbit play/pause choice across page reloads.
- **Hold-still press to go forward.** The demo only starts walking or flying
  forward when a camera press stays within 2 CSS pixels for 300 ms. Looking
  around during that window cancels the hold; after it engages, looking
  around while moving still works.
- Preserve the user's zoom distance when the cinematic camera orbit resumes
  after its five-second idle delay.
- Pause the demo camera's touch gestures while dragging any Select & Cut
  transform-gizmo handle, so translate, rotate, and scale no longer move the
  camera at the same time.
- Restore render-target, depth-order, and demo mirror visibility state when a
  secondary-view render throws; targeted unified views also avoid a temporary
  size-vector allocation per draw.
- Keep the Select & Cut transform gizmo and selection preview available for
  streamed scenes, while clearly disabling destructive separation because the
  resident LOD is not the full capture.
- **Mobile double-tap teleport.** The demo recognizes the pair on the second
  press, counts a short cancelled touch as a tap (WebKit often fires
  `pointercancel` from `setPointerCapture` instead of `pointerup`), and
  `preventDefault`s the second `touchstart` so iOS cannot steal it as page
  zoom. Holds, drags, and two-finger pinches still cancel the sequence.

### Added

- Public docs and interactive demo at https://vlam.voluma.ai, deployed from
  `main` by the Deploy workflow.

- **Cinematic demo orbit.** The full viewer now follows a looping 30-second
  camera path with variable speed, height, and distance, with a play/pause
  control and automatic five-second interruption recovery for manual navigation.

- **Opt-in unified modifier caching.** `UnifiedSplatRenderer.addSource()` can
  cache static modifier output with `cacheModifiers: true`; hosts invalidate
  changed uniforms or channels explicitly through `invalidateSource()`.
- **Feathered wave animation for Select & Cut.** Separated regions can now use
  a travelling, wind-like ripple that ramps from no displacement at the cut
  boundary to full strength after the outer 10%, hiding the selection seam.

- **Hold-to-move controls.** A pointer press held longer than 300 ms now moves
  the demo camera forward while the gesture continues; shorter drags remain
  orientation-only gestures.

- **Experimental exact Float32 depth sorting.** `sortStrategy: 'exact'` keeps
 every IEEE-754 depth bit through eight stable GPU radix passes, avoiding the
 scene-bounds quantization used by the existing 24-bit `'radix'` path. The
 unified work-buffer renderer accepts the same opt-in strategy. `?vlamSort=radix` 
 and `?vlamSort=counting` remain available for performance comparisons.

- **Merged auto-LOD for static splat files.**
  `StreamedSplatMesh.loadAutoLod()` loads `.sog`, `.ply`, `.spz`, `.splat` and
  `.ksplat` into a worker-built, moment-matched spatial hierarchy. The returned
  `StaticLodSplatMesh` uses the existing camera-foveated frontier traversal and
  exposes `budget`, `budgetCeiling`, `contentSplatCount` and `setBudget()` so a
  host can adapt detail without dropping arbitrary source prefixes. Download
  and hierarchy-build progress are reported separately, and abort/dispose
  terminate the hierarchy worker. Camera cuts remap resident pool indices only;
  the full hierarchy is uploaded once (~2× the finest budget in pool slots).

- **`createSplatRenderer()`**: one call that returns a `THREE.WebGPURenderer`
  configured for splat rendering, replacing the eight lines of adapter/limits
  boilerplate the getting-started example used to open with.

  The boilerplate had exactly one correct answer and was silently wrong in two
  ways. Without raised `requiredLimits` nothing complains at renderer creation;
  the throw arrives past ~8.4 M unified splats. And leaving `requestDevice` to
  three means none of the adapter's features are requested. Without
  `core-features-and-limits` three treats the backend as compatibility-mode and
 **drops MSAA with no warning**. The helper owns the device request, so it also
 keeps the real error, which three's `getFallback` hook discards.

 It degrades to WebGL2 exactly as before (`requireWebGpu: true` throws
 instead), warns through `setVlamLogHandler` rather than the console, passes
 every `WebGPURenderer` option through, and leaves `setSize`, `init()` and
  `outputColorSpace` to the host. `recommendedWebGpuRequiredLimits` and
  `webGpuPowerPreferenceOptions` remain exported for hosts that own device
 creation themselves.

### Changed

- **Demo and select-and-cut example use transform-gizmo combined mode by
 default** (`@voluma/three-transform-gizmo` `^0.9.0`). Translate, rotate and
 scale handles show together; dedicated modes remain on the mode toggles.

- **Breaking: every format parser now lives on `@voluma/vlam/formats/*`.**
  `parseSplatPly`, `parseSog` and `parseSogDirectory` are no longer exported
  from the main entry, they were the last two parsers still on it.

  ```ts
 // before
 import { parseSog, parseSogDirectory, parseSplatPly } from '@voluma/vlam';
 // after
 import { parseSog, parseSogDirectory } from '@voluma/vlam/formats/sog';
 import { parseSplatPly } from '@voluma/vlam/formats/ply';
  ```

  Loading is unaffected: `loadScene`, `loadSceneFile` and
  `StreamedSplatMesh.load` still accept every format with no subpath import.
 The two parsers were shipping twice, once as main-thread code on the entry,
 once inside the inlined loading worker, and only the first copy was ever
 reachable from the public API.

- **`.spz`, `.splat` and `.ksplat` decode in a second worker, loaded on demand.**
 The loading worker is inlined into the published entry, so every parser it
 imports becomes a string literal that no consumer's bundler can tree-shake -
 including SPZ's ~39 KB base64 ZSTD wasm (16 KB gzipped). Every consumer who
 loaded any scene paid for it, whether or not they ever opened a `.spz`.

 Those three whole-file formats moved to a `one-shot-worker` that `ChunkLoader`
 imports the first time one is actually requested. Decodes still run off the
 main thread, and nothing changes for callers. `dist/index.js` drops from 89 KB
 to 67 KB gzipped; the main entry's whole static graph, from 135 KB to 113 KB.

- **The published package no longer carries sourcemaps for files it does not
 ship.** The three workers are inlined, so their `.js` chunks are discarded -
 but Vite still wrote the maps, leaving 420 KB of `dist/assets/*.js.map`
 pointing at files that do not exist. The package drops from 2.52 MB to
 2.12 MB unpacked. Maps for the chunks that *are* published keep their
 embedded `sourcesContent`, so stepping into library code still works.

### Fixed

- **A large `.rad` stalled far below its splat budget and stayed soft.**
  `cest_ca.rad` (11.4 M leaves, 4 M budget) settled at ~1.3 M resident splats and
  took minutes to climb, so the scene rendered at a much coarser cut than the
  budget allowed. Spark shows the same file sharp within a second or two.

  The per-plan append cap that bounds paging cost (60 k splats, added to stop a
  141 ms apply freeze) bounded only what a plan *applies*. The traversal and the
  pager diff behind it were still O(whole frontier) and ran again for every one
  of the ~66 plans a cold 4 M frontier needs, quadratic delivery, so the ramp
  never finished before something moved the camera and restarted it.

  The pager now keeps what a truncated plan deferred, and an unchanged reschedule
  *drains* that remainder instead of recomputing an answer it already has: no
  traversal, no diff, O(60 k) per plan. A camera, limit, budget or capacity
  change still re-traverses; a newly cached chunk deliberately does not, since it
  cannot invalidate a queued splat and cold loads are exactly when chunks arrive
  continuously. Queued splats pin their chunks against eviction, so a drain can
  never gather a hole. Measured on `cest_ca.rad`: 4.06 M resident with a median
  plan of 78 ms, against ~1.3 M and 8–12 s per plan before.

- **The frontier worker's chunk cache under-charged itself by ~20 %.** Its byte
  accounting counted positions, colors, covariances and SH but not the LOD tree
  arrays it retains and traverses, and `estimateSceneDecodedBytes`, which sizes
  the cache floor, made the same omission. A capture the floor was computed to
  hold therefore started evicting itself mid-load. Both now count the tree.

- **A `.rad` region flashed dark spots while it sharpened.** Streaming in a new
  level of detail briefly punched holes in the segment being refined, visible
  as background showing between the splats, where Spark rendering the same file
  shows none.

  A refinement in a `.rad` always splits across two swap groups. Grouping pairs
  adds with removals by leaf-interval overlap, which holds for the octree formats
  because a parent's interval contains its children's; but `.rad` keys runs by
  global splat index and a node's children live in a *later chunk*, so a parent
  and its children can never land in the same group. The parent's group committed
  immediately while the children's group was still staging its upload, and for
  those frames the region drew with its coarse splats already retired and their
  replacements not yet visible.

  A group that retires coverage now waits until every purely additive group has
  landed, the same guarantee Spark gets from `SparkRenderer.driveSort`, which
  advances `display` only once a sort of the new mapping completes, holding the
  previous complete frame meanwhile. Waiting costs brief over-draw, never a hole,
  since a deferred group keeps rendering its old runs. Pool pressure releases the
  wait, so retirements still happen exactly when their rows are needed.

  Measured over 30 s of streaming the 132-chunk `oldtimers-route` capture: frames
  that lost coverage fell from **258 to 3**, splats lost from **667,680 to
  6,316**, and the worst single-frame loss from **2.14% to 0.38%** of the drawn
  set. In the first ten seconds, where the artifact was most visible, 130 such
  frames became 1. A tick-bounded release was tried first and is worse on both
  counts, it retires in bulk when it fires, so the bound survives only as a
  backstop well past the point of interference.

- **`.rad` loaded every spherical-harmonic band the file carried, on every
  device, ignoring both the `smooth` performance profile and an explicit
  `shBands: 0`.** `buildRadScene` never received the resolved band count, so
  `scene.shBands` came straight from the file's `maxSh`, and
  `StreamedSplatMesh.fromSource` applied it *after* spreading the caller's
 options, overriding them. `.rad` was the only format affected: LCC threads
 the resolved count into its builder, and LCC2/SOG treat SH as opt-in.

 The cost was paid every frame by every drawn splat: four extra `RGBA32UI`
 texture fetches and a 15-coefficient evaluation in the vertex stage, plus
 128 B/splat of memory (64 GPU + 64 CPU backing). On a 3-band capture that is
 **48% of the entire pool**, measured on an 8.6M-splat `.rad` at 8.8M pool
 slots, where the pool fell from 2,221 MB to 1,144 MB once the bands were
 actually declined. Mobile defaults to the `smooth` profile, so mobile was
 paying all of it while asking not to.

  `buildRadScene` now takes a `maxShBands` cap. The cap is deliberately
  all-or-nothing, `0` declines SH, anything else keeps the file's bands -
  because the `.rad` decoder emits the file's full band count and
  `SplatMesh.writePackedSh` only copies packed words when the counts match
 exactly; a partial cap would allocate the smaller set of textures and fill
 them with *neutral* words, paying for SH and rendering flat.

- **A `.rad` whose budget could not hold its leaves rendered at uniform low
 detail, and never sharpened as the camera approached.** `buildRadScene` chose
 between the prefix reader and the foveated page table on leaf count alone
 (`> 6M`). The prefix reader is camera-*independent*, it grows a resident
 prefix of the chunk sequence, coarsest first, until the drawn count reaches
 the budget, so its one advantage is reaching full leaf resolution when
  `budget >= leafCount`. Below that the advantage inverts: a 1M budget on a
  5.9M-leaf capture spreads ~1/6 resolution over every surface, and walking up
  to something cannot sharpen it.

  Desktop hid this because `liftBudgetToFinestLevel` raises a moderate capture's
  budget to its leaf count. **Mobile is deliberately exempt from that lift**, so
  phones took the prefix path at a sixth of the resolution. The choice now also
  tests the budget, against the post-lift value, mirroring the caller's own
  precondition for the lift (neither `budget` nor `maxBudget` pinned), so a
  host sizing markers explicitly gets the foveated path for the same reason a
  phone does. Desktop behaviour is unchanged.

- **A page-table `.rad` handed the worker spherical harmonics the mesh had
  already declined, and they were 60% of its chunk cache.** The `.rad` decoder
  emits whatever bands the file carries regardless of what was requested, and
  `forwardChunkToWorker` passed them straight through, so declining SH stopped
 the pool allocating it and the shader evaluating it, but every cached chunk
 still carried it. At 15 coefficients that is 60 B/splat against 40 B for
 position, colour and covariance combined.

 Measured on the reference capture with SH declined: the worker counted
 **100 B/splat** where the cache-floor estimate assumes 40, so the cache filled
 at ~52 chunks' worth of its limit instead of the 132 the estimate predicts,
 and the frontier thrashed, one eviction and one refetch every couple of
 seconds indefinitely, resident chunks oscillating in the low 70s, on a scene
 that had long since settled at full detail. After the fix the same scene
 reports 29 B/splat, converges to 79 chunks at 198 MB of a 330 MB limit, and
 issues **zero** fetches and zero evictions once settled.

- **A page-table `.rad` thrashed its chunk cache, refetching a chunk every
 couple of seconds forever.** `estimateSceneDecodedBytes` sizes the worker's
 cache floor, and it sized from `contentSplatCount`, which for a LOD tree is
 the **leaf** count. The cache holds whole decoded *chunks*, and those carry the
 internal merged nodes too. On the reference capture that is 5,880,090 leaves
 against 132 x 65,536 = 8,650,752 nodes, so the floor came out at **224 MB for
 a working set of ~229 MB**: the frontier evicted a chunk, immediately asked for
 it back, and never converged. Measured on an iPhone as resident chunks
 oscillating 75/76 with `cacheFull` set and priority fetches still climbing.

 It now sizes from `chunkSize x chunkUrls.length`, 330 MB on that capture, so
 the working set fits. This does not reserve memory: the floor is a cap on a
 cache that only holds what has been fetched, and with the sweep declined on
 mobile that is the working set and nothing more. New `fetchCounts` on
  `StreamedSplatMesh` (lifetime totals by fetch kind, plus evictions and cache
  state) is what made the distinction between "still converging" and "thrashing"
  visible; the demo HUD shows it.

- **A page-table `.rad` kept streaming indefinitely after the view had settled,
  pulling the whole capture down on speculation.** The background sweep
  pre-warms every chunk into the worker cache in file order, and stops only when
  `pageTableCacheFull` latches, which needs an eviction. But the cache floor is
 sized from the capture itself
 (`min(PAGETABLE_CACHE_FLOOR_BYTES, estimateSceneDecodedBytes(scene))`), so any
 capture that fits its own floor is never evicted from and is therefore swept to
 completion. On the 5.9M-leaf reference `.rad` with SH declined that is a
 235 MB floor against a 235 MB decoded capture: a steady ~1 chunk/second drip
 downloading all 447 MB and decoding it, long after the scene was at full
 detail.

 The `smooth` performance profile (the default on mobile) now declines the
 sweep. On desktop it is a good trade. RAM is cheap and turning the camera is
 served from memory rather than a level-by-level network ladder. On a phone it
 is the wrong trade in every currency at once: possibly-metered download, a
 decoded cache rivalling the splat pool on the platform that kills tabs for
 exactly that, and continuous decode CPU and heat, all for a camera move that
 may never happen. The cost of declining is that refinement after a turn
 fetches on demand.

- **Demo: performance mode overrode every device tier instead of tightening
 it.** It passed `PERF_MODE_BUDGET` as an explicit `budget`, and an explicit
 budget bypasses `resolveSplatBudget` entirely, so the flat 1M constant
 replaced whatever the device's own tier had chosen. On a Galaxy S7 that
 *raised* the budget from its 750k tier to 1,000,000: performance mode
 increasing the load on the weakest device tested. It now applies
  `min(PERF_MODE_BUDGET, resolveSplatBudget())`, a ceiling rather than a
  setting, and is unchanged wherever the device budget already meets or exceeds
  the cap.

- **Demo: the HUD told WebGL2 devices to set `?gpuTimestamps=1`**, a flag that
  can never resolve there, timestamp queries are WebGPU-only, and `/go` sets it
  unconditionally anyway. It now says so.

- **`StreamedSplatMesh` gave every iPhone a 128 MiB decoded-chunk cache instead
  of 32 MiB.** Its private `defaultCpuCacheBytes` re-derived the policy in
  `resolveCpuCacheBytes` but defaulted a missing `navigator.deviceMemory` to
 4 GiB. iOS never reports `deviceMemory` at all, so every iPhone took that
 fallback, on the one platform that kills a tab for holding too much. It now
 delegates to `resolveCpuCacheBytes`, which is also exported.

 Note this does **not** shrink the cache on a page-table `.rad`: that path
 takes `max(cpuCacheBytes, min(PAGETABLE_CACHE_FLOOR_BYTES, sceneDecodedBytes))`,
 so the capture-sized floor wins and the 32 MiB never applies. The fix matters
 for the non-page-table streamed paths; page-table memory is bounded by the
 sweep change above instead.

### Changed

- **`.rad` no longer forces Spark's √8 (≈2.83σ) Gaussian cutoff on mobile.**
 Spark sets `sqrt(8.0)` unconditionally and matching it is what makes a `.rad`
 look like Spark's render, but it is wider than the 2.5 every other format
 falls back to on mobile, and quad area goes as σ², so `.rad` drew 1.28× the
 fragments of any other format on the one class of device where splat
 rendering is fill-bound. Desktop is unchanged. New
  `recommendedRadMaxStdDev(profile)` exports the policy.

### Added

- **A no-WebGPU mobile tier, the tightest of them.** `SplatDeviceProfile.hasWebGpu`
  (from the presence of `navigator.gpu`). Without WebGPU there is no compute
  path, so the depth sort runs on the CPU in a worker and scales with splat
  count far worse than a GPU radix sort, and a phone still on the WebGL2
  fallback is old for the same reason it lacks WebGPU. Measured on a Galaxy S7
  (2016, WebGL2) at 750k, the low-power tier at the time: **5 fps, 194 ms
  frames**. Desktop is
  exempt: a desktop on the fallback sorts on a far stronger CPU, and a driver
  blocklist on capable hardware should not cost it 8× its budget.

  The tier caps are now a **minimum over every applicable cap** rather than a
  ternary chain. The chain was order-dependent, and the order was wrong: a
  low-power *headset* matched the headset branch first and got 1M, more than the
  a low-power phone got, purely because of evaluation order.

- **A low-power mobile tier.** `SplatDeviceProfile.isLowPower`, detected from a
  `deviceMemory` reading of ≤4 GiB on a mobile device, trustworthy because the
 signal is capped downward but never inflated. Caps the starting budget at
 a tighter ceiling than the flagship one. Deliberately *not* keyed on
  `hardwareConcurrency`, which would get this backwards: the A51 it exists for
  is octa-core while an iPhone 15 Pro reports 6.

- **`estimateUnifiedWorkBufferBytes` / `WORK_BUFFER_BYTES_PER_SLOT`.** Every
  `THREE.StorageBufferAttribute` keeps its JS typed array alive for the
 renderer's lifetime, three's WebGPU backend has the
  `attribute.onUploadCallback()` that would release it commented out, so the
  unified work buffer costs its bytes twice (GPU plus a CPU mirror nothing ever
  reads back). `estimateSplatPoolBytes` prices the pool and knows nothing about
  it, leaving hosts sizing the unified path with roughly half the real figure.

- **Demo: `?hud=1`, an on-screen performance panel.** fps, mean and 1% low
  frame time, active splats against budget, resident chunks, SH bands, pixel
  ratio, backend, and the GPU compute-vs-render split. The existing rig was
  unreachable on the devices that need it: benchmark JSON goes to a `hidden`
  `<pre>` and `console.info`, and on Windows there is no Safari remote
 inspector for an iPhone at all.

- **Demo: `?gpuTimestamps=1` now works on its own.** It was gated on an active
  `?benchmarkSeconds=` run, which made the compute-vs-render split, the one
  measurement separating a sort-bound frame from a fill-bound one, unreachable
  during ordinary use.

- **Demo: adaptive pixel ratio now defaults on for mobile** (`?adaptiveDpr=0` to
  pin it off), a canvas resize is cheap and does not disturb streaming, unlike
  the budget.

  **In the default mobile configuration this changes nothing**, and the entry
  would be misleading without saying so: performance mode is also default-on
  there, the adaptive path is gated on `!perfMode.enabled`, and perf mode
  already pins the pixel ratio to 1, which is the adaptive helper's floor
  anyway. It takes effect only with performance mode off.

- **Dev server serves HTTPS on the LAN when mkcert certificates are present.**
  Testing on a phone needs more than `host: true`: WebGPU is gated on a secure
  context, so a plain `http://192.168.x.x` origin silently falls back to WebGL2
  and measures the wrong renderer. Guarded by `fs.existsSync`, so a clone
  without the certificates keeps plain HTTP on localhost.

- **Cross-mesh fetch prioritization: `ChunkFetchScheduler`, plus
  `StreamedSplatMeshOptions.fetchWeight` / `fetchScheduler` and
  `StreamedSplatMesh.setFetchWeight`.** `CameraBudgetGovernor` decides what each
  mesh may *draw*; nothing decided what they may *fetch*. Every mesh owns its
  own `ChunkLoader` and fetches toward its own in-flight cap, so a scene of
  thirteen streamed markers issued up to ~100 concurrent equal-priority chunk
  requests and a marker the camera was pointed at queued behind a dozen distant
  ones for bandwidth and connection slots. Spark has no such problem
  structurally: one global traversal orders every fetch want
  biggest-on-screen-first, so its network order *is* its visual priority.
  The scheduler is that ordering at whole-mesh granularity, shared by every
  mesh in a scene exactly as a `SplatPool` is, granting a bounded number of
  slots in proportion to the governor's own camera-projected weight, with a
  per-mesh floor so far meshes keep trickling their coarse coverage instead of
  stopping dead. It brokers *slots*, never fetches, so a future scene-level
  shared loader plugs in underneath unchanged. Hosts that supply neither option
  keep the previous behaviour exactly.
- **The page-table background sweep is gated on `fetchWeight`.** That sweep
  wants the *entire* capture, and ran regardless of budget or visibility, so
  every hidden and distant marker was speculating about camera moves that had
  not happened, which is most of the traffic competing with the marker actually
  being looked at. It now runs only for a mesh with weight. The trade is that
  re-focusing a marker that went cold refetches rather than hitting a warm
  worker cache. Unset `fetchWeight` (the default) sweeps as before.

### Fixed

- **The page-table path now cancels chunk fetches it no longer wants.** The
  classic reader has always aborted fetches whose file backs no desired run;
  `reschedulePageTable` never did, so after a camera cut a `.rad` mesh kept
 paying for the old view until those requests happened to finish, on a shared
 pipe, at the expense of the new one. Sweep fetches are exempt (no frontier
 plan ever names them, so matching them against the desired set would abort
 every one of them on the next reschedule).

- **Bounded per-plan cost for the page-table frontier: `FrontierPager.update`
 takes `maxAppends`.** A hard camera cut used to arrive as one paging plan the
 host applied whole, 141ms of pool writes in a single tick, a visible freeze.
 The cap rewrites the requested frontier into an intermediate one: every
 resident kept except the few that must go to seat the admitted newcomers, plus
 the first `maxAppends` newcomers, with `truncated` telling the caller to
 reschedule. Capping appends alone would not bound the cost, because reaching a
 new frontier also *evicts* and every eviction can relocate a survivor
 (swap-remove), so evictions are paced against the appends, bounding
  `moves + appends` at `2 x maxAppends`; with slab headroom nothing is evicted
  and there are no moves at all. The cap is deliberately in the pager rather
  than in the traversal budget: the stalls are driven by churn, not growth, and
  a frontier that swaps membership at constant size defeats a budget ramp. Every
  intermediate frontier is a superset of the old and new sets' intersection, so
  no slot ever describes data the host did not write, and the traversal still
  runs at the full solved cut, only delivery is spread over frames, as Spark
  achieves with paced page uploads. Measured on a 13-marker scene: worst plan
  141ms -> 37ms with the settled frontier unchanged. The plan message reports
  `converged: false` while the cap is holding it back.

- **The `.rad` page-table frontier now solves for the cut that spends its draw
 budget**, instead of refining to a fixed pixel target and stopping.
  `foveationTargetPx` is the *coarsest* cut worth drawing, not a budget: a mesh
  granted 4.6M splats whose 1px cut selected only 890k left ~80% of its budget
  unspent and rendered far softer than Spark at the same pose. The worker now
  carries a warm-started cut across reschedules (Spark's `lastPixelLimit`),
  refining below the target while budget remains and the frontier still has
  cached children, and coarsening when the budget clamps. One traversal per
  reschedule plus at most one extra when badly under, converging over a few
  frames, not the bisection that used to run the whole O(frontier) walk up to
  five times per reschedule. `traverseFrontier` reports `budgetClamped` and
  `refinable` so the solve can tell "the budget stopped me" from "nothing was
 above the cut", and the plan reports its `solvedLimit`.

- **A live screen-radius band: `SplatMesh.setScreenRadiusBand`** (protected), with
  `minSplatScreenRadius` / `maxSplatScreenRadius` now uniforms rather than graph
  constants. A foveated mesh scales the band with its solved cut, because the
  band spans one LOD level: refining the cut selects smaller splats, and a band
  left at the coarser setting culled exactly the detail the refinement bought.

- **Slab pages for the page-table frontier.** The frontier's slots are backed by
  fixed 65,536-splat pages (Spark's `pageSplats`, and the `.rad` chunk size)
  instead of one contiguous reservation, and are reserved for the mesh's *current*
  budget rather than its ceiling, growing and releasing as the governed budget
  moves. This is what lets several streamed meshes share one pool: a mesh no
  longer claims its whole ceiling as one block for the session. The final page
  takes only the remainder, since rounding it up would exceed a pool sized to the
  capacity rather than to a page multiple of it. New `FrontierPager.resize` and a
  `resize` worker message carry the change without touching the chunk cache, so
 growing or shrinking re-downloads nothing.

- **`SplatPool`, and `SplatMeshOptions.pool` to share one.** A mesh's storage -
 the data textures, their CPU backing and the row allocator, is now a separate
 object several meshes can draw from. Sharing replaces per-mesh ceilings with
 one envelope: rows go to whichever mesh needs them, so a mesh the camera is
 near can hold far more than an even split would allow while a distant one
 holds almost nothing, and none of them has to reserve a private ceiling up
 front. Pool memory is bounded by the pool, not by the number of meshes.

 The pool belongs to whoever constructed it: `SplatMesh.dispose` releases that
 mesh's rows and unregisters it, but only frees the textures of a pool the mesh
 allocated itself. Note the trade-off, when a shared pool fragments,
  `compact()` packs *every* tenant's rows and each rebuilds its draw state, so
  one mesh's churn stalls the others. (Meshes drawing from separate pools are
  unaffected, and nothing changes for a host that never passes `pool`.)

- **`StreamedSplatMesh.contentSplatCount`** and **`StreamedScene.contentSplatCount`.**
  The capture's real content size, when the format declares it (`.rad` reports
  its leaf count). Distinct from `maxResidentSplats`, which a *foveated* source
  reports as the requested budget because its pool holds a camera-directed
  resident set rather than the whole tree, so until now a host had no way to
  learn how big a `.rad` actually is. A host splitting one budget across several
  streamed meshes should clamp each share to this: a mesh cannot spend more than
  it contains, and budget handed past it is better given to a mesh that can use
  it.

### Fixed

- **Gather compute pipelines are compiled off the render frame.** WebGPU defers
  compiling a compute pipeline to its first dispatch, and a source's first
  `gather` runs inside `update`, so each newly added source paid its shader
 compile inside one render frame. Measured on a 13-marker scene: a first
 dispatch took up to 2.0s while every later dispatch of the same pipeline took
 under 0.4ms, and the worst update frame was 2,022ms. `WorkBufferGather.warmUp`
 now compiles through `computeAsync` when the gather is created, best-effort
 and awaited by nobody, bringing the worst update frame to 194ms and the first
 dispatch to 1ms.

 Compiling requires actually dispatching, so `WorkBuffer` reserves
  `SCRATCH_SLOTS` past its drawable capacity for the warm-up to write into.
  Dispatching zero workgroups also compiles, but WebGPU warns about it once per
  source; writing into a *drawn* slot would be worse still, because `prepare`
  reuses a cached gather when a source's content and slice are unchanged, so the
  warm-up's output would not reliably be overwritten before the draw.

- **`RadLodSource` no longer re-walks its whole decoded prefix several times a
  frame.** Two independent causes, together 92% of all frame CPU on a 13-marker
  scene (33.6ms mean per call, 1.1s worst). First, the frontier cache was keyed
  on the exact budget, but a camera-weighted governor rewrites that every frame
  as the camera drifts, a third of all calls missed while selecting the very
  same prefix depth. The cache now stores the budget *range* over which the
  chosen depth stays correct, which frontier counts rising monotonically with
  depth make exact. Second, the depth search rebuilt the runs at every level it
  rejected; per-depth counts are a pure function of the decoded prefix (and
  `discoveredDepth` is contiguous, so every chunk the walk reads is present), so
 they are memoized and only the winning depth builds runs. Measured: 33.6ms ->
 0.18ms per call during load, 26.2ms -> 0.08ms under camera churn, with update
 CPU falling from 102.7ms to 5.0ms mean and 14.9 to 50.4 FPS.

- **`substituteCoverage` no longer allocates a leaf bitmap per call.** It runs
 for every deferred group of every streamed mesh on every reschedule, ~800
 times a second on a marker-heavy scene, at a mean span of 60k leaves, so
 allocating and zeroing the bitmap each time discarded ~480 MB in ten seconds
 and made it the single most expensive function in the frame. The buffer is now
 a grow-only scratch, coverage is marked with `fill` over each overlap instead
 of a per-leaf loop, and the gap walk uses `indexOf` rather than stepping leaf
 by leaf. 0.17ms -> 0.05ms per call; update CPU mean 12.3ms -> 6.6ms and p95
 26.3ms -> 7.5ms.

- **A page-table mesh no longer allows itself 2 GiB of chunk cache regardless of
 what the host asked for.** The floor existed because a `.rad` frontier only
 refines into chunks resident *together*, so a cache far smaller than the working
 set thrashes and the view stays coarse, but as a flat `max(hostShare, 2 GiB)`
 it meant 13 markers were each *allowed* 2 GiB against a 4 GiB tab heap, making
 the one number meant to prevent thrashing the largest memory risk in the viewer.
 It is now bounded by the capture's own decoded size, and never below the host's
 value.

- **A paging plan answered against a stale pager capacity is dropped rather than
 applied.** Because storage now grows and shrinks with the budget, a
  `reschedule` posted before a `resize` is answered from the old capacity; its
  slot numbers no longer describe the slab, so applying it wrote some splats
  nowhere and left those slots holding the previous frontier's data, a coarse
  node's data in a slot the frontier wanted fine, which renders as one enormous
  splat (~100× a leaf). Plans now carry the capacity they were built for.

- **`CameraBudgetGovernor` no longer suspends sources owned by a
  `UnifiedSplatRenderer`.** The unified renderer forces `visible = false` on
 every source it draws (to keep the regular scene pass from double-drawing
 them), which the governor read as "hidden member", weight 0, budget 1, so
 every unified-drawn streamed mesh froze at whatever detail was resident when
 the renderer attached. The governor now weighs members by the new
  `SplatMesh.effectiveVisibility` (the unified per-source visibility while one
  owns the draw, else `Object3D.visible`), which the picker already used
  internally for the same reason.

- **`estimateSplatPoolBytes` under-reported CPU backing by ~12 B/splat.** It
  counted the four backing arrays and the draw-order indices but omitted the
  active-list source index, the pool-slot map and the picker's pool-index
  template, and it ignored that `poolFloatTextures: 'float16'` keeps the
  half-encoded texture images *alongside* the float32 backing rather than
  instead of it. A float32 pool is 136 B/splat of capacity, not 124, and
  `'float16'` is now correctly reported as saving GPU bytes only, its total is
 unchanged, not 16 B/splat cheaper. Hosts sizing ceilings against a memory
 envelope were over-committing by ~10 %.

### Added

- **`SplatMesh.effectiveVisibility`.** The visibility that actually decides
 whether the mesh's splats reach the screen; see the fix above. Custom
  `CameraBudgetMember` implementations may expose it too, when present it
  wins over `visible`.

- **`CameraBudgetGovernor`.** Weights a shared splat budget by how large each
  mesh projects from the camera, so a marker you approach takes budget off the
  distant ones instead of every marker holding a fixed `total / N` share. Wraps
  `BudgetGovernor` (which stays a pure, camera-free allocation policy), measures
  `computeSplatBounds()` × `matrixWorld` so weighting is correct before a chunk
  has loaded, and throttles internally, call `update(camera)` once per frame.
  Per-member `priority` maps Spark's `lodScale` tiers (focused 2, adjacent 0.25,
  hidden 0), and `fixedWeight` opts a main scene out of camera weighting while it
  still shares the total. See
  [`docs/guide/multi-mesh-budgets.md`](docs/guide/multi-mesh-budgets.md).
- **`StreamedSplatMeshOptions.maxBudget`** and **`StreamedSplatMesh.maxBudget`.**
  Separates the ceiling `setBudget` may raise a mesh to (and the size its pool is
  allocated from) from the budget it starts at. Without it a governed mesh could
  only ever be *shrunk* below its construction budget, the pool is allocated
  once and never grows, which is why a hand-split marker pool stayed coarse near
  the camera however the budget was reallocated.
- **`StreamedSplatMeshOptions.lodScale`** and the matching mutable accessor.
  Spark's per-mesh `lodScale` for `.rad` `foveationMode: 'pagetable'`: scales the
  frontier cut (`pixel_scale × lodScale ≤ limit`) by posting `limit / lodScale`.
  No-op where there is no per-splat cut to scale.
- **`StreamedSplatMesh.drawBudget`.** The governed page-table draw target: what
  actually bounds the frontier's descent, as opposed to `budget`, the pool's
  allowance. `0` outside `pagetable` mode.
- **`estimateSplatPoolBytes`.** Prices a pool from its real allocations (pool
  textures, packed SH, sort buffers, CPU backing, capacity factor), so a
  `maxBudget` ceiling is a computation rather than a guess. Pools cost their
 ceilings whatever the shared budget is split to, so for several markers the sum
 of the ceilings is what has to fit.
- **`BudgetGovernor.setWeights`.** Writes a batch of weights and reallocates
 once. A loop of `setWeight` reallocates per call, and each reallocation pushes
  `setBudget` to every member, forcing an LOD reschedule on all of them.
- **`webGpuPowerPreferenceOptions` / `supportsWebGpuPowerPreference`.** Host
  bootstrap helpers that omit WebGPU `powerPreference` on Windows, where Chrome
  ignores the option and logs a console warning
  ([crbug.com/369219127](https://crbug.com/369219127)). Demo, getting-started
  sample, and troubleshooting docs now use the helper; pass
  `...webGpuPowerPreferenceOptions()` into both `requestAdapter` and
  `WebGPURenderer`.

### Changed

- **`BudgetGovernor` member weights now accept `0`**, which *suspends* the
  member: it is excluded from the weighted split, held at a 1-splat floor (0 is
  not a legal budget), and releases its whole share. Spark's `lodScale: 0`
  hidden tier, without unregistering, so bringing it back is free. Previously
  `register`/`setWeight` threw `RangeError` for any weight `<= 0`; they now throw
 only for negative or non-finite weights. A suspended member's pool is *not*
 released (it was allocated at construction) and a streamed mesh keeps its
 pinned coarse shell, so it holds ≈0 of the budget rather than exactly 0.

- **The npm package is now `@voluma/vlam`**, not `vlam`, the bare name was too
 short and too close to existing packages to claim. Every import and subpath
 moves with it: `@voluma/vlam`, `@voluma/vlam/effects`, and
  `@voluma/vlam/formats/{rad,lcc,spz,splat,ksplat}`. Nothing to migrate, the
  bare `vlam` name was never published, so no release ever exposed it. The
  scope is published with `publishConfig.access: "public"`.

- **Vitest 3 → 4** (`vitest` and `@vitest/coverage-v8` at `^4.1.10`). Clears the
  last `npm audit` finding, a high-severity `brace-expansion` DoS reachable
  through `@vitest/coverage-v8 → test-exclude → glob → minimatch`, which had no
  fix on the Vitest 3 line. `npm audit` is now clean, including with `--omit=dev`
  (the published package has always been unaffected: its only dependency is the
  `three` peer). Dev-tooling only, no source, config or test changes were
 needed, all 781 tests and the coverage report are unchanged, and the dev
 dependency tree drops 47 packages.

- **GitHub is the project host** ([Voluma-ai/vlam](https://github.com/Voluma-ai/vlam)).
 Issues and pull requests are triaged there.
 [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the build gates
 plus a `secrets` job against `.gitleaks.toml`. Issue and pull-request
 templates live under `.github/`. A tag-triggered
 [`release.yml`](.github/workflows/release.yml) publishes to npm with
 provenance. TypeDoc source links are pinned by `sourceLinkTemplate`.
 Docs, badges and package metadata updated throughout; no library or
 public-API change.

### Added

- WebXR stereo viewing across static, streamed and unified render paths:
 per-eye projection and viewport sizing, one cyclopean head sort, head-driven
 streaming LOD, session-matched WebGPU/WebGL setup through `xrSessionInit`,
 presentation-time splat budgeting through `resolveXrSplatBudget`, and
 headset framebuffer guidance through `recommendedXrFramebufferScale`.
 The demo preserves the exact desktop eye pose across entry/exit, aligns its
 rig against the first local-floor head pose, caps scenes mounted mid-session,
 and releases sessions whose renderer attachment fails. See
 [`docs/xr.md`](docs/xr.md).
- Research (demo-only, no API change): selection **volume estimation** -
  `≈ volume` on the `?separate=1` panel estimates how much of a selection is
  matter versus air. A capture is a hollow shell (3DGS reconstructs surfaces),
  so the estimate closes the shell on a voxel grid, occupancy from
  opacity-thresholded splats dilated by their covariance radius, plus collision
  triangles when the host has them, flood-fills air from the selection
  boundary, and reports a bracket (`massLower`–`massUpper`) with a `leaked`
  flag when the shell does not close, never one false-precision number. The
  analysis, error model, and honest accuracy expectations (~5–15% for closed
  well-scanned objects; unbounded for open shells without closing/collision)
  are in `docs/design/volume-estimation-notes.md`;
  the estimator lives in `src/demo/volume-estimate.ts` with quantitative tests
  against analytic shapes. Not a roadmap milestone, research toward a possible
  library API.
- Volume selection and separation (M16): select a region of a loaded cloud with
  a placed box, sphere or cylinder and split it into its own `SplatData`, so
  that part can be posed and animated independently of the rest. New on the
  main entry: `createSelectionVolume`, `selectInData`, `countInData`,
  `partitionSplatData` (+ `SelectionVolume`, `SelectionVolumeKind`,
  `SelectionVolumeOptions`, `SplatPartition`). `SelectionVolume` is a
  one-method interface (`containsPoint`), so custom shapes plug into the same
  functions. Selection is by splat **center**, which keeps the two halves an
  exact partition, `inside + outside` renders identically to the original
  until the part's transform moves. Non-uniform volume placement is exact (the
  test runs in the volume's unit space); a singular or non-finite placement
  throws rather than silently selecting everything. Fully decoded scenes only:
  a streamed mesh's resident set is a moving LOD, not ground truth. Docs:
  `docs/features/separation-notes.md`;
  demo `?separate=1`.
- `@voluma/vlam/formats/lcc` gains `partitionTriangleMesh` (+ `TriangleMeshPartition`):
  splits a collision `TriangleMeshData` by the same selection volume, so a
  separated region keeps its collision geometry. Any-vertex-inside, no
  clipping, so the halves tile the original exactly and winding is preserved;
  malformed meshes throw instead of yielding `NaN` positions. It lives on the
  format subpath, beside the collision loader it pairs with, rather than on the
  main entry.
- `@voluma/vlam/effects`: `SdfShape` gains `kind: 'cylinder'` (a Y-axis capped cylinder
  taking `radius` + full `height`), so the in-shader shape list can mirror all
  three selection volumes for a live highlight. The packed `kind` slot is now a
  3-valued index (`0` sphere · `1` box · `2` cylinder) rather than a boolean
  flag; sphere and box indices are unchanged.

- **Front-door documentation for public readers.** A README "Why VLAM! (and
  when not to)" section comparing the project honestly against SparkJS,
  gsplat.js, GaussianSplats3D, PlayCanvas SuperSplat/Engine and the three.js
  examples, including where those are stronger today (maturity, WebGL-first
  reach, ecosystems, authoring/training pipelines VLAM! deliberately lacks).
  A new [`docs/guide/troubleshooting.md`](docs/guide/troubleshooting.md)
  (symptom → cause → fix: colour space, WebGPU storage-buffer limits, the
  missing per-frame `update`, `206 Range` origins, the misleading
  `NotReadableError` over 2 GiB, duplicate `three` copies, WebGL2 unified /
 streamed-sort caveats, softness tuning, log silencing), linked from the
 guide reading order and README. A **browser & platform support matrix** in
 [`docs/capabilities.md`](docs/capabilities.md) separating device-verified
 rows (desktop Chromium WebGPU and the WebGL2 fallback audit, iPhone 15 Pro
 Safari WebGPU) from expected and explicitly unverified ones (Adreno
 flagship later, Firefox).
 README's "Migrating" section, which documented `0.0.17`/`0.0.18` migrations
 no external user can have consumed (the package has never been published),
 is now a pointer to this changelog. Documentation only, no library or
 public-API change.

- **`setVlamLogHandler(handler | null)`**: every diagnostic the library emits
 now routes through one replaceable hook, prefixed with `vlam:`. Pass a
 handler to forward VLAM! warnings into a host logger, `null` to silence
 them, or no argument to restore the console default. Worker scopes are
 excluded by design: they report failures as structured messages, not logs.
- Exported `SplatInputOptions` and `ChunkFileFormat` from the main entry -
 both are referenced by public loader signatures, so a host writing a wrapper
 can now name them. `RadChunkRangeRequest` is exported from
  `@voluma/vlam/formats/rad`, mirroring `LccChunkParams` on `@voluma/vlam/formats/lcc`.
- `@experimental` TSDoc on the surfaces that may change in a minor release
  (`UnifiedSplatRenderer`, `UnifiedSplatRendererOptions`, `UnifiedSourceView`,
  `SplatScene`, `sortStrategy: 'radix'`, and the `.rad` foveation options),
 plus an "API stability tiers" section in the README.
- First-class **non-uniform (per-axis) mesh scaling**: `mesh.scale.set(sx,
 sy, sz)`, including non-uniform scale in ancestors and unified per-source
 transforms, renders, sorts, picks, and answers spatial queries correctly
 end-to-end. Rendering was already linear-map exact (`Σ' = A·Σ·Aᵀ`) and is
 now covered by CPU contract tests; fixed the GPU sorter's depth
 quantization window (the exact modelView depth-row norm) and
  `queryNearest`/`queryHeight`, which now gather with a conservative
  `radius / min-axis-scale` and rank candidates by **world** distance.
 Animated scale is re-upload-free (matrix uniforms only; one gather dispatch
 per frame per moved unified source). Demo: `?scale=2,0.5,1`. See the
 "Non-uniform scale" section of `docs/capabilities.md` for the documented SH
 approximation under strong anisotropy.

- User guides under `docs/guide/` (getting started, loading, streaming & LOD,
 unified rendering, effects & modifiers, picking & queries) whose code
 samples are real TypeScript files in `docs/guide/samples/`, compile-verified
 against the source tree by `npm run docs:samples` (run in the `docs:check`
 CI job). README now links the guides and its quick-usage snippet is synced
 with the verified getting-started sample.

- Open-source polish: `SECURITY.md` (private disclosure via
 security@voluma.ai; parsing untrusted scene files is in scope), a generated
 TypeDoc API reference committed under `docs/api/` (`npm run docs:api`, kept
 fresh by the `docs-api` CI job), test coverage reporting
 (`npm run test:coverage`), a gzip bundle-size
 budget for `dist/index.js` (`scripts/check-bundle-size.mjs`, `bundle-size`
 CI job), and README CI/license badges. CI restructured into
 lint / typecheck / test / docs jobs plus a full demo+lib `build`.
 No library behavior changes.

- 0.2.0 API-freeze prep (E9): the main entry now exports `isAbortError`
 (documented in README "Errors", loaders already rejected with `AbortError`
 on cancel, but hosts had no supported way to classify it) and the
  `SplatUpdateOptions` type used by `SplatMesh.update` /
  `StreamedSplatMesh.update`. Public-entrypoint smoke tests
 (`src/lib/__tests__/public-api.test.ts`) import only the index, `effects`,
 and `formats/*` entry files so an accidental export removal fails CI.
  `UnifiedSplatPickResult.source` is now `readonly`. Docs: README "Migrating"
  section (format subpaths since 0.0.18, WebGPU-only unified path,
  `BudgetGovernor` adoption) and capability-matrix sections for
  `orientation: 'source'`, `srgbOutput`, and the
  `supportsUnifiedSplatRenderer` gate. No publish, no tag, no version bump.

- `UnifiedSplatRenderer.pick` (E6): one documented multi-source picking
 semantic, every visible registered source runs its own depth-tested pick
 pass, the hit nearest the camera wins, and the result identifies its source
 (`UnifiedSplatPickResult`). Hidden sources never hit, and a hit whose
 source was removed or hidden while its readback was in flight is dropped
 rather than misattributed. Documented in
  `docs/features/spatial-query-notes.md`.

- `ModifierSlots` (E5): named, ordered modifier slots for hosts stacking
  several effects (reveal + SDF + lighting + fog + opacity) on one mesh.
  Empty slots compile to nothing (no passthrough tax), `apply` hands the mesh
  a reference-stable compacted array so per-frame re-apply and uniform-only
  changes never rebuild the material or bump `graphRevision`, and only
  fill/clear/replace of a slot recompiles (exactly once). Contract documented
  in `docs/design/effects-hooks-notes.md` ("Multi-slot stacks") and pinned by
  `src/lib/__tests__/modifier-slots.test.ts`.
- `BudgetGovernor`: a shared splat-budget API that splits one total budget
 across multiple `StreamedSplatMesh` instances by priority weight (replacing
 the host-side "0.7 when markers exist" hack), with cap-aware reallocation on
 register/unregister/weight changes, grow hysteresis against membership
 churn, and a `sum(member budgets) ≤ total` invariant. Applied through the
 public `setBudget` path, so flat-leaf LOD scheduling, the LCC2 octree cut,
 and the RAD page-table draw budget all follow the governed value.
- E2 stress/property tests for `UnifiedSplatRenderer` (main + N marker
 sources): random add/remove/hide/opacity/modifier/transform churn with a
 shadow model of the shared work buffer asserting slice completeness, no
 double-draw indices, capacity accounting, and gather-cache freshness; plus
 an explicit guarantee that `setDepthOfField` never triggers a gather
 rebuild.

- WebGPU host helpers (`recommendedWebGpuRequiredLimits`,
  `estimateLargestStorageBufferBytes`) and an early
  `UnifiedSplatRenderer` check when a work buffer would exceed
  `device.limits.maxStorageBufferBindingSize` (default 128 MiB).
- Opt-in float16 pool textures (`SplatMeshOptions.poolFloatTextures: 'float16'`)
  for `centers` / `covarianceA` (~16 B/splat GPU savings); `covarianceB` stays
  float32 for integer IDs. Demo: `?poolFloat=float16`.
- Adaptive pixel-ratio policy (`suggestAdaptivePixelRatio`) with demo wiring
  via `?adaptiveDpr=1` (defaults unchanged).

### Removed

- Dead internal test scaffolding: the unused `WorkBufferProbe`, obsolete RAD
  selection helpers, and the no-op `radExpansionScale` option. The supported
  RAD page-table, frontier and band paths are unchanged.

### Fixed (unreleased)

- **`.rad` LOD-cut node size now matches Spark's authored size**: Spark's
  `encode_lod_tree` writes the traversal size as
  `2 · (max(α,1)·4 − 3) · avg(scale)` (factor up to 5 at α=2), but
  `radNodeSize` recomputed it with the *rendered-covariance* expansion curve
  `1 + 0.7·(4α−4)` (factor ≤ 3.8). Merged nodes therefore looked 24–32%
  smaller to the cut than to Spark's, the descent stopped ~one LOD level
  early, and large-scale scenes rendered coarser (streaky anisotropic merged
  nodes) than Spark at the identical limit and budget. Verified live against
  SparkJS on the same capture: the corrected cut selects more, finer nodes
  and the far field regains Spark-like darks instead of haze.

### Changed

- **`DEFAULT_FOVEATION_TARGET_PX` is now `1` (was `4`)**: Spark parity for the
  `.rad` LOD cut. Both renderers compute the same limit
 (`targetPx · 2·tan(fovY/2) / renderHeight`), but Spark's `lodRenderScale`
 defaults to 1 px while VLAM stopped refining at 4 px, i.e. about two LOD
 levels early on every ray whose descent did not reach leaves. Small scenes hid
 this (leaves are reached anyway from close range); large-scale captures -
 landscapes and drone scans, lost detail far sooner than Spark, and because
 the streaming `touched` set is derived from the same cut, the finer chunks
 were never even fetched. Detail is now bounded by the draw budget, as
 designed. Raise `foveationTargetPx` to trade sharpness for fill rate.
- **The `?separate=1` demo places its selection volume with an interactive
 transform gizmo** instead of four range sliders. Move, rotate and scale modes
 switch from the panel; the placement survives a shape switch and a restore.
 The gizmo's per-axis scale is baked into the volume's `transform` with unit
 dimensions, so a squashed sphere now selects a true **ellipsoid** and a
 squashed cylinder an elliptical one, exact for the CPU selection, the
 wireframe and `analyticSelectionVolume` alike. Only the in-shader tint preview
 approximates there (`SdfShape` has no ellipsoid mode), collapsing a sphere and
 a cylinder's cross-section to a volume-preserving radius while a box stays
 exact per-axis; the frame math and its exactness boundary are unit-tested in
  `src/demo/selection-transform.ts`. Because the dimensions are now compile-time
  constants, the library's positive-dimension rejection is unreachable from this
  path by construction. Adds `@voluma/three-transform-gizmo` as a **demo-only**
  devDependency, nothing under `src/lib/` imports it and the published bundle
  is byte-identical.
- **Effects now see a `SplatScene` source where it visually is** (M16). The
  per-source placement matrix is applied by the material graph *before* the
  modifier stack instead of as the stack's first modifier, so `ctx.localCenter`
  is the splat's placed mesh-local position and `ctx.worldCenter` /
  `ctx.viewCenter` / `ctx.normal` follow it. Practical effect: an `sdfEffects`
 shape overlapping two sources paints one continuous shape rather than two
 disjoint patches, a `revealPreset` dissolve sweeps a moved part in step with
 whatever it now sits beside, `lightingPreset` relights a source as it
 rotates, and depth of field racks focus through a part at its real depth.
  `SplatContext` gains **`sourceCenter`**, the pre-placement position in the
  source's own data frame, and **`sourceToLocal`**, its linear transform to
  mesh-local space, for effects that should travel *with* a moved source; both
  are identity equivalents on a plain `SplatMesh`.
  `SplatScene.computeSplatBounds()` now reports the sources at their current
 placement (previously the pool's unplaced box), which is the frame to place
 shapes in. A plain `SplatMesh` / `StreamedSplatMesh` and the
  `UnifiedSplatRenderer` gather path are unaffected, their source matrix is
  the Object3D `matrixWorld`, still applied after the stack. Two latent bugs go
  with it: a host modifier that wrote `offset` used to collapse every source
  back to pool-local space, while one that wrote `rotation` lost the placement
  covariance transform (the fold replaces those fields rather than accumulating
  them), and `depthOfFieldPreset` measured an unplaced depth.
  Migration: a modifier authored against the old pool-local coordinates reads
  `ctx.sourceCenter` instead of `ctx.localCenter`, then maps source-frame
 displacements through `ctx.sourceToLocal` (or conjugates source-frame
 rotations by it). Demo: separate a region under
  `?separate=1` and switch effects in the picker. Docs:
  `docs/features/separation-notes.md`,
  `docs/design/effects-hooks-notes.md`.
- `UnifiedSplatRenderer.addSource` rejects a `SplatScene` (both `@experimental`).
  A scene is already a unified pool with its own global sort, and the gather
  pass resolves only one matrix per source, so nesting one drew every inner
  source at its pool-local position, silently, and with the zero-modifier
  gather cache free to reuse the wrong result. Add the scene's sources
  individually, or draw the scene directly.
- The demo prefers a goose committed under `assets/` (Vite serves that
  directory at the site root), so a fresh clone renders a scene with no network
  at all; a checkout without the asset still falls back to the hosted copy
  through the `/remote` proxy. `?scene=` and drag-and-drop are unaffected.
- Credited World Labs' Spark `.rad` / `.radc` format in the README attribution
  list, which named every other format's reference but that one.
- **Docs for outside contributors.** The architecture tour, non-negotiables,
  domain gotchas and verification workflow now live in a human-facing
  `docs/architecture.md`; `AGENTS.md` is a thin pointer for agent tooling.
 README and `CONTRIBUTING.md` point contributors at the new guide. Removed
 the internal agent work queue and an internal branch-review note; the
 remaining `docs/history/**` diaries are unchanged.
- The published `dist/` no longer ships declarations for modules with no
 public entry: declaration emit follows the public entry graph, and the
 worker scripts' message types moved into dedicated `*-worker-protocol.ts`
 modules so the workers themselves stay out of the type graph. The dev-only
  `work-buffer-probe`, `load-worker`, `sort-worker` and `frontier-worker`
  declarations are gone.
- `stripInternal` is on, so `@internal` members (e.g. `SdfEffect._uniforms`)
  no longer appear in the shipped `.d.ts`.
- `declarationMap` is off: the maps pointed into `src/`, which the package
  never ships, so every one was a dead link. JS source maps stay (they embed
  `sourcesContent` and are self-contained), recorded as a deliberate choice
 in `vite.config.lib.ts`.
- Narrowed the documented error contract: the `SplatLoadError`-or-`AbortError`
 guarantee covers the worker-mediated loaders (`loadScene`, `loadSceneFile`,
  `ChunkLoader`, `StreamedSplatMesh`); direct `parseSog` / `parseSogDirectory`
  / `parseSplatPly` calls throw plain `Error` on malformed input. README and
  `docs/guide/loading-scenes.md` updated to match.

- Performance: `UnifiedSplatRenderer` now gates its whole-buffer re-sort the
 same way standalone `SplatMesh` does (skip when the camera is effectively
 stationary and the gathered content is unchanged; any regather or layout
 change still forces a sort, DoF changes never do), and hot per-frame paths
 allocate far less, cached `getUnifiedSourceView` objects and world-bounds
 spheres, persistent prepare/layout scratch in the unified renderer, reused
 sort-worker scratch arrays, in-place LOD-scheduler priority ordering, a
 running streamed-cache byte total, listener-gated streamed performance-event
 snapshots, and removed redundant `Blob` input copies in the SOG parser.
- Uniform loading-error contract across the pipeline: every public loader -
  `loadScene`, `loadSceneFile`, `ChunkLoader.load`/`loadFile`,
  `StreamedSplatMesh.load`/`loadLocal`, now rejects only with
  `SplatLoadError` or an `AbortError`, and the JSDoc documents that contract.
  Streamed manifest failures (HTTP errors, network `TypeError`s, malformed
  manifests, dropped folders without a manifest) are wrapped with the right
  `phase` (`'resolve' | 'manifest' | 'fetch'`); an unknown file extension is a
  `SplatLoadError` (phase `'resolve'`, not retryable) instead of a plain
  `Error`.
- `StreamedSplatMesh.load` now accepts `string | URL` manifest input plus
  `signal` and `baseUrl` options; relative manifest URLs resolve through
  `resolveSplatUrl` (no crash in location-less environments), aborting rejects
 with `AbortError`, and a mesh partially built when the signal fires is
 disposed rather than leaked.
- New exports from the main entry: `UnifiedSourceView` (with `SplatShInputs`
 and `Vec3Uniform`) for embedders building custom passes over
  `SplatMesh.getUnifiedSourceView`, the `SplatSourceFormat` union (now the
  type of `SplatData.sourceFormat`), `MAX_SH_BANDS`, `MAX_SOURCES`,
  `DEFAULT_FOVEATION_TARGET_PX`, `DEFAULT_FOVEATION_DRAW_BUDGET`, and
  `resolveSplatPerformanceProfile`.
- `SplatMesh` gains a `performanceProfile` getter matching
  `setPerformanceProfile`; the mutator convention (property for plain state, a
  `setX` method where the write has behavior) is documented on the setter.
- `SplatScene` bad-id semantics documented as a triad: `setSourceTransform`
  throws, `getSourceTransform` returns `undefined`.
- Docs: `foveationMode` JSDoc now covers `'pagetable'` (the `.rad` streaming
  default); the `@voluma/vlam/effects` module header lists `depthOfFieldPreset` and
  its relationship to `SplatMesh.setDepthOfField`.
- **Breaking** (unpublished package, no compat shims):
  - `parseSog(buffer, signal?)` → `parseSog(buffer, { signal })`, matching
    `parseSogDirectory`'s options object.
 - `SplatScene.removeSource` returns `boolean` (`false` when the id was not
 live) instead of `void`.
 - `StreamedSplatMesh.load`/`loadLocal` and `splatFormatForExtension` throw
    `SplatLoadError` where they previously threw plain `Error`s.
- Tests (E11): property-based sorter permutation tests
  (`sorter-properties.test.ts`), seeded randomized rounds assert exact
  permutation and within-one-bucket depth monotonicity for the counting-path
  pipeline (CPU replay with shuffled scatter to model the unstable parallel
  `atomicAdd`), stable exactness for the CPU worker radix path under streamed
 active-list churn, and edge cases (empty, single, all-tied, out-of-bounds,
 non-finite, extreme depth ranges). No violations found; no behavior change.
- Docs (E10 / ROADMAP L3): work-buffer compaction for modifier-hidden splats
 is rejected with an evidence note in the M15 design doc, the hidden set is
 GPU-only (modifier stacks fold in the gather pass), so compaction would need
 a per-frame count readback before the CPU-sized sort dispatch and would
 break stable per-source slices; drawable-flag collapse (`center.w`, clipped
 in the draw material) stays the permanent mechanism. No behavior change.

- Roadmap and docs reconciled: active [`ROADMAP.md`](ROADMAP.md) is an execution
 queue; milestone evidence lives in `docs/roadmap-history.md`;
 canonical support matrix in [`docs/capabilities.md`](docs/capabilities.md).
- `docs/` reorganized into `formats/`, `design/`, `features/`, `history/`, and
  `archive/` with navigation in [`docs/README.md`](docs/README.md); slim ROADMAP
  links to detail docs.
- Documentation consistency check: `npm run docs:check` (also a CI job).

### Fixed

- The `?separate=1` panel now actually hides for a streamed scene. Its
  `display: flex` rule outranked the UA `[hidden]` rule, so `panel.hidden` was a
 no-op; the selection wireframe stayed on screen too, since it lives in the 3D
 scene rather than the panel.
- `≈ volume` in the separation demo estimated against the wrong frame after a
 separation, where the on-screen mesh is a `SplatScene` at identity but the data
 frame is the placement. It now uses the same matrix as the count and the
 partition.
- Demo FPS stats now stay above the measured effects/paint controls and other
 overlapping bottom chrome as those controls wrap on narrow viewports.
- **Zooming out of a large `.rad` left everything outside the old view black for
 seconds, then painted the whole scene at once.** Four divergences from Spark's
  `new_traverse_lod_trees`, together: the page-table traversal **frustum-culled**
  off-screen subtrees, so the slab held no data at all for them and a widened
  frustum had nothing to draw (Spark instead *foveates*, full detail inside
  `coneFov0`, ramping to `coneFoveate` at `coneFov` and `behindFoveate` behind -
 so off-cone geometry is coarse, never absent); the draw budget was enforced by
 re-running the whole O(frontier) traversal up to five times per reschedule and
 could still overshoot, leaving `FrontierPager` to silently drop part of the
 selection (it is now checked before each descent, so one pass is always
 complete and always in budget); the file-order background sweep saturated every
 fetch slot, so the frontier's own `touched` requests were dropped on every tick
 and the capture downloaded coarse→fine while the region on screen waited (they
 now go first, and the sweep keeps three slots free and stops once the worker
 cache is full); and per-chunk `parent_size` work ran on the main thread for
 every chunk despite being a GPU-cut input this mode never reads, keeping one
 live object per internal node, tens of millions on an 800-chunk capture.
 Also: chunk 0 is handed straight to the worker (`StreamedScene.bootstrapChunk`)
 instead of being refetched, so the tree roots exist before the first traversal
 rather than after a redundant round trip; and paging plans write *runs* of
 consecutive slots instead of one `overwriteRangeData` call per moved splat.
 New `?coneFov0=`, `?coneFov=`, `?coneFoveate=`, `?behindFoveate=` demo knobs
 and a `frontierFoveation` mesh option tune the ramp. `residentChunkCount` now
 reports the worker's chunk count in page-table mode instead of a constant 0.
- **Large `.rad` LOD captures failed to load at all.** The parser-hardening
 pass capped the `RAD0` header's `count` at the renderer's 2²⁴ ceiling, but
 that field is the whole LOD-**tree** node total (53,469,952 for a 37M-leaf
 capture), and `parseRadHeaderMeta` is the streamed reader's entry point, so
 every capture the streaming path exists for was rejected before its first
 chunk was fetched (`SplatLoadError: RAD header declares … above the supported
 maximum of 16777216`). The ceiling now applies in `parseRad` (one-shot), the
 only place a whole file becomes a single pool texture; the header is instead
 bounded structurally against its own chunk table (`count ≤ chunkSize ×
 chunks.length`, with `chunkSize` validated), which caps hostile metadata more
 tightly than the flat number did. Per-chunk count and column-bytes checks are
 unchanged.
- **Loader error contract.** `ChunkLoader`'s worker-level failure handler
 rejected pending loads with a bare `Error`, contradicting the documented
 "`SplatLoadError` or `AbortError` only" guarantee of `loadScene`,
  `loadSceneFile` and `ChunkLoader`. A Content-Security-Policy that blocks
  `blob:` workers hits this in real deployments. It now rejects current and
 later loads with a `SplatLoadError` carrying `phase: 'worker'` and
  `retryable: false`, keeping the `ErrorEvent`'s message where the browser
  supplies one.
- `createLocalDataset` (public) threw a bare `Error` for its two user-facing
  failures (no manifest / more than one manifest); both are now
  `SplatLoadError` with `phase: 'manifest'`. `StreamedSplatMesh.loadLocal`
 passes them through unchanged rather than re-wrapping.

- Input robustness against hostile or corrupt scene files and manifests:
 untrusted splat counts, byte ranges, palette labels, bucket layouts, ZIP
 offsets and streamed-SOG manifest fields are now bounds-checked before they
 size allocations or drive reads (RAD, SPZ, SOG/ZIP, KSPLAT, SPLAT, mesh-PLY,
 PLY headers, LOD manifests, pool row release, HTTP size probing), a legacy
 SPZ gzip expansion cap blocks decompression bombs, deep manifest trees no
 longer overflow the call stack, and `floatToHalf` now truly rounds ties to
 nearest even.

- Dispose lifetimes (E8): `dispose()` is now idempotent on `SplatMesh`,
  `StreamedSplatMesh`, `UnifiedSplatRenderer` and every sorter (no throws or
  double-frees on a second call, or when a render loop outlives the mesh by a
  frame). Real leaks fixed: the mesh's `sourceIndex` storage buffer and the
  unified renderer's work-buffer/source-index/draw-order storage buffers
  (~72 B per work slot) were never released on dispose; a CPU sort-worker
  order or a decoded chunk arriving after dispose no longer flags a
  post-dispose GPU upload or repopulates the cleared cache. Scene swaps in a
  long-lived renderer now terminate every worker they spawned.

- RAD pagetable frontier invariants (E7, ROADMAP L4): the draw-budget limit
  search (`searchLimitWithinBudget`, shared by the frontier worker and
  `selectFrontierWithinBudget`) no longer refines into an over-budget cut and
 reaches a per-frame fixed point for a static camera, the old grow/shrink
 loop could end a frame on the over-budget side of a cycle and hold the drawn
 count above `foveationDrawBudget` indefinitely. `traverseFrontier` and
  `computeTouchedChunks` now handle a child range that straddles a chunk
  boundary: descent requires *every* spanned chunk resident (previously the
  uncached tail children were silently dropped, a coverage hole), and every
  missing spanned chunk is recorded as touched. Property tests cover budget
  convergence/re-convergence, selected-cut leaf coverage (exactly one
  ancestor-or-self per leaf, full and partial cache), pager plan minimality,
  and slab-apply atomicity.

- Pick dispose safety (E6): disposing a mesh while a pick's GPU readback is
  in flight now resolves that pick as a clean `null` miss even when the
  teardown makes the readback reject, instead of surfacing the rejection.
  Empty-pool, mid-stream-residency, transformed-ancestor and
  `orientation: 'source'` pick/query behavior is pinned by new streamed and
 unified test suites.

- WebGL2 streamed sort flicker (ROADMAP L5, logic-level): active-list
 mutations no longer patch identity values into a CPU-worker depth
 permutation (which drew removed splats and dropped live ones until the next
 worker order), partially activated page-table slabs (`activePrefix`, RAD)
 now sort and rebuild only their used prefix, a content swap under a
 stationary camera now forces a WebGL2 re-sort, and an applied worker order
 registers a full-buffer update range so pending narrow ranges cannot clip
 its upload. Deterministic race reproductions in
  `worker-sorter.races.test.ts`; visual confirmation in a browser still
  pending.

- `UnifiedSplatRenderer` no longer dispatches zero-splat gathers for empty
  sources (e.g. a streamed marker before its first chunk lands), and a
  modifier stack that throws while its gather pipeline rebuilds no longer
  leaves the source pointing at a disposed pipeline, the old gather survives
  and the rebuild retries on the next update.

- `ChunkLoader` now rejects a cancelled load immediately on abort instead of
  waiting for the worker's acknowledgement: a decode that finished before the
  worker saw the cancel can no longer resolve after abort, and progress
  callbacks stop at the abort. `StreamedSplatMesh` drops chunk results that
  resolve after `dispose()` (no cache repopulation or posts to a terminated
  frontier worker) and recognizes non-`DOMException` abort errors from
  `ChunkLoader.dispose`.

- Unnecessary TypeScript assertions that failed
  `@typescript-eslint/no-unnecessary-type-assertion` (unified harness/tests,
  compute sorter, work-buffer probe).

## [0.0.18]: 2026-07-20

### Changed

- **Format parsers moved to subpaths** (`@voluma/vlam/formats/rad`, `@voluma/vlam/formats/lcc`,
  `@voluma/vlam/formats/spz`, `@voluma/vlam/formats/splat`, `@voluma/vlam/formats/ksplat`). The main
  `@voluma/vlam` entry keeps the core renderer, `loadScene` / `StreamedSplatMesh`, and
  canonical SOG/PLY parsers. Direct decode of Spark `.rad`, XGRIDS LCC/LCC2
  helpers, and `.spz`/`.splat`/`.ksplat` must import the matching subpath.
  `loadScene` / `StreamedSplatMesh.load` still accept those formats without a
 subpath import, the library dynamic-imports format code on demand (frontier
 worker only for `.rad` pagetable).
- Experimental `sortStrategy: 'radix'` lazy-loads the radix sorter module.
- Format implementation files live under `src/lib/formats/<name>/` (internal
 layout only; public import paths unchanged).

## [0.0.17]: 2026-07-20

### Fixed

- **`UnifiedSplatRenderer` gather cache.** Skip-regather now requires the same
 source to have owned the same work-buffer offset/count in the previous prepared
 layout. Hide/show, priority eviction, and leading-source removal no longer
 reuse overwritten slices.

### Added

- **`supportsUnifiedSplatRenderer(renderer)`**: WebGPU backend gate for
 heterogeneous unified rendering. WebGL2 keeps standalone `SplatMesh` / static
  `SplatScene`.
- **`UnifiedSplatRenderer.capacity`**: read-only fixed work-buffer capacity so
  hosts can retain a renderer until sources outgrow it.
- **Drawable flag for modifier-hidden splats**: gather writes drawable into
  center.w; the draw material clips non-drawable entries. Slots stay in the
  sort range (no work-buffer compaction yet). Alpha-zero remains a secondary
  guard.

### Changed

- Last-source removal resets shared `maxStdDev` / `antialias` constraints so a
  differently configured set can be registered again.
- `dispose()` is idempotent; post-dispose `update` / `renderView` are no-ops;
  mutating APIs throw. Source visibility and unified picking restore exactly once.
- The unified mesh forces identity with `matrixAutoUpdate = false`.

## [0.0.9] – [0.0.16]: 2026-07-16 – 2026-07-20 · untagged development

Internal bumps **without git tags**. Highlights already in tree at `0.0.18`
(see also `docs/roadmap-history.md`):

### Added

- Multi-view rendering (`SplatMesh.renderView`, M10); depth-of-field preset (M13);
  CPU spatial queries (M9); `.rad` / `.radc` streaming + SH + blob cull +
  pagetable foveation (M14); streamed SOG shN via `shBands` (M11); `.lcc2`
  environment tile (M12); LCC (`.lcc`, v3–v5) streaming + packed SH; local folder drops
  (`StreamedSplatMesh.loadLocal`); collision mesh plumbing for `.lcc2`;
  mip-splatting antialias flag; device texture-size guard; demo pick + failure UX;
  `SplatScene` + `UnifiedSplatRenderer` (M15).

### Fixed

- `.rad` multi-band SH scramble / per-chunk range; LCC budget gaps; LCC
 environment SH "flashlight"; load-progress throttle; band-3 SH basis; silent
 streamed chunk failures.

### Verified

- WebGL2 fallback audit (M4.1); iPhone 15 Pro Safari WebGPU (M4.2 core).

## [0.0.8]: 2026-07-16

### Added

- Additional format parsers: `.spz` (Niantic), `.ksplat` (GaussianSplats3D),
 and the common `.splat`, all decoding to the shared `SplatData`.
- Structured loading errors: `SplatLoadError` with a load `phase`, HTTP status,
 and a `retryable` flag, surfaced through the loader and worker.
- `SplatMeshOptions`: `sortStrategy` (`counting` | `radix`),
  `performanceProfile` (`quality` | `smooth`), and a configurable sort interval.
- `StreamedSplatMesh.setBudget` to adjust the LOD budget at runtime, plus
  staged (region-atomic) LOD swaps.

## [0.0.1] – [0.0.7]: 2026-07-15 – 2026-07-16 · initial development

The foundational releases, developed rapidly over two days. Highlights:

### Added

- **WebGPU-first renderer** on three.js `WebGPURenderer` + TSL, with automatic
  WebGL2 fallback from one shader graph. EWA splatting (±3σ quads,
  `exp(-4.5·|q|²)` falloff), premultiplied-alpha blending.
- **GPU depth sorting**: a portable 6-pass compute counting sort (2²² buckets)
 on WebGPU; a CPU worker sort on WebGL2. Only the index buffer is rewritten.
- **Formats:** SOG v2 (palette-compressed shN, bands 1–3) and standard 3DGS PLY,
 loaded and decoded off the main thread.
- **LOD streaming** (`StreamedSplatMesh`) with a per-device splat budget:
 coarse-first, distance-driven refinement, region-atomic swaps; Streamed SOG
 (`lod-meta.json`) and XGRIDS `.lcc2` through one pipeline.
- **Effect hooks** (`M7`): the `SplatModifier` contract; per-splat channels with
 streamed persistence; the tree-shakeable `@voluma/vlam/effects` module
 (`sdfEffects`, `lightingPreset`, `revealPreset`).
- **GPU picking** (`M8`): `SplatMesh.pick(ndc, camera, renderer)`: asynchronous
 one-pixel depth pick returning a world-space center-plane hit.

[Unreleased]: https://github.com/Voluma-ai/vlam/commits/main
[0.0.18]: https://github.com/Voluma-ai/vlam/commits/main
[0.0.17]: https://github.com/Voluma-ai/vlam/commits/main
[0.0.8]: https://github.com/Voluma-ai/vlam/commits/main
