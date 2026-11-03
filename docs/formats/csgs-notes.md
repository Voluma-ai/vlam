# Faltwerk `.csgs` (CurveStream-GS) notes

Status: **proof of concept** (`@voluma/vlam/formats/csgs`, `@experimental`).
The decoder and frame evaluation are library code; playback is driven by the
host, as the dev harness does. Nothing in the default loaders or
`StreamedSplatMesh` knows the format yet.

Upstream: [Faltwerk](https://github.com/edrethardo/Faltwerk) (MIT, see
`THIRD_PARTY_NOTICES.md`), whose `docs/format-csgs.md` is the byte-level
specification. A public demo with four 64-frame clips lives at
[jameskane05/faltwerk-demo](https://github.com/jameskane05/faltwerk-demo); the
clips are third-party captures with no stated license; VLAM links them
(`CSGS_DEMO_SCENE` in `src/viewer/csgs-playback.ts`) rather than copying them.

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
(`csgs-decode-worker.ts`) that decodes every section once (0.4 to 0.8 s per
section of 60k to 110k splats on the demo clips), keeps the sections, and
evaluates frames on request (about 20 ms for 60k splats), one ahead of the
shown frame; the buffers travel back and forth by transfer, so steady playback
allocates nothing. The worker evaluates fixed slots, so `CsgsPlaybackMesh`
keeps one pool range for the current section and writes each frame in place:
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

Loading and the gated swap live in `src/viewer/csgs-playback.ts`
(`loadCsgsClip`, `CsgsPlaybackMesh`), shared by the harness and the demo
viewer's **Faltwerk 4DGS** effect (`/demo/?effects=4dgs`). The effect lives in
`src/viewer/csgs-effect.ts`, which `main.ts` loads with a dynamic `import()`:
it, the playback mesh and the frame evaluator form one lazy chunk (the viewer
build keeps `src/lib/formats/csgs/` out of its eager `vlam` chunk), so a
visitor who never picks the effect downloads none of it.

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

`src/viewer/csgs-gpu.ts` evaluates the curves in a `SplatModifier`, so a
section is uploaded once and a frame costs no CPU evaluation and no upload.
The worker packs a section (`csgs-gpu-layout.ts`): an RGBA16F knot texture
with one texel per knot and the opacity knots four per texel (~13 texels per
splat, 6 to 11 MB per demo section; clips whose knots exceed the half-float
range, as Faltwerk's synthetic stress streams do, stay on the worker path),
three float32 per-splat channels (first knot texel, the five knot counts
packed, birth and death frames packed), and a pool base with the centers on
the first position knot, identity covariance, a neutral color and the
section's SH. Two inactive marker splats at the corners of every position
knot's box keep the pool bounds, which the depth sort quantizes against,
around every pose. The modifier reads the time, the section start and span as
uniforms and outputs the offset to the curve position, the linear map
`M = R(t)·S(t)` (so `M·I·Mᵀ = R·S²·Rᵀ`), the DC color swapped in for the
neutral one, and the opacity masked by liveness (a float mask: `visible` and
`select` drop splats in a modifier graph).

Only `UnifiedSplatMesh` sorts on displaced centers, so GPU playback runs under
the unified draw: each clip is a source with `cacheModifiers: true`, and
`setTime` reports when the host must `invalidateSource` it (re-gather and
re-sort). Time is fractional, so clips interpolate at display rate. Without a
unified draw (WebGL2) the demo keeps the worker path above. The harness plays
it with `gpu=1`; `csgs-gpu-layout.test.ts` checks the packed layout against
`evaluateCsgsFrame` for every fixture splat at whole and half frames, and the
browser check compares `gpu=1` with the CPU path (same alive count, reference
difference within 1/255). Four clips in the demo: mean 17.4 ms, 95th
percentile 17.7 ms, unified CPU 0.3 ms median; the next section is staged
while the shown one plays (see the gaps below).

The clips are already Y-up (`orientation: 'source'`). Faltwerk's test cameras
are OpenCV world-to-camera poses; `cameraFromTestCamera` in the harness converts
one to a three.js camera. The reference strips (`synth/<clip>/<cam>.jpg`) hold
one 64×116 thumbnail per frame of that camera's view.

Known gaps of the proof of concept, in the order an MVP would address them:

- Dead splats keep their slots until the section ends, so they are drawn
  (as nothing) and sorted: 10 to 40 % more splats than alive, small next to a
  scene.
- Section data: the GPU mesh stages the next section into a second pool
  range and the other half of the knot texture while the shown one plays (a
  shared 4 MB per frame, knot rows copied through a staging texture) and
  switches both active prefixes and the uniforms in one frame, so switch
  frames no longer upload anything. Knots are half floats with opacity packed
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
- No timeline UI in the demo, no `scene.json` support in the loaders.
- Faltwerk's renderer adds gsplat's 0.3 px dilation without opacity
  compensation; VLAM's filters differ slightly, which a side-by-side at a
  native resolution would quantify.

## Verification

`parse-csgs.test.ts` decodes Faltwerk's synthetic version-1 fixtures and
compares every integer array with the Python reference decoder's dump, plus
float64 curve samples. `browser-tests/csgs-playback.spec.ts` plays the
clip linked from the faltwerk-demo site (`CSGS_DEMO_SCENE`), pinned to test
camera `c00`,
and composites the render over that camera's reference thumbnail: the mean
absolute difference over covered pixels is about 11/255 on both backends for
frames in both sections, against 15 for DC-only color and 54 for the wrong
pose. The check is skipped on CI and when the site is unreachable.
