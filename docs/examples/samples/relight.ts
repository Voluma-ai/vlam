// Example: site/examples/relight.md - sun and shadows on a streamed capture,
// from its collision mesh rendered into a screen-space lighting map.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSplatRenderer } from '@voluma/vlam';
import { StreamedSplatMesh } from '@voluma/vlam/streaming';
import {
  createRelightingProxy,
  createRelightingShadowFactorMaterial,
  renderRelightingFactorMap,
} from '@voluma/vlam/effects';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 10000);
camera.position.set(-9.09, 1.65, 8.85);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(-8.21, 1.67, 7.06);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const splats = await StreamedSplatMesh.load('/remote/jack/v/Dehaar/Dehaar.lcc2');
scene.add(splats);
splats.updateWorldMatrix(true, false);

// Relighting follows these triangles, not the splats. LCC collision is
// source-local, so bake the mesh's world matrix into the proxy.
const proxy = createRelightingProxy({
  tiles: await splats.loadCollisionMeshes(),
  matrixWorld: splats.matrixWorld.clone(),
});
const relightScene = new THREE.Scene();
relightScene.add(proxy.group);

const bounds = new THREE.Box3().setFromObject(proxy.group);
const focus = bounds.getCenter(new THREE.Vector3());
const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.5, 8) * 1.1;
const distance = Math.max(radius * 2, 20);

const sunDir = new THREE.Vector3(1, 0.75, 0.4).normalize();
const sun = new THREE.DirectionalLight(0xffa040, 1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.002;
sun.shadow.normalBias = 0.12;
sun.position.copy(focus).addScaledVector(sunDir, distance);
sun.target.position.copy(focus);
relightScene.add(sun);
relightScene.add(sun.target);

const shadowCam = sun.shadow.camera;
shadowCam.left = -radius;
shadowCam.right = radius;
shadowCam.top = radius;
shadowCam.bottom = -radius;
shadowCam.near = 0.5;
shadowCam.far = distance + radius;
shadowCam.updateProjectionMatrix();

// Multiplier, not a gray lit look: unshadowed coverage stays ≈ 1, umbra
// darkens, and a warm Lambert term brightens faces toward the sun.
const factorMat = createRelightingShadowFactorMaterial(sun, {
  umbra: 0.5,
  color: new THREE.Color(0xffa040),
  diffuse: 0.8,
  direction: sunDir,
});
proxy.group.traverse((obj) => {
  if (!(obj instanceof THREE.Mesh)) return;
  obj.material = factorMat;
  obj.castShadow = true;
  obj.receiveShadow = true;
});

const relightTarget = new THREE.RenderTarget(1, 1, {
  depthBuffer: true,
  type: THREE.HalfFloatType,
});
relightTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
splats.setRelighting({
  map: relightTarget.texture,
  blend: 1,
  brightness: 1,
  background: 1,
  softness: 2,
});

renderer.setAnimationLoop(() => {
  controls.update();

  const t = performance.now() * 0.001;
  sunDir.set(Math.cos(t * 0.15), 0.75, Math.sin(t * 0.15)).normalize();
  sun.position.copy(focus).addScaledVector(sunDir, distance);
  sun.target.position.copy(focus);
  sun.target.updateMatrixWorld();

  // Isolates autoClear / shadow maps and swaps a passthrough contextNode so
  // this works on an application-owned WebGPURenderer, not only createSplatRenderer().
  // Clears white + A0.
  renderRelightingFactorMap(renderer, relightScene, camera, relightTarget);

  splats.update(camera, renderer);
  renderer.render(scene, camera);
});
