import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SplatMesh } from '../splat-mesh';
import { MergedSplatMesh } from '../merged-splat-mesh';
import { writeCovariance, transformCovariance, type SplatData } from '../splat-data';
import { ComputeSorter } from '../compute-sorter';
import { RadixSorter } from '../radix-sorter';
import { worldBoundsOf } from '../source-transform';
import { viewDepthRadius } from '../splat-sort-bounds';
import { unprojectViewDepth } from '../splat-depth-pack';
import { UnifiedSplatMesh } from '../unified-splat-mesh';

/**
 * Non-uniform (per-axis) scale contract. `mesh.scale.set(sx, sy, sz)` must be
 * correct end-to-end: the Gaussian math is linear-map exact (Σ' = A·Σ·Aᵀ for
 * any linear A), and these tests pin every CPU-checkable path - rendering
 * projection, sort ordering and depth bounds, spatial queries, pick unproject,
 * and unified per-source world bounds.
 */

/** A mesh matrix with non-uniform scale (2, 0.5, 1) and a rotation. */
function nonUniformModel(): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(0.3, -0.2, 0.1),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -0.7, 0.2)),
    new THREE.Vector3(2, 0.5, 1),
  );
}

/** A plausible camera view matrix (rigid). */
function cameraView(): THREE.Matrix4 {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0.5, 1.2, 6);
  camera.lookAt(0.2, 0, 0);
  camera.updateMatrixWorld(true);
  return camera.matrixWorldInverse.clone();
}

/** A rotated child below a non-uniformly scaled parent: its world matrix shears. */
function hierarchyShearModel(): THREE.Matrix4 {
  const parent = new THREE.Object3D();
  parent.scale.set(3, 1, 1);
  const child = new THREE.Object3D();
  child.rotation.z = Math.PI / 4;
  parent.add(child);
  parent.updateMatrixWorld(true);
  return child.matrixWorld.clone();
}

/** A rigid view that maps the sheared model's stretched world-x axis onto view z. */
function hierarchyShearModelView(): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationY(Math.PI / 2).multiply(hierarchyShearModel());
}

function sorterInputs(capacity: number) {
  return {
    capacity,
    centersTexture: new THREE.DataTexture(
      new Float32Array(capacity * 4),
      capacity,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    ),
    dataTextureWidth: capacity,
    splatIndexAttribute: new THREE.StorageInstancedBufferAttribute(new Float32Array(capacity), 1),
    sourceIndexAttribute: new THREE.StorageBufferAttribute(new Uint32Array(capacity), 1),
  };
}

function expectDepthBounds(
  sorter: { sort(modelView: THREE.Matrix4, activeCount: number, bounds: THREE.Sphere): boolean },
  modelView: THREE.Matrix4,
  bounds: THREE.Sphere,
  keyMax: number,
): void {
  sorter.sort(modelView, 32, bounds);
  const internals = sorter as unknown as {
    depthMin: { value: number };
    depthScale: { value: number };
  };
  const viewCenter = bounds.center.clone().applyMatrix4(modelView);
  const viewRadius = viewDepthRadius(modelView, bounds.radius);
  expect(internals.depthMin.value).toBeCloseTo(viewCenter.z - viewRadius, 5);
  expect(internals.depthScale.value).toBeCloseTo(keyMax / (2 * viewRadius), 4);
}

/** The linear 3×3 of a Matrix4, compacted column-major (transformCovariance's shape). */
function linearOf(m: THREE.Matrix4): number[] {
  const e = m.elements;
  return [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]];
}

/**
 * CPU replay of the shader's EWA projection (splat-mesh-material.ts): view
 * center via modelView, Jacobian rows j1/j2, uₐ = Wᵀ·jₐ with W the **full**
 * linear part of modelView (not just its rotation), Σ'ₐᵦ = uₐᵀ·Σ·uᵦ.
 */
