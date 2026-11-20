# Faltwerk `.csgs` (CurveStream-GS) notes

Status: **experimental library playback**. The decoder and CPU frame
evaluation are `@voluma/vlam/formats/csgs` (worker-safe, no three.js); clip
loading and playback are `@voluma/vlam/dynamic` (`loadCsgsClip`,
`SplatClipMesh`, both `@experimental`; see
[`docs/guide/dynamic-splats.md`](../guide/dynamic-splats.md)). Nothing in the
default loaders or `StreamedSplatMesh` knows the format yet.

Upstream: [Faltwerk](https://github.com/edrethardo/Faltwerk) (MIT, see
`THIRD_PARTY_NOTICES.md`), whose `docs/format-csgs.md` is the byte-level
specification. A public demo with four 64-frame clips lives at
[jameskane05/faltwerk-demo](https://github.com/jameskane05/faltwerk-demo); the
clips are third-party captures with no stated license; VLAM links them
(`CSGS_DEMO_SCENE` in `src/viewer/csgs-demo.ts`) rather than copying them.

## What a stream is

- A sequence of **sections** of `nframes` frames (32 in every known stream).
  A section is **keyed** (self-contained) or a **delta** that continues the
  splats the previous section left alive, so decoding starts at a key section
  and `CsgsDecoder` carries the state across sections.
- Per splat and section: birth and death frames, one piecewise-linear
  ("hat") curve per attribute group with 1 to `max(ks)` knots (the demo clips
  use 1, 2, 3 or 5), and 45 static higher-order SH scalars (degree 3,
  coefficient-major RGB triples). Groups, in coding order: `P` position (3),
  `R` quaternion `wxyz` (4), `S` log-scale (3), `O` opacity logit (1), `D` SH
  DC color (3). These are gsplat conventions, so `color = 0.5 + C0·D`,
  `opacity = sigmoid(O)`, `scale = exp(S)`, and the quaternion is normalized
  after interpolation.
- All knot and SH values are integers on a per-section quantization table
  (`offsets` and `scales` in the header). The decoder keeps them as integers,
  which is what the bit-exact fixture tests compare; `prepareCsgsSection`
  dequantizes.
- Entropy coding is rANS with adaptive models, one stream per attribute, each
  consumed exactly; a CRC-32 trails the section.

## Version-1 only

`parseCsgsHeader` rejects container versions 2 to 6 and their flags (SH
codebooks, motion prediction, follow masks, per-section requantization,
B-spline knots). The public demo clips are version 1 with the key and
shared-knot flags only.

## Playback through VLAM

`evaluateCsgsFrame` writes only the splats alive at the frame, so the count
varies per frame, and reuses caller-owned buffers; with `allSlots` it writes
every splat of the section at its own index instead, the dead ones with zero
opacity and covariance. Each clip gets a worker
(`src/lib/dynamic/csgs-decode-worker.ts`, inlined into the `/dynamic` entry)
that decodes every section once (0.4 to 0.8 s per
section of 60k to 110k splats on the demo clips), keeps the sections, and
evaluates frames on request (about 20 ms for 60k splats), one ahead of the
shown frame; the buffers travel back and forth by transfer, so steady playback
allocates nothing. The worker evaluates fixed slots, so the frame path of
`SplatClipMesh` keeps one pool range for the current section and writes each frame in place:
within a section through `SplatMesh.overwriteRangeCore` (center, color and
covariance only, about 2 to 3 ms, 52 B per splat to upload), the static
higher-order SH (another 64 B per splat) only when the section changes, with
`overwriteRangeData` and a new active prefix. The worker copies the section's
SH into a reply only for that first frame. One packed-SH range is chosen
for the whole stream so the pool never requantizes a later section. A swap
waits while the previous frame's GPU sort is in flight: the mesh keeps drawing
that sort's order until it lands, and the swap rewrites the pool rows that
order indexes, so swapping anyway shows one frame of new splats in the old
order (an unsorted flash). The status line counts these held swaps.

The frame path plays WebGL2 and clips the GPU path cannot hold. It prefetches
one frame in the direction of play; a late frame still shows while time
advances (up to 8 frames behind), and a jump or a reversal discards the
stale one.

The harness and the demo viewer's **4DGS clips** effect (which also plays `.asog` clips given by `?clips=`)
(`/demo/?effects=4dgs`) both run on the public API. The effect lives in
`src/viewer/csgs-effect.ts`, which `main.ts` loads with a dynamic `import()`:
it and `@voluma/vlam/dynamic` form one lazy chunk (the viewer build keeps
`src/lib/formats/csgs/` and `src/lib/dynamic/` out of its eager `vlam` chunk),
so a visitor who never picks the effect downloads none of it. Each clip has
its own `AnimationMixer`; all share one `SplatClipStagingBudget`.

By default it plays all four clips linked from the public faltwerk-demo GitHub
Pages site, which serves them with CORS `*` (the clips are linked, not copied,
until their authors grant permission); `?csgs=<scene_*.json>[,…]` plays others.
The clips stand in a 0.8 m circle a little above the floor of the Tempel
courtyard (`CSGS_PLACEMENTS` in `csgs-effect.ts`), or at the center of an
unknown scene, facing outward with the first toward the camera, under a credit
banner. On WebGPU the scene and the clips draw through one `UnifiedSplatMesh`,
so the dancers are depth-sorted with the scene's splats and each other; WebGL2
layers them over the scene. Measured on an M-series Mac at the courtyard
view (mean / 95th percentile frame): the scene alone and four clips frozen
16.7 / 17.6 ms; one clip playing 16.7–17.3 / 17.6 ms; four clips playing
18–19.6 / 33 ms, with large run-to-run variance on a fanless laptop. Two
limits remain with four clips, both CPU-side. Uploads: four clips at 29 fps
push ~500 MB/s through the browser's texture-upload path, which then blocks one
`update` for 10 to 25 ms (most 3 to 6 MB uploads take under 1 ms; the one that
hits the backpressure stalls); capping swaps per frame did not help, since it
spreads the same bytes. Evaluation: four workers at once take 56 to 97 ms per
frame each (one alone ~17 ms), so the clips play at 6 to 16 fps. Only 0 to 10 %
of a section's splats are static for the whole section, so a static/dynamic
slot split saves little. GPU evaluation (below) removes both, and the demo
uses it wherever the unified draw runs.

### GPU evaluation

The `.csgs` GPU driver of `SplatClipMesh` (`src/lib/dynamic/csgs-gpu-playback.ts`,
modifiers in `csgs-curve-modifier.ts`) evaluates the curves in a `SplatModifier`, so a section is uploaded once and a
frame costs no CPU evaluation and no upload. The worker packs a section
(`src/lib/formats/csgs/csgs-gpu-layout.ts`, internal): an RGBA16F knot
texture with one texel per knot and the opacity knots four per texel (~13
texels per splat, 6 to 11 MB per demo section), three float32 per-splat
channels (first knot texel, the five knot counts packed, birth and death
frames packed), and a pool base with the centers on the first position knot,
identity covariance, a neutral color and the section's SH.

Two choices keep the half floats and the packed life exact enough for long
clips far from the origin:

- **Position knots are deltas** from the splat's first knot, which the pool
  center holds in float32, so their precision follows the motion within a
  section (a few centimetres: steps far below a millimetre) instead of the
  distance from the clip's origin (absolute half floats step by ~8 mm at 8
  to 16 m). The section's bounds keep absolute positions.
