# Animated SOG `.asog` notes

Status: **experimental library playback**. The decoder and CPU motion are
`@voluma/vlam/formats/asog` (worker-safe, no three.js); clip loading and
playback are `@voluma/vlam/dynamic` (`loadSplatClip`, `loadAsogClip`,
`SplatClipMesh`, all `@experimental`; see
[`docs/guide/dynamic-splats.md`](../guide/dynamic-splats.md)). The default
loaders and `StreamedSplatMesh` do not read the format.

Upstream: [arrival-space/animated-sog](https://github.com/arrival-space/animated-sog)
(MIT, see `THIRD_PARTY_NOTICES.md`). Its `docs/format.md` is the byte-level
specification of format v1, which is all VLAM reads. VLAM commits no captured
`.asog` clip: its tests and examples use synthetic clips, and the
measurements below were taken on a local copy of a real capture (400k
splats, SH degree 3, 6 s; a 1 s cut of it for the decoder comparison).

## What a file is

- One set of splats for the whole clip. The static attributes are SOG v2
  (16-bit log positions, smallest-three rotations, 256-entry codebooks, an SH
  palette), stored as zlib-compressed integer streams (byte planes, zigzag,
  delta).
- Per splat, a TRiGS rigid-body motion: centre time `μ`, temporal width `σ`,
  an anchor, a quadratic Bézier rotation twist `O0..O2` and a quartic
  translation term `G0..G4` (17 values). A splat is visible only within about
  `μ ± 2.45σ`, where its opacity is scaled by a Gaussian weight; static
  splats never move.
- Several clips can share one timeline, each with its own time offset,
  active range and smoothstep fades. VLAM supports them.
- An optional soundtrack. VLAM exposes it (`AsogClip.audio`: MIME type and
  bytes) but does not play it.
- Orientation: TRiGS/COLMAP, **y down**. A `SplatClipMesh` does not reorient
  clips; turn it 180° about X (`mesh.rotation.x = Math.PI`), the correction
  VLAM applies to SOG and PLY. The reference players turn 180° about Z, so
  the two face opposite ways.

## How VLAM plays it

- `loadAsogClip` (and `loadSplatClip` for an `.asog`) imports the loader, its
  decode worker and GPU driver on first use: a separate chunk of about 13 kB
  gzip, kept out of the `@voluma/vlam/dynamic` entry.

- `parseAsog` decodes the whole file. Unlike the reference decoder, which
  stores anchor, Ω and G as half floats for its textures, VLAM keeps the
  motion in float32 and computes `m_ref` from those float32 control points, as
  spec section 4.2 asks. On the 1 s capture, decoded centres agree with
  the reference to 9 µm at the median and 0.7 mm at the 99.9th percentile; the
  fastest splats differ by up to 1 cm, from the reference's half floats.
- **GPU path** (WebGPU): the canonical splats go into one pool range once,
  their motion into an RGBA32F texture (5 texels per splat). A
  `SplatModifier` evaluates centre, rotation and opacity weight per splat
  at a time uniform, with each clip's offset, active range and fades from a
  clip-table texture; a position-only twin feeds the GPU sort. Small rotation angles use Taylor series, since `(θ − sin θ)/θ³`
  cancels in float32. The float32 texel index limits the path to about
  3.35M splats, and the texture height (and the clip table's width, two
  texels per clip) to the device's `maxTextureDimension2D`. Both paths
  decide a clip's active range, a hard cut, on the float32 time the modifier
  compares against the float32 clip table, so they cut on the same frame.
- `parseAsog` refuses a manifest whose dequantisation would divide by zero
  (`mu.scale`, `motion.sm`, `motion.r_min`), non-numeric clip entries, and a
  stream shape its compressed bytes cannot inflate to (more than deflate's
  1032:1), before any allocation is sized by `count`.
- **Frame path** (WebGL2, a worker sorter, or a clip beyond those limits): the
  clip's worker evaluates every splat in its own slot and the SH is written
  once. Most splats are invisible at any one time: a splat outside its life
  window (`|t − μ| ≥ 2.45σ`) is rejected before any motion is evaluated, and
  only its opacity (0) is written, its slot keeping the pose it last had (or
  the canonical pose, which fresh buffers start in). The 6 s capture (400k
  splats, about 85k visible) evaluates in about 27 ms per frame on a desktop
  CPU (Node and Chrome alike), down from 54 ms writing every slot. Playing
  it in Chrome on an RTX 3090 desktop, with one worker, the
  clip advanced 29.8 of its 30 frames per second on the WebGPU GPU path,
  26.1 on the WebGPU frame path (GPU sort) and 19.7 on WebGL2 (frame path and
  CPU worker sort), the page rendering at 56, 60 and 38 fps: one worker at
  27 to 30 ms per frame plus the transfer leaves little margin under 33 ms,
  and WebGL2 adds its CPU sort of 400k splats.
- The frame path now evaluates with two workers. The second decodes its own
  copy of the clip (about 75 MB more for the 6 s capture, and a second decode
  alongside playback) and starts only when the frame path asks for its first
  frame, so the GPU path never pays for it; `clip.frame()` snapshots use the
  first. A second evaluation starts whenever the first is still running when
  the next frame is due. With two workers the 6 s capture advances 29.6 of its
  30 frames per second on the WebGPU frame path (page at 60 fps) and 29.9 on
  WebGL2 (page at 41 fps), the same machine as above.
- `bounds` covers every visible centre (each dynamic splat sampled at 33
  times across its life, padded by 1 %), because it becomes the mesh's
  `displacementBounds`. The reference's `centerBounds` is a 2–98 % box and is
  not used.
- SH is evaluated with the view direction to the splat's canonical centre on
  the GPU path, and to its moved centre on the frame path and in the
  reference player. Neither rotates SH with the motion, so the difference is
  only the direction's shift with the splat's displacement.

## Verification

- `parse-asog.test.ts` checks the port against a vendored, unmodified copy of
  the reference decoder (`src/lib/__tests__/fixtures/animated-sog/`) on
  synthetic files written by `src/tools/asog/encode-asog.ts`. Set
  `VLAM_ASOG_SAMPLE=<path to an .asog>` to run the same comparison on a real
  clip.
- `asog-clip.test.ts` runs the clip worker in-process: format dispatch,
  snapshots, and path planning.
- `browser-tests/asog-playback.spec.ts` plays a synthetic clip at four
  frames on both backends, and on WebGPU holds the GPU path against the frame
  path (mean thumbnail difference below 0.5/255; measured 0.05 to 0.08). On a
  native adapter (`npm run test:browser:hardware`) it also holds a
  `UnifiedSplatMesh` source against the standalone GPU path (measured below
  0.0002/255 on an RTX 3090); CI's SwiftShader run leaves that pass out for
  time.
- `/asog-harness.html?src=<url>` plays any clip on the dev server
  (`playback=`, `frame=`, `orbit=`, `flip=0`, `sh=0`, `sort=exact`). The 6 s
  capture in Chrome on an RTX 3090: decoded in 1.5 s;
  GPU vs frame path at frames 30, 90, 150 and 179 at most 2/255 on any
  96 × 96 thumbnail pixel (one pixel above 1/255), mean 0.01/255, identical
  visible-splat counts. The SH view-direction difference above does not
  show at this scale. WebGL2 plays the frame path.
- A measuring host must wait for the sort after a time change on the GPU
  path: a still camera re-sorts at the sort cadence, not at once (the
  harness waits for the sort to cover the current displacement). Measured
  before that sort, a frame differs by up to 15/255 in colour where splats
  cross in depth.
- The demo's `?effects=4dgs&clips=<url.asog>` with Tempel: on WebGPU one
  `UnifiedSplatMesh` draws the scene and the clip (GPU path), depth-sorted
  together; on WebGL2 one `PooledUnifiedSplatMesh` draws both, the clip on
  the frame path. Checked by eye in Chrome.
- Not yet checked: a side-by-side with the reference players.