function projectCovariance(
  cov: Float32Array,
  center: THREE.Vector3,
  modelView: THREE.Matrix4,
  focalX: number,
  focalY: number,
): { a: number; b: number; d: number; lambda1: number; lambda2: number } {
  const view = center.clone().applyMatrix4(modelView);
  const invZ = 1 / view.z;
  const invZ2 = invZ * invZ;
  const j1 = new THREE.Vector3(focalX * invZ, 0, -focalX * view.x * invZ2);
  const j2 = new THREE.Vector3(0, focalY * invZ, -focalY * view.y * invZ2);
  const w = new THREE.Matrix3().setFromMatrix4(modelView);
  const wT = w.clone().transpose();
  const u1 = j1.clone().applyMatrix3(wT);
  const u2 = j2.clone().applyMatrix3(wT);
  const sigma = new THREE.Matrix3().set(
    cov[0]!,
    cov[1]!,
    cov[2]!,
    cov[1]!,
    cov[3]!,
    cov[4]!,
    cov[2]!,
    cov[4]!,
    cov[5]!,
  );
  const su1 = u1.clone().applyMatrix3(sigma);
  const su2 = u2.clone().applyMatrix3(sigma);
  const a = u1.dot(su1);
  const d = u2.dot(su2);
  const b = u1.dot(su2);
  // Same eigenvalue derivation as the shader's quad-extent computation.
  const mid = (a + d) / 2;
  const radius = Math.hypot((a - d) / 2, b);
  return { a, b, d, lambda1: mid + radius, lambda2: Math.max(mid - radius, 0) };
}

describe('non-uniform scale: rendering projection (CPU contract)', () => {
  it('folding a non-uniform model matrix into modelView equals pre-baking A·Σ·Aᵀ', () => {
    const cov = new Float32Array(6);
    // An anisotropic, rotated Gaussian.
    writeCovariance(cov, 0, 0.3, 0.05, 0.12, 0.9238795, 0.3826834, 0, 0);
    const model = nonUniformModel();
    const view = cameraView();
    const localCenter = new THREE.Vector3(0.7, -0.4, 1.1);

    // Path A: the shader's actual formulation - Σ stays local, modelView = V·M.
    const modelView = view.clone().multiply(model);
    const folded = projectCovariance(cov, localCenter, modelView, 500, 500);

    // Path B: bake the model's full linear part into Σ and the center, then
    // project with the rigid camera view alone.
    const baked = new Float32Array(6);
    transformCovariance(baked, 0, cov, 0, linearOf(model));
    const worldCenter = localCenter.clone().applyMatrix4(model);
    const reference = projectCovariance(baked, worldCenter, view, 500, 500);

    // Identical screen covariance ⇒ identical ellipse, ±3σ quad extent, and
    // Gaussian falloff under non-uniform scale.
    // Relative tolerance: the baked path round-trips through Float32Array.
    const close = (actual: number, expected: number) =>
      expect(Math.abs(actual - expected)).toBeLessThan(1e-5 * (1 + Math.abs(expected)));
    close(folded.a, reference.a);
    close(folded.b, reference.b);
    close(folded.d, reference.d);
    close(Math.sqrt(folded.lambda1), Math.sqrt(reference.lambda1));
    close(Math.sqrt(folded.lambda2), Math.sqrt(reference.lambda2));
  });
});