- **Birth and death are section-relative** (`frame − g0`, clamped to
  `[0, nframes]`), and the modifier reads one section-local time uniform
  computed in double precision on the CPU, so the 4096 radix limits a section
  (32 frames in every known stream), not the clip, to 4095 frames.

A clip plays on the GPU path when every section passes `csgsGpuHalfSafe`
(each stored knot, positions as deltas, fits a half float). Measured on the
fixtures: `synth_res_s0000` and `synth_shared_s0000` still fail (8 position
knots each, also as deltas, up to ~3e7), the other three sections pass, so
neither synthetic stream is GPU-eligible and both play on the frame path. The
browser check's GPU fixture is a procedural clip instead
(`src/viewer/csgs-procedural.ts`). The worker reports each section's box of
absolute position knots (the hat curves interpolate between knots, so every
pose stays inside it), and the mesh declares the clip's union of them as its
`displacementBounds`, which the depth sort quantizes against. The modifier reads the section-local time and span as
uniforms and outputs the offset (the delta curve), the linear map
`M = R(t)·S(t)` (so `M·I·Mᵀ = R·S²·Rᵀ`), the DC color swapped in for the
neutral one, and the opacity masked by liveness (a float mask: `visible` and
`select` drop splats in a modifier graph).

A standalone WebGPU mesh sorts on the displaced centers too: the mesh lists a
position-only copy of the modifier (2 texture and 2 channel reads per splat
instead of 10 and 3) in `SplatMesh.sortDisplacement` and calls
`invalidateSortDisplacement()` whenever the shown time or section changes, so
a stationary camera re-sorts at the sort cadence. Under a `UnifiedSplatMesh`
the list is ignored but the revision is honoured, and the clips are registered
with default options (`cacheModifiers: false`, re-gathered every frame), so
the host calls nothing. Time is fractional, so clips interpolate at display
rate. The WebGL2 worker sorter sorts CPU centers, so WebGL2 keeps the frame
path above (`src/lib/dynamic/frame-playback.ts`, shared by every clip format).

