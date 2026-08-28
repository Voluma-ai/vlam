// Example: site/examples/shader-effects.md - cut, light and reveal a capture.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, createSplatRenderer } from '@voluma/vlam';
import { loadScene } from '@voluma/vlam/loaders';
import { lightingPreset, revealPreset, sdfEffects } from '@voluma/vlam/effects';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(1, 0.5, 1.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const splats = new SplatMesh(await loadScene('/goose.sog'));
scene.add(splats);

// Build each effect ONCE, outside the frame loop. Each one is a small piece of
// shader code; making a new one every frame would recompile the shader every
// frame. Nothing here changes the capture - only how it is drawn.
const cutaway = sdfEffects([{ kind: 'sphere', mode: 'hide', center: [0, 0, 0], radius: 0.22 }]);
const lighting = lightingPreset({ direction: [0.3, 1, 0.6], ambient: 0.35 });
const reveal = revealPreset({ frequency: 3, edge: 0.08 });

// The list is the pipeline: each modifier gets the output of the one before it.
splats.modifiers = [reveal.modifier, cutaway.modifier, lighting.modifier];

const start = performance.now();

renderer.setAnimationLoop(() => {
  const time = (performance.now() - start) / 1000;

  // Everything below is a uniform write - a number handed to a shader that is
  // already compiled. Free to do every frame.

  // The reveal runs once, on load, and then stays out of the way.
  reveal.progress.value = Math.min(1, time / 2);

  // Rotate the light so its contribution remains easy to see.
  lighting.direction.value.set(Math.sin(time), 1, Math.cos(time)).normalize();
  cutaway.setShapes([
    { kind: 'sphere', mode: 'hide', center: [Math.sin(time * 0.35) * 0.28, 0, 0], radius: 0.22 },
  ]);

  controls.update();
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});