describe('non-uniform scale: sort ordering and bounds', () => {
  it('the row-2 depth key orders splats exactly as true world-space camera depth', () => {
    const model = nonUniformModel();
    const view = cameraView();
    const modelView = view.clone().multiply(model);
    const m = modelView.elements;

    const locals = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(3, 0.2, -1),
      new THREE.Vector3(-2, 4, 0.5),
      new THREE.Vector3(0.1, -3, 2),
      new THREE.Vector3(-1, 1, -2.5),
    ];
    // The sorter's key: view z via modelView row 2 - linear in any A.
    const keyed = locals.map((p, i) => ({
      i,
      key: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
    }));
    // Ground truth: transform to world by the (non-uniform) model matrix, then
    // measure camera-space z with the rigid view.
    const truth = locals.map((p, i) => ({
      i,
      key: p.clone().applyMatrix4(model).applyMatrix4(view).z,
    }));
    const order = (xs: { i: number; key: number }[]) =>
      [...xs].sort((a, b) => a.key - b.key).map((x) => x.i);
    expect(order(keyed)).toEqual(order(truth));
    for (const k of keyed) expect(k.key).toBeCloseTo(truth[k.i]!.key, 6);
  });

  it('ComputeSorter depth bounds cover the scene under a scaled modelView (fixed)', () => {
    const compute = vi.fn();
    const renderer = { compute } as unknown as THREE.WebGPURenderer;
    const capacity = 256;
    const centersTexture = new THREE.DataTexture(
      new Float32Array(capacity * 4),
      capacity,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    const sorter = new ComputeSorter({
      renderer,
      capacity,
      centersTexture,
      dataTextureWidth: capacity,
      splatIndexAttribute: new THREE.StorageInstancedBufferAttribute(new Float32Array(capacity), 1),
      sourceIndexAttribute: new THREE.StorageBufferAttribute(new Uint32Array(capacity), 1),
    });
    try {
      const modelView = cameraView().multiply(nonUniformModel());
      const bounds = new THREE.Sphere(new THREE.Vector3(0.5, -1, 0.25), 3);
      sorter.sort(modelView, 32, bounds);
      const internals = sorter as unknown as {
        depthMin: { value: number };
        depthScale: { value: number };
      };
      const viewCenter = bounds.center.clone().applyMatrix4(modelView);
      // A local bounding sphere's exact view-depth extent is its radius times
      // the norm of modelView's depth row.
      const viewRadius = viewDepthRadius(modelView, bounds.radius);
      expect(viewRadius).toBeGreaterThan(0);
      expect(internals.depthMin.value).toBeCloseTo(viewCenter.z - viewRadius, 5);
      // 32 active splats round up to the sorter's minimum bucket count (2¹⁶).
      const buckets = 1 << 16;
      expect(internals.depthScale.value).toBeCloseTo((buckets - 1) / (2 * viewRadius), 4);
    } finally {
      sorter.dispose();
    }
  });
  it('ComputeSorter depth bounds cover hierarchy-induced shear', () => {
    const renderer = { compute: vi.fn() } as unknown as THREE.WebGPURenderer;
    const sorter = new ComputeSorter({ renderer, ...sorterInputs(256) });
    try {
      const modelView = hierarchyShearModelView();
      expect(viewDepthRadius(modelView, 1)).toBeGreaterThan(modelView.getMaxScaleOnAxis());
      expectDepthBounds(
        sorter,
        modelView,
        new THREE.Sphere(new THREE.Vector3(0.5, -1, 0.25), 3),
        (1 << 16) - 1,
      );
    } finally {
      sorter.dispose();
    }
  });

  it('RadixSorter depth bounds cover a non-uniformly scaled mesh', () => {
    const renderer = { compute: vi.fn() } as unknown as THREE.WebGPURenderer;
    const sorter = new RadixSorter({ renderer, ...sorterInputs(256) });
    try {
      expectDepthBounds(
        sorter,
        cameraView().multiply(nonUniformModel()),
        new THREE.Sphere(new THREE.Vector3(0.5, -1, 0.25), 3),
        (1 << 24) - 1,
      );
    } finally {
      sorter.dispose();
    }
  });
});

