# Faltwerk `.csgs` (CurveStream-GS) notes

Status: **proof of concept** (`@voluma/vlam/formats/csgs`, `@experimental`).
The decoder and frame evaluation are library code; playback is driven by the
host, as the dev harness does. Nothing in the default loaders or
`StreamedSplatMesh` knows the format yet.

Upstream: [Faltwerk](https://github.com/edrethardo/Faltwerk) (MIT, see
`THIRD_PARTY_NOTICES.md`), whose `docs/format-csgs.md` is the byte-level
specification. A public demo with four 64-frame clips lives at
[jameskane05/faltwerk-demo](https://github.com/jameskane05/faltwerk-demo); the
clips are third-party captures with no stated license and are not
redistributed here.

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
varies per frame, and reuses caller-owned buffers. The harness
(`src/viewer/csgs-harness.ts`) decodes every section once in a worker
(`csgs-decode-worker.ts`, 0.4 to 0.8 s per section of 60k to 110k splats on
the demo clips), evaluates the displayed frame on the main thread (about 25 ms
for 50k splats), and swaps the whole set into a dynamic-capacity `SplatMesh`
with `removeRange` + `appendRange` (about 12 ms). One packed-SH range is chosen
for the whole stream so the pool never requantizes a later section.

The clips are already Y-up (`orientation: 'source'`). Faltwerk's test cameras
are OpenCV world-to-camera poses; `cameraFromTestCamera` in the harness converts
one to a three.js camera. The reference strips (`synth/<clip>/<cam>.jpg`) hold
one 64×116 thumbnail per frame of that camera's view.

Known gaps of the proof of concept, in the order an MVP would address them:

- Curves are evaluated on the CPU and re-uploaded every frame. A
  `SplatModifier` reading knots from a per-section data texture would move the
  evaluation to the GPU on both backends; the covariance can be expressed
  through the modifier's linear `rotation` output as `R(t)·S(t)·S0⁻¹·R0ᵀ`.
- Sections are fetched and decoded up front; a stream needs lookahead and
  region-atomic section swaps.
- No timeline UI in the demo, no `scene.json` support in the loaders.
- Faltwerk's renderer adds gsplat's 0.3 px dilation without opacity
  compensation; VLAM's filters differ slightly, which a side-by-side at a
  native resolution would quantify.

## Verification

`parse-csgs.test.ts` decodes Faltwerk's synthetic version-1 fixtures and
compares every integer array with the Python reference decoder's dump, plus
float64 curve samples. `browser-tests/csgs-playback.spec.ts` plays a local
clip (`assets/csgs-demo/`, gitignored; copy the demo repository's
`scene_*.json`, `james/` and `synth/` there) pinned to test camera `c00`,
and composites the render over that camera's reference thumbnail: the mean
absolute difference over covered pixels is about 11/255 on both backends for
frames in both sections, against 15 for DC-only color and 54 for the wrong
pose. The check is skipped when the clips are absent.
