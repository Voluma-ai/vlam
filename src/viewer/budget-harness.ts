/**
 * Scene budget harness (`/budget-harness.html`): several whole-file scenes
 * loaded under one `SplatSceneBudget`, for checking thinning, re-balancing and
 * memory by eye. Dev-only; not part of the published site.
 *
 * Query parameters:
 * - `scene=<url>` (repeatable): files to load, in order.
 * - `budget=<splats>`: the budget's `total` (default: the device default).
 * - `profile=none`: skip device detection, so `budget` applies as is.
 * - `nobudget=1`: load without the budget, for comparison.
 * - `plan=1`: split the budget by header counts before loading.
 * - `defer=<k>`: load only the first `k` scenes; `__budget.addNext()` loads
 *   the next one (re-balancing the others when it does not fit).
 * - `unified=1`: draw every scene through one `UnifiedSplatMesh`.
 * - `spacing=<units>`: offset each scene along X by this much (default 0).
 * - `cameraPosition=x,y,z&cameraTarget=x,y,z`: the initial pose.
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, createWebGPURenderer } from '../lib/core';
import { loadSplatData, SplatSceneBudget } from '../lib/loaders';
import { UnifiedSplatMesh, supportsUnifiedSplatMesh } from '../lib/unified';

const params = new URLSearchParams(location.search);
const urls = params.getAll('scene');
const status = document.querySelector<HTMLDivElement>('#status');
const log: string[] = [];

function vector(name: string, fallback: THREE.Vector3): THREE.Vector3 {
  const parts = params.get(name)?.split(',').map(Number);
  return parts?.length === 3 && parts.every(Number.isFinite)
    ? new THREE.Vector3(parts[0], parts[1], parts[2])
    : fallback;
}

const renderer = await createWebGPURenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 2000);
camera.position.copy(vector('cameraPosition', new THREE.Vector3(0, 2, 8)));
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(vector('cameraTarget', new THREE.Vector3(0, 0, 0)));
controls.update();
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const budgetParam = params.get('budget');
const budget = new SplatSceneBudget({
  ...(budgetParam ? { total: Number(budgetParam) } : {}),
  ...(params.get('profile') === 'none' ? { profile: null } : {}),
});
const spacing = Number(params.get('spacing') ?? 0);
const useUnified = params.get('unified') === '1' && supportsUnifiedSplatMesh(renderer);
const unified = useUnified ? new UnifiedSplatMesh(renderer, budget.total) : null;
if (unified) scene.add(unified);
const meshes: SplatMesh[] = [];

const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  log.push(args.map(String).join(' '));
  originalWarn(...args);
};

if (params.get('plan') === '1') await budget.plan(urls, { baseUrl: location.href });

let next = 0;
async function addNext(): Promise<SplatMesh | null> {
  const url = urls[next];
  if (url === undefined) return null;
  const index = next++;
  const started = performance.now();
  const data = await loadSplatData(url, {
    baseUrl: location.href,
    ...(params.get('nobudget') === '1' ? {} : { sceneBudget: budget }),
  });
  const mesh = new SplatMesh(data);
  mesh.position.x += index * spacing;
  mesh.updateMatrixWorld(true);
  meshes.push(mesh);
  if (unified) unified.addSource(mesh);
  else scene.add(mesh);
  log.push(
    `loaded ${url}: ${data.count.toLocaleString('en-US')} of ` +
      `${(data.sourceCount ?? data.count).toLocaleString('en-US')} in ` +
      `${((performance.now() - started) / 1000).toFixed(1)} s`,
  );
  return mesh;
}

/**
 * Splat pool texture bytes: 52 per slot plus 16 per packed-SH texture. Sized
 * from the pool, which a budget shrink reallocates, not from `mesh.capacity`,
 * which keeps the original draw-list size.
 */
function poolBytes(mesh: SplatMesh): number {
  const pool = (
    mesh as unknown as { pool: { capacity: number; shPackedTextures: readonly unknown[] } }
  ).pool;
  return pool.capacity * (52 + 16 * pool.shPackedTextures.length);
}

function stats() {
  return {
    total: budget.total,
    resident: budget.resident,
    free: budget.free,
    meshes: meshes.map((mesh) => ({
      held: mesh.budgetedSplatCount,
      active: mesh.activeSplatCount,
      capacity: mesh.capacity,
      poolMiB: Math.round(poolBytes(mesh) / 2 ** 20),
    })),
    poolMiB: Math.round(meshes.reduce((sum, mesh) => sum + poolBytes(mesh), 0) / 2 ** 20),
    log,
  };
}

const deferred = Number(params.get('defer') ?? urls.length);
const first = Math.min(urls.length, Number.isFinite(deferred) ? deferred : urls.length);
await Promise.all(Array.from({ length: first }, () => addNext()));

(window as unknown as { __budget: unknown }).__budget = {
  renderer,
  scene,
  camera,
  controls,
  budget,
  meshes,
  unified,
  addNext,
  stats,
};

renderer.setAnimationLoop(() => {
  controls.update();
  if (unified) unified.update(camera);
  else for (const mesh of meshes) mesh.update(camera, renderer);
  renderer.render(scene, camera);
  if (status) {
    const s = stats();
    status.textContent =
      `budget ${s.total.toLocaleString('en-US')}  resident ${s.resident.toLocaleString('en-US')}` +
      `  free ${s.free.toLocaleString('en-US')}  pools ${s.poolMiB} MiB` +
      (unified ? '  (unified)' : '') +
      '\n' +
      s.meshes
        .map(
          (mesh, i) =>
            `#${i} held ${mesh.held.toLocaleString('en-US')}  active ` +
            `${mesh.active.toLocaleString('en-US')}  pool ${mesh.poolMiB} MiB`,
        )
        .join('\n') +
      '\n' +
      log.slice(-6).join('\n');
  }
});