describe('non-uniform scale: spatial queries (fixed - world-distance ranking)', () => {
  const meshes: SplatMesh[] = [];
  afterEach(() => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
  });
  const track = (mesh: SplatMesh): SplatMesh => (meshes.push(mesh), mesh);

  function meshWith(localPositions: [number, number, number][]): SplatMesh {
    const count = localPositions.length;
    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4);
    const covariances = new Float32Array(count * 6);
    localPositions.forEach((p, i) => {
      positions.set(p, i * 3);
      colors[i * 4 + 3] = 255;
      writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
    });
    const data: SplatData = { count, positions, colors, covariances };
    return track(new SplatMesh(data));
  }

  it('queryNearest ranks by world distance under scale.set(2, 0.5, 1)', () => {
    // Local: A at (1,0,0) → world (2,0,0); B at (0,3,0) → world (0,1.5,0).
    // Local-distance ranking would pick A (1 < 3); world-correct is B (1.5 < 2).
    const mesh = meshWith([
      [1, 0, 0],
      [0, 3, 0],
    ]);
    mesh.scale.set(2, 0.5, 1);
    const hit = mesh.queryNearest(new THREE.Vector3(0, 0, 0), 2.5);
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(0, 6);
    expect(hit!.point.y).toBeCloseTo(1.5, 6);
    expect(hit!.distance).toBeCloseTo(1.5, 6);
  });

  it('queryNearest stays world-correct with rotation stacked on non-uniform scale', () => {
    const mesh = meshWith([
      [1, 0, 0],
      [0, 3, 0],
    ]);
    mesh.scale.set(2, 0.5, 1);
    mesh.rotation.z = Math.PI / 3;
    mesh.position.set(0.4, -0.1, 0.2);
    mesh.updateMatrixWorld(true);
    // Ground truth by brute force through the mesh's own world matrix.
    const worlds = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 3, 0)].map((p) =>
      p.applyMatrix4(mesh.matrixWorld),
    );
    const query = new THREE.Vector3(0, 0, 0);
    const expected = worlds.reduce((best, p) =>
      p.distanceTo(query) < best.distanceTo(query) ? p : best,
    );
    const hit = mesh.queryNearest(query, 10);
    expect(hit).not.toBeNull();
    expect(hit!.point.distanceTo(expected)).toBeLessThan(1e-6);
    expect(hit!.distance).toBeCloseTo(expected.distanceTo(query), 6);
  });

  it('queryNearest still honors the world radius as a hard cutoff', () => {
    const mesh = meshWith([[1, 0, 0]]);
    mesh.scale.set(2, 0.5, 1); // world distance 2
    expect(mesh.queryNearest(new THREE.Vector3(0, 0, 0), 1.9)).toBeNull();
    expect(mesh.queryNearest(new THREE.Vector3(0, 0, 0), 2.1)).not.toBeNull();
  });

  it('queryHeight gathers conservatively when an axis is compressed', () => {
    // Floor splat at local (0,-4,0) → world (0,-2,0) under scale.y = 0.5.
    // A gather radius divided by the *largest* axis (2) would miss it; the
    // min-axis gather reaches local distance 4 and finds it.
    const mesh = meshWith([[0, -4, 0]]);
    mesh.scale.set(2, 0.5, 2);
    const hit = mesh.queryHeight(new THREE.Vector3(0, 0, 0), 3);
    expect(hit).not.toBeNull();
    expect(hit!.point.y).toBeCloseTo(-2, 6);
    expect(hit!.drop).toBeCloseTo(2, 6);
    // The world-space maxDrop contract still holds.
    expect(mesh.queryHeight(new THREE.Vector3(0, 0, 0), 1.5)).toBeNull();
  });
});

