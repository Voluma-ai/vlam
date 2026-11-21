# Dynamic splats

> **Experimental.** `@voluma/vlam/dynamic` is outside the 1.x compatibility
> guarantee and may change in a minor release.

There is no standard file format for animated Gaussian splats yet, so VLAM's
API is shaped by what an app does with them, not by a format. Everything is
driven by a three.js `AnimationMixer`, the way a glTF animation is:

| The app has… | It uses… | What moves |
|---|---|---|
| a captured 4D clip, in any format VLAM reads | `loadSplatClip(url)` → `SplatClipMesh` | `mesh.time` (seconds) |
| a static splat and a skeleton | `SkinnedSplatMesh.bind(skeleton)` | the bones: glTF clips, cross-fades, IK, code |
| a rigged splat in a glTF (`KHR_gaussian_splatting` with a skin) | `loadSplatGltf(url)` | the bones, by the file's own clips |
| rigid parts only (a vehicle's wheels, doors) | `MergedSplatMesh`, one source per part | one matrix per part |
| its own deformation | a `SplatModifier` + `sortDisplacement` + `displacementBounds` | its own uniforms |

## Captured 4D clips

A 4D clip is a capture that moves: every splat follows its own path over the
clip's frames. `loadSplatClip` loads one in any format VLAM reads and returns
a `SplatClip`; `SplatClipMesh` plays any `SplatClip`.

```ts
import * as THREE from 'three/webgpu';
import { loadSplatClip, SplatClipMesh } from '@voluma/vlam/dynamic';

await renderer.init(); // the mesh picks its playback path from the backend
const clip = await loadSplatClip(url, { onProgress: ({ message }) => console.log(message) });
const mesh = new SplatClipMesh(clip, { renderer }); // SH bands come from the clip
scene.add(mesh);

const mixer = new THREE.AnimationMixer(mesh);
const action = mixer.clipAction(mesh.animation); // one track on `.time`
action.play();

const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
  timer.update();
  mixer.update(timer.getDelta());
  mesh.update(camera, renderer); // shows `time`'s frame, uploads what comes next
  renderer.render(scene, camera);
});
```

`renderer` is required: the playback path and the pool capacity are fixed in
the constructor. A host that does not want a mixer sets `mesh.time` itself.

### Formats

`loadSplatClip` takes the format from `format`, or else from the URL:

| Format | Given by | Notes |
|---|---|---|
| `'csgs'` | a [Faltwerk](https://github.com/edrethardo/Faltwerk) `scene_*.json`, with its `.csgs` sections beside it | Version-1 containers. Also loadable with `loadCsgsClip`, which returns the `.csgs` details (`scene`, `sections`). Format notes: [`docs/formats/csgs-notes.md`](../formats/csgs-notes.md) |
| `'asog'` | an [Animated SOG](https://github.com/arrival-space/animated-sog) `.asog` file | Format v1, multi-clip timelines included. Also loadable with `loadAsogClip`, which returns the soundtrack (`audio`; the library does not play it, the example does) and `clipCount`. The clip is y down: set `mesh.rotation.x = Math.PI` to stand it up. Format notes: [`docs/formats/asog-notes.md`](../formats/asog-notes.md) |

Anything else is rejected with an error that lists the supported formats.
`SPLAT_CLIP_FORMATS` lists them in code. A new format arrives as one more
entry there; the app's `loadSplatClip` call and the `SplatClip` it gets back
stay the same.

An app can also play a format VLAM does not read by implementing `SplatClip`
itself: the metadata (`fps`, `totalFrames`, `maxCount`, `bounds`, `shBands`)
and `frame(index)`, which returns that frame's `SplatData`. Such a clip plays
on the frame path.

### Play, pause, scrub, stop

Everything comes from the `AnimationAction`:

```ts
action.paused = true; // pause
action.time = 1.2; // scrub, in seconds
action.timeScale = 0.5; // slow motion; negative plays backwards
action.setLoop(THREE.LoopPingPong, Infinity);
action.stop(); // back to the start
```

Playing and scrubbing are one code path. Whatever sets `time`, `update` shows
that frame as soon as it is available and holds the last drawn frame until
then; a newer jump supersedes an older one. `time === duration` (a clamped
`LoopOnce`) shows the last frame, and `mesh.frame` gives the fractional frame.
`mesh.whenShown()` resolves once the drawn content is exactly `time`'s frame,
for captures and thumbnails, and rejects if that frame failed. Failures fire
an `error` event; with no listener they are logged to the console.

`clip.frame(index)` returns a frame as plain `SplatData` (alive splats only),
for placement (`splatFrameBounds`), thumbnails and export.

Two captured clips are different sets of splats, so `crossFadeTo` and action
weights do not blend them. A transition is an opacity fade between two meshes.
Blending is what rigged splats are for.

### Playback paths

`playback: 'auto'` (the default) decides in the constructor; `'gpu'` throws
where the GPU path is not possible, and `'frames'` always plays frames.
`mesh.playback` reports the choice as `'gpu'` or `'frames'`:

| | A format's GPU path | The frame path |
|---|---|---|
| When | the format has one and the device can hold it (`.csgs`: WebGPU, every section `gpuEligible`, the knot texture fits; `.asog`: WebGPU, the motion texture fits) | WebGL2, a worker sorter, a format without a GPU path, a clip the GPU path cannot hold |
| Per frame | a `SplatModifier` evaluates the motion at a time uniform; nothing is uploaded | the clip evaluates the frame (in its worker), the mesh writes it into its pool |
| Sorting | the standalone WebGPU sort folds a position-only modifier (`sortDisplacement`) | CPU centers, any sorter |
| Fractional time | interpolates between frames | floors to a frame |

For `.csgs`, `gpuEligible` means every stored knot fits a half float
(positions are stored relative to each splat's first knot, so this is about
motion within a section, not distance from the origin), and no curve has more
than 7 knots. Captures pass; Faltwerk's synthetic stress streams do not.

`residentSections: 'all'` makes scrubbing free at the cost of memory; the
default keeps every section on the GPU while their packed data stays under
256 MB, else 2 (shown + next). It is lowered to what the device's
`maxTextureDimension2D` allows, and to 8192 knot-texture rows (about 134 MB of
knots) on any device, so every knot index stays exact in float32.

### With a captured scene: the unified draw

On WebGPU, register the clips as `UnifiedSplatMesh` sources next to the
capture, so the dancers sort with the scene's splats and with each other.
Register them with the default options: the unified draw re-gathers them every
frame and re-sorts when a clip's time moves, so the host calls nothing else.
The unified draw calls each source's `update`, which is where the clip shows
its frame.

Several clips share one `SplatClipStagingBudget`, so sections that end
together do not burst the upload path in the same frame. The budget serves
each frame's bytes round-robin, starting with a different clip every frame.

The full setup is [`samples/dynamic-splats.ts`](samples/dynamic-splats.ts).

## Rigged splats

A `SkinnedSplatMesh` is the splat counterpart of `THREE.SkinnedMesh`: a static
splat whose splats follow the bones of a `THREE.Skeleton`. Whatever moves the
bones moves the splats, so humanoids, birds, fish and machines all work the
same way, and glTF clips, `crossFadeTo`, action weights, additive clips and
IK all apply.

```ts
import { SkinnedSplatMesh, computeSplatSkinWeights } from '@voluma/vlam/dynamic';

// The rig: a glTF with a low-poly SkinnedMesh in the splat's frame, and its clips.
const proxy = gltf.scene.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
proxy.visible = false;
const mesh = new SkinnedSplatMesh(splats, {
  skin: computeSplatSkinWeights(splats, proxy, { bonesPerSplat: 2 }),
});
proxy.add(mesh); // the proxy's frame is the bind space
mesh.bind(proxy.skeleton, proxy.bindMatrix);
scene.add(gltf.scene);

const mixer = new THREE.AnimationMixer(gltf.scene);
mixer.clipAction(gltf.animations[0]).play();
// Per frame: mixer.update(dt); mesh.update(camera, renderer); renderer.render(…).
```

The **skin** is up to four bone indices and weights per splat
(`SplatSkinData`, `bonesPerSplat: 1 | 2 | 4`). Take it from a rigged proxy
with `computeSplatSkinWeights` (each splat takes the nearest proxy vertex's
weights; pass `splatToProxy` when the splat and the proxy were not made in
the same frame), or compute it yourself from where the splats sit. Both are
in [`samples/rigged-splats.ts`](samples/rigged-splats.ts), the second with a
skeleton and a clip built in code.

**Binding** works like `SkinnedMesh.bind`: with no bind matrix the current
pose becomes the bind pose; `bindMode` is `'attached'` (default) or
`'detached'`. The splats' local space is the bind space, and the data keeps
its own axes (no upright correction), so build the skeleton in those axes and
turn the mesh as a whole. Bones whose matrices you set by hand
(`matrixAutoUpdate = false`) need `matrixWorldNeedsUpdate = true`, as
everywhere in three.js.

Each `update` writes one 3×4 matrix per bone into a small float texture, and a
modifier moves each splat's center and shape by its blended bone matrices.
`mesh.skinModifier` is first on `mesh.modifiers`; stack your own after it
(lighting, a tint), and `ctx.rotation` and `ctx.localCenter + ctx.offset` give
them the skin's linear part and the posed center. `posedSplatData()` returns
the posed splats on the CPU, matching the GPU, for picking and queries.

The skin is cheap: on an RTX 3090, 2 million splats at 1600×900 draw in the
same 7.3–7.4 ms GPU render time with 0, 1, 2 or 4 bones per splat, and four
bones add under 0.1 ms to the per-frame sort (`src/viewer/skinned-splat-bench.html`;
phones and integrated GPUs are not measured yet).

The sort bounds follow the pose: when a limb or root motion leaves
`displacementBounds`, the mesh grows them along the motion, and it shrinks
them back once they are far larger than the pose needs, so the sort keeps its
depth precision. A box you set yourself is a floor: grown when needed, never
shrunk.

### From a glTF file

`loadSplatGltf` loads Gaussian splats from a glTF (`.glb` or `.gltf`) under
the ratified `KHR_gaussian_splatting` extension: each splat primitive (mode
`POINTS`) becomes a `SplatMesh` in its place in the glTF's scene. The
extension says nothing about skinning, so a rigged splat carries the skin a
triangle mesh would: `JOINTS_0` and `WEIGHTS_0` on the primitive and a glTF
skin on its node. Such a primitive becomes a `SkinnedSplatMesh` bound to that
skeleton the way `GLTFLoader` binds a `SkinnedMesh`, so the file's animations
under an `AnimationMixer` move the splats, and any glTF tool sees the same
skeleton and clips.

```ts
import { loadSplatGltf } from '@voluma/vlam/dynamic';

const model = await loadSplatGltf('/goose.glb');
scene.add(model.scene);
const mixer = new THREE.AnimationMixer(model.scene);
mixer.clipAction(THREE.AnimationClip.findByName(model.animations, 'idle')!).play();
// Per frame: mixer.update(dt); for (const mesh of model.meshes) mesh.update(camera, renderer).
```

The full setup, with the clip hints below, is
[`samples/splat-gltf.ts`](samples/splat-gltf.ts).

- **Source.** A URL, the file's bytes, or a glTF your own `GLTFLoader`
  already parsed (with its `LoadingManager` or meshopt decoder), whose scene
  is then changed in place; `options.loader` passes a configured loader for
  the other two. When the loader parses the file itself, a file that lists
  the extension in `extensionsRequired` loads too.
- **Splats.** `POSITION`, and the extension's `ROTATION` (xyzw), `SCALE`
  (linear), `OPACITY` and `SH_DEGREE_0_COEF_0`, in any component type the
  extension allows. `lin_rec709_display` colors are converted to sRGB;
  without SH, `COLOR_0` gives the color. The splats keep the file's axes
  (glTF is Y-up), so `orientation` defaults to `'source'`; the other mesh
  options apply to every splat mesh.
- **Skin.** As many bones per splat as the file uses (1, 2 or 4). Pass
  `skinning: false` to load skinned primitives as plain `SplatMesh`es in the
  bind pose, for a draw that cannot run the skin modifier (the pooled
  WebGL2 unified draw).
- **Clips.** `model.animations` are the file's clips. A clip may say how it
  is meant to be played in its glTF `extras.vlam`, kept on
  `clip.userData.vlam` (`SplatGltfClipHints`): `loop` (`'repeat'` or
  `'once'`), `repetitions`, and `additive`. A clip flagged additive is
  stored with absolute poses and the loader makes it additive
  (`AnimationUtils.makeClipAdditive`, from its first frame), so it layers
  on top of the others; a plain glTF player ignores the hints.

A file can store its splats compressed under `EXT_meshopt_compression`,
often a fifth of the size. The accessors are the same, so `loadSplatGltf`
reads it once its loader has a meshopt decoder:

```ts
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const model = await loadSplatGltf(url, {
  loader: new GLTFLoader().setMeshoptDecoder(MeshoptDecoder),
});
```

On the dev server, `/splat-gltf-harness.html?url=<glb>` plays a splat glTF,
compressed or not, with a clip picker and a scrub bar.

## Displaced splats and their bounds

The sort quantizes depth over the mesh bounds, and a splat a modifier carries
outside them clamps to the nearest or farthest key. A modifier that moves
splats away from where they were written declares how far with
`mesh.displacementBounds` (a mesh-local `Box3`), next to the position-only
stand-in in `sortDisplacement`. `SplatClipMesh` sets it from the clip's
`bounds`; `SkinnedSplatMesh` keeps it around the pose.

## WebGL2

WebGL2 plays clips on the frame path: the worker evaluates each frame (about
20 ms per 60k `.csgs` splats) and the mesh swaps it in after the previous
frame's sort has landed, so one clip plays in real time and several stutter.
A `SkinnedSplatMesh` draws skinned on WebGL2, but the worker sorter sorts
the bind-pose centers.

## Known limits

- `.csgs`: every section is fetched and decoded up front (fine for 64-frame
  clips, not for long ones); dead splats keep their slot until their section
  ends (10 to 40 % more splats drawn and sorted); version-1 containers only.
- The `.csgs` GPU path needs half-float knots (`gpuEligible`), at most 7 knots
  per curve and at most 4095 frames per section. Clips beyond any of these
  play on the frame path.
- No blending between captured clips.
- Rigged splats: view-dependent SH is evaluated in the bind pose, so strong SH
  on a turned limb is stale; the WebGL2 worker sorter sorts the bind pose; the
  pooled unified draw (`@voluma/vlam/unified/pooled`) rejects the skin
  modifier, which reads channels. At most 4096 bones.
- glTF splats: degree-0 color only (higher SH degrees in the file are
  ignored), and an unskinned primitive keeps its node's transform but no
  parent's skin. Lighting baked into a file's colors stays baked.

Runnable pages: "Play a Faltwerk 4DGS"
([source](../examples/samples/play-4dgs-clip.ts)) plays VLAM's own clip,
`assets/goose-walk/`; "Play an Animated SOG clip"
([source](../examples/samples/play-asog-clip.ts)) plays a synthetic `.asog`
(`assets/asog-sample/`), or any `?src=` URL with its soundtrack. "Rig and
animate splats" ([source](../examples/samples/rigged-splats.ts)) rigs
`assets/goose.sog`.