Sections live in N resident slots (pool ranges plus parts of the knot
texture; `residentSections`, default every section while they stay under
256 MB, clamped to `maxTextureDimension2D` and to the 8192 knot rows a float32
knot index addresses exactly). Staging targets, in order: the
section `time` wants when it is not shown, then the next sections in the
direction time last moved; a slot is claimed free first, then one still
staging (a superseded jump), then the resident section farthest ahead in the
direction of play, which is the one just left behind. Playing into a section
that is not staged yet holds the shown one at its edge; any other jump holds
the drawn frame. Nothing is staged whole except the very first section.

`csgs-gpu-layout.test.ts` checks the packed layout against
`evaluateCsgsFrame` for every fixture splat at whole and half frames, a
section past frame 4095 and a clip 10 m from the origin;
`splat-clip-mesh.test.ts` covers path selection, the mixer transport,
seeking, reverse play, eviction, superseded jumps and disposal; the browser
checks compare the GPU path with the frame path (same alive count, reference
difference within 1/255). Four clips in the demo: mean 17.4 ms, 95th
percentile 17.7 ms, unified CPU 0.3 ms median; the next section is staged
while the shown one plays (see the gaps below).

The clips are already Y-up, and a dynamic-capacity `SplatClipMesh` applies
no upright correction. Faltwerk's test cameras
are OpenCV world-to-camera poses; `cameraFromTestCamera` in the harness converts
one to a three.js camera. The reference strips (`synth/<clip>/<cam>.jpg`) hold
one 64×116 thumbnail per frame of that camera's view.

Known gaps of the proof of concept, in the order an MVP would address them:

- Dead splats keep their slots until the section ends, so they are drawn
  (as nothing) and sorted: 10 to 40 % more splats than alive, small next to a
  scene.
