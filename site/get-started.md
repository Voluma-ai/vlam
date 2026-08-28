# Get started

Install VLAM! and render a splat scene in a three.js app.

## Install

```bash
npm install @voluma/vlam three
```

`three` is a peer dependency (`>= 0.185.0`).

## Minimal example

```ts
import * as THREE from 'three/webgpu';
import { SplatMesh, createSplatRenderer } from '@voluma/vlam';
import { loadSplatData } from '@voluma/vlam/loaders';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(1, 0.5, 1.4);
camera.lookAt(0, 0, 0);

const splats = new SplatMesh(await loadSplatData('/scene.sog'));
scene.add(splats);

renderer.setAnimationLoop(() => {
 splats.update(camera, renderer);
 renderer.render(scene, camera);
});
```

Call `splats.update(camera, renderer)` every frame before `renderer.render`.

## Camera controls

The example above renders a still image. VLAM! only draws the scene, it does not
handle input. To orbit, pan, or zoom you add camera controls yourself, the same way
you would in any three.js app. `OrbitControls` ships with three.js:

```ts
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

renderer.setAnimationLoop(() => {
 controls.update();
 splats.update(camera, renderer);
 renderer.render(scene, camera);
});
```

Update controls before `splats.update` so sorting uses the camera pose for the
current frame.

## Formats

`loadSplatData` accepts `.sog`, `.ply`, `.spz`, `.splat`, `.ksplat`, and `.rad`.

For large streamed scenes, use `StreamedSplatMesh.load` (Streamed SOG, `.lcc` /
`.lcc2`, `.rad` / `.radc`).

## Next

- [Examples](/examples/): explained walkthroughs, starting with a viewer you can drag
- [FAQ](/faq): formats, CORS, and the short version
- [API reference](/api/): every exported symbol
- <a href="/demo/" target="_self">Full viewer</a>: try scenes in the browser
