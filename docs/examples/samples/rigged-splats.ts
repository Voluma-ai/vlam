// Example: site/examples/rigged-splats.md - rig a static splat with a
// THREE.Skeleton and animate it with bone clips under an AnimationMixer:
// two looping clips cross-faded, and an additive one-shot on top.
// Experimental: `@voluma/vlam/dynamic` may change in a minor release.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createWebGPURenderer } from '@voluma/vlam';
import { loadSplatData } from '@voluma/vlam/loaders';
import { SkinnedSplatMesh } from '@voluma/vlam/dynamic';

const status = document.querySelector<HTMLElement>('#status')!;
const lookButton = document.querySelector<HTMLButtonElement>('#look')!;
const walkButton = document.querySelector<HTMLButtonElement>('#walk')!;
const honkButton = document.querySelector<HTMLButtonElement>('#honk')!;
const speed = document.querySelector<HTMLSelectElement>('#speed')!;

const renderer = await createWebGPURenderer();
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x1a1a1f);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.01, 100);
camera.position.set(-2.2, 0.9, 2.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.5, 0);
controls.enableDamping = true;

// Any static splat works: here VLAM's pixel-art goose, 16 sprite pixels tall.
// It is in 3DGS axes (y down), and a SkinnedSplatMesh keeps the data's axes,
// so the skeleton is built in them too and the mesh is turned upright as a whole.
const data = await loadSplatData('/goose.sog');
const PX = 1 / 16;
let floor = -Infinity;
let beak = Infinity;
for (let i = 0; i < data.count; i++) {
  floor = Math.max(floor, data.positions[i * 3 + 1]!);
  beak = Math.min(beak, data.positions[i * 3]!);
}
/** Height above the feet and distance back from the beak tip, in sprite pixels. */
const heightOf = (i: number) => (floor - data.positions[i * 3 + 1]!) / PX;
const backOf = (i: number) => (data.positions[i * 3]! - beak) / PX;

// 1. Bones: one per part, in a hierarchy like a glTF's. `pivot` is the
// height (sprite pixels) where the part turns: where it joins its parent.
const B = { body: 0, neck: 1, head: 2, jaw: 3, footFront: 4, footRear: 5 } as const;
type Part = keyof typeof B;
const parts: Record<Part, { parent: Part | null; pivot?: number }> = {
  body: { parent: null },
  neck: { parent: 'body', pivot: 8.6 },
  head: { parent: 'neck', pivot: 11.2 },
  jaw: { parent: 'head', pivot: 11.95 },
  footFront: { parent: 'body', pivot: 2.2 },
  footRear: { parent: 'body', pivot: 2.2 },
};
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

// 2. Skin: two bones per splat, cut by where the splat sits on the sprite
// and blended up the neck, so it bends instead of tearing.
const indices = new Uint16Array(data.count * 2);
const weights = new Float32Array(data.count * 2);
const partOf = new Uint8Array(data.count);
for (let i = 0; i < data.count; i++) {
  const h = heightOf(i);
  // Bill and feet are the only orange: the lower bill is the warm strip under
  // the upper one, and the feet are the warm splats at the bottom (the white
  // underside just above them stays on the body).
  const warm = data.colors[i * 4 + 2]! < 0.6 * data.colors[i * 4]!;
  let [a, b, w]: [number, number, number] = [B.body, B.neck, 1 - smooth(7.8, 8.6, h)];
  if (warm && backOf(i) < 1.33 && h > 11.2 && h < 12.3) [a, b, w] = [B.jaw, B.head, 1];
  else if (warm && h < 2.2) [a, b, w] = [backOf(i) < 2.9 ? B.footFront : B.footRear, B.body, 1];
  else if (h >= 8.6) [a, b, w] = [B.neck, B.head, 1 - smooth(8.6, 11.2, h)];
  indices.set([a, b], i * 2);
  weights.set([w, 1 - w], i * 2);
  partOf[i] = w >= 0.5 ? a : b;
}

// 3. The skeleton, its pivots found from the splats: each bone sits at its
// part's centre, raised or lowered to the height where the part turns.
const centre = Object.keys(B).map(() => new THREE.Vector3());
const counts = new Array<number>(centre.length).fill(0);
for (let i = 0; i < data.count; i++) {
  centre[partOf[i]!]!.add(new THREE.Vector3().fromArray(data.positions, i * 3));
  counts[partOf[i]!]!++;
}
const bones = (Object.keys(B) as Part[]).map((name) => {
  const at = centre[B[name]]!.divideScalar(Math.max(counts[B[name]]!, 1));
  const { pivot } = parts[name];
  if (pivot !== undefined) at.y = floor - pivot * PX;
  if (name === 'jaw') at.x = beak + 1.33 * PX; // the bill hinges at its back end
  return Object.assign(new THREE.Bone(), { name, rest: at });
});
for (const bone of bones) {
  const parent = parts[bone.name].parent;
  bone.position.copy(bone.rest).sub(parent ? bones[B[parent]]!.rest : new THREE.Vector3());
  if (parent) bones[B[parent]]!.add(bone);
}