describe('non-uniform scale: pick unproject (CPU contract)', () => {
  it('reconstructs a world point from view depth independent of any mesh transform', () => {
    const camera = new THREE.PerspectiveCamera(55, 1.5, 0.1, 100);
    camera.position.set(1, 2, 8);
    camera.lookAt(0, 0.5, 0);
    camera.updateMatrixWorld(true);
    // A world point a scaled mesh might rasterize; the unproject uses only the
    // camera (the pick pass renders the proxy with the mesh's full matrixWorld,
    // so depth is already measured for the scaled splats).
    const world = new THREE.Vector3(0.8, -0.3, 1.2);
    const view = world.clone().applyMatrix4(camera.matrixWorldInverse);
    const ndc = world.clone().project(camera);
    const out = new THREE.Vector3();
    const { point, distance } = unprojectViewDepth(ndc.x, ndc.y, -view.z, camera, out);
    expect(point.distanceTo(world)).toBeLessThan(1e-5);
    expect(distance).toBeCloseTo(world.distanceTo(camera.position), 5);
  });
});

describe('non-uniform scale: animated scale stays upload-free (pinned)', () => {
  function mockRenderer(): THREE.WebGPURenderer {
    return {
      compute: vi.fn(),
      copyTextureToTexture: vi.fn(),
      getDrawingBufferSize: (out: THREE.Vector2) => out.set(800, 600),
      backend: { isWebGPUBackend: true },
    } as unknown as THREE.WebGPURenderer;
  }

  function staticData(count: number): SplatData {
    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4);
    const covariances = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = i;
      colors[i * 4 + 3] = 255;
      writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
    }
    return { count, positions, colors, covariances };
  }

  it('a standalone mesh animates scale with no pool re-upload or active-list rebuild', () => {
    const renderer = mockRenderer();
    const mesh = new SplatMesh(staticData(8));
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    try {
      mesh.update(camera, renderer); // first frame: initial state established
      const copies = (renderer.copyTextureToTexture as ReturnType<typeof vi.fn>).mock.calls.length;
      const rebuild = vi.spyOn(
        mesh as unknown as { rebuildActiveList: () => void },
        'rebuildActiveList',
      );
      // A mock renderer never drains updateRanges; assert non-growth instead.
      const attr = (mesh as unknown as { sourceIndexAttribute: THREE.BufferAttribute })
        .sourceIndexAttribute as unknown as { updateRanges: unknown[] };
      const ranges = attr.updateRanges.length;
      for (let frame = 1; frame <= 5; frame++) {
        mesh.scale.set(1 + frame * 0.3, 1 / (1 + frame * 0.2), 1 + frame * 0.1);
        mesh.updateMatrixWorld(true);
        mesh.update(camera, renderer);
        const timings = (
          mesh as unknown as {
            getUpdateTimings(): { stagingTextureAllocations: number };
          }
        ).getUpdateTimings();
        // Scale flows only through the per-frame matrix uniforms: no staging
        // texture allocation, no pool copy, no new active-list update ranges.
        expect(timings.stagingTextureAllocations).toBe(0);
        expect(attr.updateRanges.length).toBe(ranges);
      }
      expect((renderer.copyTextureToTexture as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        copies,
      );
      expect(rebuild).not.toHaveBeenCalled();
    } finally {
      mesh.dispose();
    }
  });

  it('a unified source animating scale costs exactly one gather dispatch per frame', () => {
    const renderer = mockRenderer();
    const animated = new SplatMesh(staticData(2));
    const still = new SplatMesh(staticData(2));
    const unified = new UnifiedSplatMesh(renderer, 8);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    try {
      unified.addSource(animated);
      unified.addSource(still);
      unified.update(camera); // first frame gathers both
      const records = (
        unified as unknown as {
          sources: Array<{ source: SplatMesh; gather: { gather: (...args: unknown[]) => void } }>;
        }
      ).sources;
      const animatedRecord = records.find((r) => r.source === animated)!;
      const stillRecord = records.find((r) => r.source === still)!;
      const animatedGatherPipeline = animatedRecord.gather;
      const animatedGather = vi.spyOn(animatedRecord.gather, 'gather');
      const stillGather = vi.spyOn(stillRecord.gather, 'gather');
      for (let frame = 1; frame <= 4; frame++) {
        animated.scale.set(1 + frame * 0.25, 1 / (1 + frame * 0.25), 1);
        animated.updateMatrixWorld(true);
        unified.update(camera);
        // One regather for the moved source per frame - and nothing else: the
        // untouched source's slice is reused and no gather pipeline is rebuilt
        // (same rule as the modifier contract: uniform-style change = cheap,
        // graph change = rebuild).
        expect(animatedGather).toHaveBeenCalledTimes(frame);
        expect(stillGather).not.toHaveBeenCalled();
        expect(animatedRecord.gather).toBe(animatedGatherPipeline);
      }
    } finally {
      unified.dispose();
      animated.dispose();
      still.dispose();
    }
  });
});