- Section data: the GPU path stages upcoming sections into free resident
  slots while the shown one plays (a shared 4 MB per frame, knot rows copied
  through a staging texture) and switches both active prefixes and the
  uniforms in one frame, so switch frames upload nothing. Knots are half floats with opacity packed
  four per texel, so a demo section is 12.6 to 24 MB (was 24 to 39 MB) and
  staging occupies 32 % of frames (was 45 %). Staging frames still stall the
  browser's upload path now and then (`stage` and the unified update reach
  ~25 ms at the 95th percentile), independent of the chunk size (1.5 to 4 MB
  per frame made no difference); on the fanless test machine the frame-time
  effect is within run-to-run noise. Left to try: writing only positions and
  SH of the pool base (its colors and covariances never change, ~4 MB of a
  large section) and uploading through mapped staging buffers instead of
  `writeTexture`.
- Sections are fetched and decoded up front; a stream needs lookahead and
  region-atomic section swaps.
- The public demo (`?effects=4dgs`) still links the unlicensed Faltwerk
  clips; the goose clip could replace them there.
- No timeline UI in the demo (the harness has a minimal transport), no
  `scene.json` support in the loaders.
- GPU curves on WebGL2: the worker sorter sorts CPU centers. A cheaper step
  worth a look: evaluate only the position curve on the CPU for the sort and
  leave the rest to the vertex-stage modifier.
- Faltwerk's renderer adds gsplat's 0.3 px dilation without opacity
  compensation; VLAM's filters differ slightly, which a side-by-side at a
  native resolution would quantify.

## VLAM's own clip and the encoder

`assets/goose-walk/` is a clip VLAM may ship: the pixel-art goose
(`assets/goose.sog`, 149,120 splats) walking in place and honking, 64 frames
at 32 fps in a two-second loop, one keyed section (1.7 MB) and three delta
sections (~0.5 MB each). `scripts/generate-goose-clip.mjs` regenerates it
(`--preview <dir>` also writes a strip of frames); the animation is in
`src/tools/csgs/goose-walk.ts`: parts cut by position on the sprite's pixel
grid (two feet, body, a smooth blend up the neck to the head, the lower
mandible), each with a small analytic motion sampled at 7 knots per section.
It is GPU-eligible, so it is also a real-container clip for the GPU path.

`src/tools/csgs/encode-csgs.ts` is the version-1 **encoder** it uses, a
dev tool that mirrors the decoder stream by stream; re-encoding Faltwerk's
fixture sections reproduces them byte for byte (`encode-csgs.test.ts`). Two
things decide a clip's size. Knot differences of 16 or more leave the
adaptive models for raw escape bits, so the position grid is 1 mm and one
knot interval moves a part by a few steps at most. And a difference shared
by a whole part still costs about 2 bits per splat and knot, because it
changes from knot to knot, while zero is nearly free: the body only dips
vertically, on 3 knots.

A section's last frame (`nframes − 1`) holds until the next section's first:
fractional times past it clamp to the last knot. The goose's knots sample
the true frame times, so integer-frame playback is exact and the GPU path
holds for less than one frame at each boundary.

## Verification

`parse-csgs.test.ts` decodes Faltwerk's synthetic version-1 fixtures and
compares every integer array with the Python reference decoder's dump, plus
float64 curve samples. `browser-tests/csgs-playback.spec.ts` plays the
clip linked from the faltwerk-demo site (`CSGS_DEMO_SCENE`), pinned to test
camera `c00`,
and composites the render over that camera's reference thumbnail: the mean
absolute difference over covered pixels is about 11/255 on both backends for
frames in both sections, against 15 for DC-only color and 54 for the wrong
pose. The GPU path, standalone and unified, stays within 0.1 of the frame
path (measured 11.03 against 11.00 at frame 0, 10.83 against 10.93 at frame
48, SwiftShader WebGPU). The check is skipped on CI and when the site is
unreachable. `browser-tests/splat-clip-mesh.spec.ts` needs no network and
runs on CI: the procedural clip on the GPU path against the frame path (mean
thumbnail difference ~0.05/255 at frames inside and just after each section
boundary), unified against standalone, reverse against forward playback,
disposal while a section stages, and `synth_shared` (through
`src/lib/__tests__/fixtures/csgs/synth_shared.scene.json`) falling back to the
frame path on both backends.