// 4. The mesh: the splats as captured, skinned on the GPU by the skeleton.
// The bones live under the mesh, so binding without a matrix makes the
// current pose the bind pose, as THREE.SkinnedMesh.bind does.
const mesh = new SkinnedSplatMesh(data, { skin: { bonesPerSplat: 2, indices, weights } });
mesh.add(bones[B.body]!);
mesh.rotation.x = Math.PI; // 3DGS axes → y up
mesh.position.y = floor; // feet on the ground
mesh.bind(new THREE.Skeleton(bones));
scene.add(mesh);
status.textContent = `${data.count.toLocaleString()} splats · ${bones.length} bones`;

// 5. Clips, as a glTF carries them: keyframe tracks on bone transforms.
// In the data's axes "up" is −y and "forward" (toward the beak) is −x.
function clip(name: string, duration: number, curves: Record<string, (t: number) => number[]>) {
  const times = Array.from({ length: Math.round(duration * 30) + 1 }, (_, i) => i / 30);
  const tracks = Object.entries(curves).map(([path, curve]) => {
    const values = times.flatMap(curve);
    return path.endsWith('.quaternion')
      ? new THREE.QuaternionKeyframeTrack(path, times, values)
      : new THREE.VectorKeyframeTrack(path, times, values);
  });
  return new THREE.AnimationClip(name, duration, tracks);
}
const turn = (axis: THREE.Vector3, angle: number) =>
  new THREE.Quaternion().setFromAxisAngle(axis, angle).toArray();
const Z = new THREE.Vector3(0, 0, 1);
const Y = new THREE.Vector3(0, 1, 0);
/** A bone's rest position moved by (dx, dy) sprite pixels. */
const at = (name: Part, dx: number, dy: number) =>
  bones[B[name]]!.position.clone()
    .add(new THREE.Vector3(dx * PX, dy * PX, 0))
    .toArray();
/** 0 → 1 → 0: up over [a, b], down over [c, d]. */
const pulse = (t: number, a: number, b: number, c: number, d: number) =>
  smooth(a, b, t) * (1 - smooth(c, d, t));

const look = clip('look', 4, {
  'head.quaternion': (t) => turn(Y, 0.45 * Math.sin((2 * Math.PI * t) / 4)),
  'neck.quaternion': (t) => turn(Z, 0.06 * Math.sin((4 * Math.PI * t) / 4)),
});
const walk = clip('walk', 1, {
  'footFront.position': (t) =>
    at('footFront', Math.cos(2 * Math.PI * t), -0.3 * Math.max(0, Math.sin(2 * Math.PI * t))),
  'footRear.position': (t) =>
    at('footRear', -Math.cos(2 * Math.PI * t), -0.3 * Math.max(0, -Math.sin(2 * Math.PI * t))),
  'body.position': (t) => at('body', 0, 0.3 * Math.cos(2 * Math.PI * t) ** 2),
  'neck.quaternion': (t) => turn(Z, -0.08 * Math.cos(4 * Math.PI * t)),
});
const honk = clip('honk', 1.1, {
  // The head stretches up and forward, the bill opens twice.
  'head.position': (t) =>
    at('head', -0.5 * pulse(t, 0, 0.25, 0.85, 1.1), -1.2 * pulse(t, 0, 0.25, 0.85, 1.1)),
  'jaw.quaternion': (t) =>
    turn(Z, 0.55 * Math.max(0, Math.sin(2 * Math.PI * 1.6 * t)) * pulse(t, 0, 0.2, 0.9, 1.1)),
});
// The honk is added on top of whatever else plays, not averaged with it.
THREE.AnimationUtils.makeClipAdditive(honk);

const mixer = new THREE.AnimationMixer(mesh);
const looking = mixer.clipAction(look).play();
const walking = mixer.clipAction(walk);
// makeClipAdditive marked the clip additive, so its action blends that way.
const honking = mixer.clipAction(honk).setLoop(THREE.LoopOnce, 1);

// Cross-fades blend the two loops bone by bone, as for any skinned mesh.
let current = looking;
const fadeTo = (next: THREE.AnimationAction) => {
  if (next === current) return;
  next.reset().play();
  current.crossFadeTo(next, 0.5, false);
  current = next;
  lookButton.disabled = current === looking;
  walkButton.disabled = current === walking;
};
lookButton.disabled = true;
lookButton.onclick = () => fadeTo(looking);
walkButton.onclick = () => fadeTo(walking);
honkButton.onclick = () => honking.reset().play();
speed.onchange = () => (mixer.timeScale = Number(speed.value));

const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
  timer.update();
  mixer.update(timer.getDelta());
  controls.update();
  // Refreshes the bone texture from the skeleton, then sorts and draws.
  mesh.update(camera, renderer);
  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
