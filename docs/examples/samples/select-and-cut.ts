// Example: site/examples/select-and-cut.md - place a selection box with a
// transform gizmo, count what is inside it, and split the capture in two.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformGizmo } from '@voluma/three-transform-gizmo';
import { SplatMesh, createSplatRenderer } from '@voluma/vlam';
import { loadSplatData } from '@voluma/vlam/loaders';
import { countInData, createSelectionVolume, partitionSplatData } from '@voluma/vlam/selection';

const renderer = await createSplatRenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0.9, 0.4, 1.8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const data = await loadSplatData('/goose.sog');
let splats = new SplatMesh(data);
scene.add(splats);

// Every mesh on screen needs its own `update` each frame - after the split
// there are two of them.
const meshes: SplatMesh[] = [splats];

// The cage: a unit cube you move, turn and stretch. Its matrix IS the
// selection - a 1×1×1 box means half-extents of 0.5 in the volume's own
// space, and everything else (position, rotation, per-axis scale) rides along
// in the transform.
const cage = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicNodeMaterial({ color: 0xff3366, wireframe: true }),
);
cage.position.set(0, 0.25, 0);
cage.scale.set(0.6, 0.5, 0.4);
scene.add(cage);

const gizmo = new TransformGizmo(camera, renderer.domElement, {
  theme: {
    showScaleModifiers: true, // Shift/Alt scale hints on the axes
    sizes: { ringTube: 0.006 }, // half the default rotate-ring thickness
  },
});
gizmo.setMode('combined'); // translate + rotate + scale handles together
gizmo.attach(cage);
scene.add(gizmo);

// Orbiting while dragging a handle would fight the gizmo for the pointer.
gizmo.addEventListener('dragging-changed', (event) => {
  controls.enabled = !event.value;
});

const readout = document.querySelector<HTMLElement>('#readout')!;
const cutButton = document.querySelector<HTMLButtonElement>('#cut')!;

/** The volume for wherever the cage currently sits. */
function currentVolume() {
  cage.updateMatrixWorld(true);
  splats.updateMatrixWorld(true);
  // `transform` places the shape in world space; the second argument is the
  // capture's own world matrix, so each center is mapped into the volume's
  // frame for you - the upright correction included.
  return createSelectionVolume(
    { kind: 'box', halfExtents: [0.5, 0.5, 0.5], transform: cage.matrixWorld },
    splats.matrixWorld,
  );
}

// Before the split the gizmo drives the selection box; after it, the piece
// that was cut out - so drag events mean different things in the two phases.
let phase: 'selecting' | 'editing' = 'selecting';

function refresh(): void {
  if (phase === 'editing') return;
  // One pass over the centers: no allocation, no GPU work. Cheap enough to run
  // on every drag event, which is what makes a live count practical.
  const inside = countInData(data, currentVolume());
  readout.textContent = `${inside.toLocaleString()} of ${data.count.toLocaleString()} splats inside the box`;
  cutButton.disabled = inside === 0 || inside === data.count;
}

gizmo.addEventListener('objectChange', refresh);
refresh();

// Mode toggles. Combined is the default; dedicated modes keep one tool only.
const modes = ['combined', 'translate', 'rotate', 'scale'] as const;
for (const mode of modes) {
  document.querySelector<HTMLButtonElement>(`#${mode}`)!.addEventListener('click', () => {
    gizmo.setMode(mode);
    for (const other of modes) {
      document.querySelector(`#${other}`)!.classList.toggle('active', other === mode);
    }
  });
}

cutButton.addEventListener('click', () => {
  // Splitting is where the real work happens: two new SplatData objects, each
  // with its own copied arrays. Do it on a click, not on a drag.
  const { inside, outside } = partitionSplatData(data, currentVolume());

  scene.remove(splats);
  splats.dispose(); // the old mesh's GPU memory is not reclaimed for you
  meshes.length = 0;

  splats = new SplatMesh(outside);
  scene.add(splats);
  meshes.push(splats);

  // Put the selected part aside, so you can see the two halves really are
  // separate captures now. It goes in a Group because the gizmo writes a
  // quaternion, and a SplatMesh's own rotation is the correction that stands
  // it upright - see the "splats + 3D objects" example.
  const lifted = new SplatMesh(inside);
  const piece = new THREE.Group();
  piece.add(lifted);
  piece.position.set(0.8, 0, 0);
  scene.add(piece);
  meshes.push(lifted);

  readout.textContent = `split: ${outside.count.toLocaleString()} kept · ${inside.count.toLocaleString()} cut out - now drag the piece`;
  cutButton.disabled = true;
  cage.visible = false;

  // Hand the gizmo to the piece you just cut: the toggles keep working, so
  // you can move, turn and stretch the extracted part.
  phase = 'editing';
  gizmo.attach(piece);
});

renderer.setAnimationLoop(() => {
  controls.update();
  for (const mesh of meshes) mesh.update(camera, renderer);
  renderer.render(scene, camera);
});
