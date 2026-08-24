// Guide sample: docs/guide/relighting.md - shadow-factor proxy-mesh relight.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, createSplatRenderer, loadScene } from '@voluma/vlam';
import { createRelightingProxy, createRelightingShadowFactorMaterial } from '@voluma/vlam/effects';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(1.2, 0.8, 1.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const splats = new SplatMesh(await loadScene('/goose.sog'));
scene.add(splats);

// Stand-in proxy (real scenes: createRelightingProxy({ tiles, matrixWorld })).
const proxy = createRelightingProxy({
  geometries: [new THREE.BoxGeometry(1.4, 0.9, 1.4)],
});
const relightScene = new THREE.Scene();
relightScene.add(proxy.group);

const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.position.set(2.5, 4, 1.5);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
relightScene.add(sun);

const factorMat = createRelightingShadowFactorMaterial(sun);
proxy.group.traverse((obj) => {
  if (!(obj instanceof THREE.Mesh)) return;
  obj.material = factorMat;
  obj.castShadow = true;
  obj.receiveShadow = true;
});

const relightTarget = new THREE.RenderTarget(1, 1, { depthBuffer: true });
relightTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
splats.setRelighting({
  map: relightTarget.texture,
  blend: 1,
  brightness: 1,
  background: 1,
  softness: 3,
});

function frame() {
  requestAnimationFrame(frame);
  controls.update();
  const t = performance.now() * 0.001;
  sun.position.set(Math.cos(t * 0.4) * 3, 4, Math.sin(t * 0.4) * 3);

  renderer.setRenderTarget(relightTarget);
  // White + A0 — black clear draws dark triangle outlines under softness.
  renderer.setClearColor(0xffffff, 0);
  renderer.clear();
  renderer.render(relightScene, camera);
  renderer.setRenderTarget(null);

  splats.update(camera, renderer);
  renderer.render(scene, camera);
}
frame();
