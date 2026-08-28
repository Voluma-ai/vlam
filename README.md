# VLAM!

<!-- Image shields. Do not flatten CI badges to text links. -->

[![CI](https://github.com/Voluma-ai/vlam/actions/workflows/ci.yml/badge.svg)](https://github.com/Voluma-ai/vlam/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@voluma/vlam.svg)](https://www.npmjs.com/package/@voluma/vlam)
[![demo](https://img.shields.io/badge/demo-live-4c1.svg)](https://vlam.voluma.ai)
[![license](https://img.shields.io/github/license/Voluma-ai/vlam.svg)](./LICENSE)

A WebGPU Gaussian Splat viewer for three.js.

**Docs and demo:** [https://vlam.voluma.ai](https://vlam.voluma.ai) · [get started](site/get-started.md) · [guides](docs/guide/README.md)

Local site and generated API: `npm run dev` (http://localhost:5170, viewer at `/demo/`).

> Package `@voluma/vlam`, public **0.2.0**. APIs may still move before 1.0.

## Important notice!
This is a pre-release not yet recommended for production. The API can still change in breaking ways before v1.0.


## Install

```bash
npm install @voluma/vlam three
```

`three` is a peer dependency (`>= 0.185.0`).

## Usage

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


Supported formats: `.sog`, `.ply`, `.spz`, `.splat`, `.ksplat`, `.lcc`, `.lcc2`, `.rad`, `.radc`. 


## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md). By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security reports: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Made in the EU by [Voluma](https://voluma.ai).