describe('non-uniform scale: unified per-source bounds', () => {
  it('worldBoundsOf stays conservative for a non-uniformly scaled source', () => {
    const matrix = nonUniformModel();
    const center = new THREE.Vector3(1, -0.5, 2);
    const radius = 1.5;
    const out = new THREE.Sphere();
    worldBoundsOf([{ center, radius, matrix }], out);
    // Every surface point of the local sphere must land inside the world bound.
    for (let i = 0; i < 64; i++) {
      const theta = (i / 64) * Math.PI * 2;
      const phi = Math.acos((2 * ((i * 37) % 64)) / 64 - 1);
      const p = new THREE.Vector3(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
      )
        .add(center)
        .applyMatrix4(matrix);
      expect(out.containsPoint(p)).toBe(true);
    }
  });

  it('MergedSplatMesh bounds and worldBoundsOf agree on a non-uniformly scaled source', () => {
    // `computeSplatBounds` drives where a host places its effects, and
    // `worldBoundsOf` drives the sort's depth quantization. Both have to see
    // the same stretched extent, or effects land off the splats they should
    // cover - the one case where an SDF shape and the sort disagree silently.
    const matrix = nonUniformModel();
    const scene = new MergedSplatMesh({ capacity: 2048 });
    // A unit cube of splats, so the data-frame box is exactly [-1, 1]³.
    const count = 8;
    const positions = new Float32Array(count * 3);
    const covariances = new Float32Array(count * 6);
    const colors = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      positions.set([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1], i * 3);
      writeCovariance(covariances, i, 0.01, 0.01, 0.01, 1, 0, 0, 0);
      colors.set([255, 255, 255, 255], i * 4);
    }
    scene.addSource({ count, positions, colors, covariances }, matrix, { orientation: 'source' });

    const box = scene.computeSplatBounds();
    const sphere = new THREE.Sphere();
    worldBoundsOf([{ center: new THREE.Vector3(), radius: Math.sqrt(3), matrix }], sphere);
    // Every corner of the placed cube is inside both. `worldBoundsOf` is
    // deliberately conservative (a max-singular-value bound), so it encloses
    // the box rather than matching it exactly.
    for (let i = 0; i < count; i++) {
      const corner = new THREE.Vector3(i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1).applyMatrix4(
        matrix,
      );
      expect(box.containsPoint(corner)).toBe(true);
      expect(sphere.containsPoint(corner)).toBe(true);
    }
    // The ×2 x-scale must actually show up: an unplaced box would span 2 units.
    expect(box.max.x - box.min.x).toBeGreaterThan(2.5);
    scene.dispose();
  });

  it('worldBoundsOf encloses a sphere under hierarchy-induced shear', () => {
    const radius = 1;
    const matrix = hierarchyShearModel();
    const out = new THREE.Sphere();
    worldBoundsOf([{ center: new THREE.Vector3(), radius, matrix }], out);
    // This local direction rotates onto the parent's ×3 world-x axis. The old
    // maximum-column-length bound was √5 and missed this point at distance 3.
    const stretched = new THREE.Vector3(Math.SQRT1_2, -Math.SQRT1_2, 0).applyMatrix4(matrix);
    expect(stretched.length()).toBeCloseTo(3, 6);
    expect(out.containsPoint(stretched)).toBe(true);
  });
});
