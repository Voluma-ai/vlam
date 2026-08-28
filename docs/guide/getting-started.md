# Getting started

Render a Gaussian-splat scene inside a three.js app with VLAM! in a few
minutes: install, set up the WebGPU renderer, load a scene, and drive the
per-frame update loop.

Every multi-line snippet in these guides is a real, compile-verified file
under [`samples/`](samples/), copy from there if you want the full imports.

## Install

```bash
npm install @voluma/vlam three
```

`three` is a peer dependency (`>= 0.185.0`).

To develop against a checkout instead, `npm link ../vlam` works, with the
usual caveat: make sure your bundler resolves exactly one copy of `three`.

## The minimal app

Renderer, camera, one splat mesh, a render loop:

```ts
import * as THREE from 'three/webgpu';
import { SplatMesh, createSplatRenderer } from '@voluma/vlam';
import { loadScene } from '@voluma/vlam/loaders';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(1, 0.5, 1.4);
camera.lookAt(0, 0, 0);

const splats = new SplatMesh(await loadScene('/scene.sog'));
scene.add(splats);

renderer.setAnimationLoop(() => {
 splats.update(camera, renderer); // uniforms + GPU depth sort
 renderer.render(scene, camera);
});
```

<!-- full file: docs/guide/samples/getting-started-basic.ts -->

Notes on the lines that matter most:

- **`splats.update(camera, renderer)` must run every frame, before
  `renderer.render`.** It updates the projection uniforms and schedules the
 GPU depth sort that keeps splats blending back-to-front. Skipping it leaves
 the scene sorted for a stale camera.
- **`createSplatRenderer()` is the renderer boilerplate, once.** It requests
 the adapter, then owns the `requestDevice` call so it can ask for two things
 three would not: the adapter's advertised buffer/texture maxima as
  `requiredLimits` (WebGPU's default `maxStorageBufferBindingSize` is 128 MiB,
  which large streamed or unified scenes blow past around 8M splats), and every
  adapter feature as `requiredFeatures`, `core-features-and-limits` above all,
  without which three treats the backend as compatibility-mode and silently
  drops MSAA. It also omits `powerPreference` on Windows, where Chrome ignores
  it and warns ([crbug.com/369219127](https://crbug.com/369219127)). It falls
  back to WebGL2 like a plain `new THREE.WebGPURenderer()`; pass
  `requireWebGpu: true` to throw instead. Every `WebGPURenderer` option passes
 through, and hosts that must own device creation themselves can still call
  `recommendedWebGpuRequiredLimits` / `webGpuPowerPreferenceOptions` directly.
- **Leave `outputColorSpace` alone.** three's default is already
  `SRGBColorSpace`, and the splat shader converts its display-ready sRGB colors
 to the working color space itself, so setting it restates the default, and
 changing it is what breaks the colors.
- **Orientation is normalized for you.** `SplatMesh` orients every known
 format to three.js Y-up by default (the classic `rotation.x = Math.PI` flip
 for 3DGS scenes is built in). Pass `orientation: 'source'` in the options to
 render in the raw data frame instead.

A real app will add camera controls, the demo uses
[camera-controls](https://github.com/yomotsu/camera-controls), calling
`controls.update(delta)` at the top of the same loop; VLAM! deliberately
ships no controls of its own.

## Loading a local file

`loadSceneFile` decodes a `File` from a drop or `<input type="file">` in a
Web Worker, nothing is uploaded, nothing blocks the main thread:

```ts
import { SplatMesh } from '@voluma/vlam';
import { loadSceneFile } from '@voluma/vlam/loaders';

export async function onFilePicked(file: File): Promise<SplatMesh> {
  // Decoded in a Web Worker; the bytes never leave the device.
  const data = await loadSceneFile(file, {
    onProgress: (loaded, total) => console.log(`read ${loaded} / ${total} bytes`),
  });
  return new SplatMesh(data);
}
```

<!-- full file: docs/guide/samples/getting-started-file-input.ts -->

## Cleaning up

Splat meshes own GPU resources (pool textures, sorter buffers, pick passes)
that three.js does not free for you:

```ts
export function teardown(scene: THREE.Scene, renderer: THREE.WebGPURenderer, splats: SplatMesh) {
  renderer.setAnimationLoop(null);
  scene.remove(splats);
  splats.dispose(); // frees pool textures, sorter buffers, pick resources
  renderer.dispose();
}
```

<!-- full file: docs/guide/samples/getting-started-dispose.ts -->

Disposing is safe while loads or picks are in flight, pending picks resolve
`null`, and a `StreamedSplatMesh` stops its streaming.

## Non-uniform scale

A splat mesh scales like any three.js object, including **per-axis
(non-uniform) scale**, which renders, sorts, picks, and answers spatial
queries correctly (the Gaussian math is linear-map exact, `Σ' = A·Σ·Aᵀ`):

```ts
export function squashForTabletop(splats: SplatMesh): void {
 splats.scale.set(2, 0.5, 1); // stretch x, flatten y
}
```

<!-- full file: docs/guide/samples/getting-started-nonuniform-scale.ts -->

Animating scale per frame is cheap, it flows through matrix uniforms, never
a data re-upload. See the "Non-uniform scale" section in
[`capabilities.md`](../capabilities.md) for exactness notes (view-dependent SH
under strong anisotropy is a documented approximation), and try
`?scale=2,0.5,1` in the demo.

## WebGL2 fallback

There is no separate code path to write: the shaders are TSL, so the same
graph compiles to WGSL on WebGPU and GLSL on WebGL2, and
`THREE.WebGPURenderer` falls back automatically where WebGPU is unavailable.
Static and streamed rendering, picking, and spatial queries all work on the
fallback; the exceptions are `UnifiedSplatRenderer` (gate it with
`supportsUnifiedSplatRenderer`, see [Unified rendering](unified-rendering.md))
and `wgslFn`-based effect presets like `revealPreset`. Details:
[WebGL2 scope statement](../capabilities.md#webgl2-scope-statement).

## Next

- [Loading scenes](loading-scenes.md), formats, errors, progress, cancellation.
- [Streaming & LOD](streaming-and-lod.md), scenes larger than GPU memory.
