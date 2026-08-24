// Example: site/examples/custom-effect.md - a modifier written by hand, with
// no preset involved: a height gradient that pulses, and a gentle sway.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mix, sin, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { SplatMesh, type SplatModifier, createSplatRenderer, loadScene } from '@voluma/vlam';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0.8, 0.3, 1.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Uniforms are the dials you keep. Declared out here, they can be written
// every frame without the shader being rebuilt.
const time = uniform(0);
const tintStrength = uniform(0.85);
const swayAmount = uniform(0.08);

const warm = vec3(1.0, 0.55, 0.2);
const cool = vec3(0.2, 0.5, 1.0);

/**
 * A modifier is one function, called while the shader is being built - not
 * per splat, per frame. It receives nodes describing the splat and returns
 * the properties it wants to change; anything it leaves out is passed through.
 */
const gradient: SplatModifier = (ctx) => {
  // ctx.localCenter is the splat's position in the mesh's own space, as a
  // node. Ordinary arithmetic on nodes builds shader code, not numbers.
  const height = smoothstep(-0.5, 0.5, ctx.localCenter.y);
  const tint = mix(warm, cool, height);

  // A slow horizontal sway that grows toward the top, so the shape leans
  // rather than sliding. `offset` displaces the splat's center.
  const sway = sin(time.add(ctx.localCenter.y.mul(3)))
    .mul(swayAmount)
    .mul(height);

  return {
    color: vec4(mix(ctx.color.rgb, tint, tintStrength), ctx.color.a),
    offset: vec3(sway, 0, 0),
  };
};

const splats = new SplatMesh(await loadScene('/goose.sog'));

// Assigning the list is the structural step - it compiles the shader once.
// Keep the function identity stable: a fresh arrow function here every frame
// would recompile every frame.
splats.modifiers = [gradient];
scene.add(splats);

const strength = document.querySelector<HTMLInputElement>('#strength')!;
strength.addEventListener('input', () => {
  tintStrength.value = Number(strength.value); // uniform write - free
});

const sway = document.querySelector<HTMLInputElement>('#sway')!;
sway.addEventListener('input', () => {
  swayAmount.value = Number(sway.value); // uniform write - free
});

const start = performance.now();

renderer.setAnimationLoop(() => {
  time.value = (performance.now() - start) / 1000;

  controls.update();
  splats.update(camera, renderer);
  renderer.render(scene, camera);
});
