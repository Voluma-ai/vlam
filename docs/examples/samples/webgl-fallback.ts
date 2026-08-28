// Example: site/examples/webgl-fallback.md - the same app on both backends,
// reporting which one it got and adapting what it asks for.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, createSplatRenderer } from '@voluma/vlam';
import { loadScene } from '@voluma/vlam/loaders';
import { lightingPreset, revealPreset, sdfEffects } from '@voluma/vlam/effects';

// `?backend=webgl` forces the fallback path, so you can see it on a machine
// that has WebGPU. In your own app you would simply call
// createSplatRenderer() and let it decide.
const useWebGL = new URLSearchParams(location.search).get('backend') === 'webgl';
const renderer = await createSplatRenderer(useWebGL ? { forceWebGL: true } : {});
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

// What did we actually get? Everything below keys off this one boolean.
const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0.9, 0.3, 1.7);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const splats = new SplatMesh(await loadScene('/goose.sog'));
scene.add(splats);

// Portable effects: plain TSL arithmetic, so both backends run them.
const cutaway = sdfEffects([{ kind: 'sphere', mode: 'hide', center: [0, 0, 0], radius: 0.22 }]);
const lighting = lightingPreset({ direction: [0.3, 1, 0.6], ambient: 0.35 });

// `revealPreset` is built on wgslFn noise - WebGPU only, and inert on WebGL2.
// Asking for it there is not an error; it simply does nothing, which is worse
// than not asking, because the effect silently never appears.
const reveal = isWebGPU ? revealPreset({ frequency: 3, edge: 0.08 }) : null;

splats.modifiers = reveal
  ? [reveal.modifier, cutaway.modifier, lighting.modifier]
  : [cutaway.modifier, lighting.modifier];

// Core depth of field works on both backends.
splats.setDepthOfField({ focusDistance: 1.9, aperture: 0.3 });

const banner = document.querySelector<HTMLElement>('#banner')!;
banner.innerHTML = isWebGPU
  ? '<b>WebGPU</b> - everything available. <a href="?backend=webgl">See the fallback →</a>'
  : '<b>WebGL2 fallback</b> - reveal effect and SplatScene unavailable; everything else works. <a href="?">Back to WebGPU →</a>';

const start = performance.now();

renderer.setAnimationLoop(() => {
  const time = (performance.now() - start) / 1000;
  if (reveal) reveal.progress.value = Math.min(1, time / 2);
  lighting.direction.value.set(Math.sin(time * 0.25), 1, Math.cos(time * 0.25)).normalize();
  cutaway.setShapes([
    { kind: 'sphere', mode: 'hide', center: [Math.sin(time * 0.35) * 0.28, 0, 0], radius: 0.22 },
  ]);

  controls.update();
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});
