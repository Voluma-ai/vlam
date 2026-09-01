import * as THREE from 'three/webgpu';
import { bool, uniform, vec4 } from 'three/tsl';
import { SplatMesh, createSplatRenderer, type SplatData } from '../lib/core';
import { StreamedSplatMesh } from '../lib/streaming';
import { UnifiedSplatMesh, supportsUnifiedSplatMesh } from '../lib/unified';

const SIZE = 256;
const status = document.querySelector<HTMLDivElement>('#status');

function makeSource(color: readonly [number, number, number], z: number): SplatMesh {
  const data: SplatData = {
    count: 1,
    positions: new Float32Array([0, 0, z]),
    colors: new Uint8Array([...color, 255]),
    // Compact symmetric covariance: xx, xy, xz, yy, yz, zz.
    covariances: new Float32Array([0.04, 0, 0, 0.04, 0, 0.04]),
  };
  return new SplatMesh(data);
}

/**
 * Tiny StreamedSplatMesh without a network manifest - private ctor + one
 * appended range, same pattern as the streamed unit tests. `computeDesiredRuns`
 * stays empty so the scheduler never evicts the hand-appended splat.
 */
function makeStreamedSource(
  color: readonly [number, number, number],
  z: number,
): StreamedSplatMesh {
  const capacity = 8;
  const scene = {
    source: {
      budget: capacity,
      lodBaseDistance: 10,
      lodMultiplier: 2,
      computeDesiredRuns: () => [],
      coarsestRunsFor: () => [],
    },
    chunkUrls: [] as string[],
    chunkKind: 'file' as const,
    bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
    pinnedFiles: new Set<number>(),
    maxResidentSplats: capacity,
    minimumCoverageSplats: 0,
  };
  const Ctor = StreamedSplatMesh as unknown as new (
    scene: unknown,
    budget: number,
    capacity: number,
    options: object,
  ) => StreamedSplatMesh;
  const mesh = new Ctor(scene, capacity, capacity, {});
  mesh.appendRange({
    count: 1,
    positions: new Float32Array([0, 0, z]),
    colors: new Uint8Array([...color, 255]),
    covariances: new Float32Array([0.04, 0, 0, 0.04, 0, 0.04]),
  });
  return mesh;
}

/**
 * One splat with band-1 SH whose z lobe dominates red - camera ±Z should
 * tint differently, including after a non-identity source rotation.
 */
function makeShSource(): SplatMesh {
  const bands = 1;
  const coeffs = 3;
  const paletteWidth = 64 * coeffs;
  const palette = new Float32Array(paletteWidth * 4);
  // Entry 0, coefficient 1 → band1 z term (see splat-mesh-material SH eval).
  const texel = (0 * coeffs + 1) * 4;
  palette[texel] = 2.5;
  return new SplatMesh({
    count: 1,
    positions: new Float32Array([0, 0, 0]),
    colors: new Uint8Array([48, 48, 48, 255]),
    covariances: new Float32Array([0.04, 0, 0, 0.04, 0, 0.04]),
    sh: {
      bands,
      labels: new Uint32Array([0]),
      palette,
      paletteWidth,
      paletteHeight: 1,
    },
  });
}

async function sampleScene(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  target: THREE.RenderTarget,
  unified: UnifiedSplatMesh,
  z: number,
  x = SIZE >> 1,
  y = SIZE >> 1,
): Promise<readonly [number, number, number, number]> {
  camera.position.set(0, 0, z);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  unified.update(camera);
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  const pixel = await renderer.readRenderTargetPixelsAsync(target, x, y, 1, 1);
  if (pixel.length < 4)
    throw new Error('Unified renderer GPU harness received an incomplete pixel.');
  return [pixel[0] as number, pixel[1] as number, pixel[2] as number, pixel[3] as number];
}

function makeLodSource(encodedAlpha: number, lodAlpha: boolean): SplatMesh {
  const data: SplatData = {
    count: 1,
    positions: new Float32Array([0, 0, 0]),
    colors: new Uint8Array([255, 0, 0, Math.round(encodedAlpha * 255)]),
    covariances: new Float32Array([0.12, 0, 0, 0.12, 0, 0.12]),
  };
  return new SplatMesh(data, { lodAlpha });
}

function shapeRatio(
  center: readonly [number, number, number, number],
  edge: readonly [number, number, number, number],
): number {
  return center[0] <= 0 ? 0 : edge[0] / center[0];
}

function ratiosStable(ratios: number[], tolerance = 0.08): boolean {
  const first = ratios[0];
  if (first === undefined || first <= 0) return false;
  return ratios.every((ratio) => Math.abs(ratio - first) <= tolerance);
}

function monotonicallyDecreasing(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const next = values[i];
    if (prev === undefined || next === undefined || next >= prev) return false;
  }
  return true;
}

async function run(): Promise<void> {
  // requireWebGpu: the harness's pixel gates are meaningless on WebGL2, and an
  // owned device keeps the backend in core mode (three requests none of the
  // adapter's features on its own path, so it lands in compatibility mode).
  const renderer = await createSplatRenderer({ antialias: false, requireWebGpu: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 1);
  document.body.append(renderer.domElement);
  await renderer.init();
  if (!supportsUnifiedSplatMesh(renderer)) {
    throw new Error('Unified renderer GPU harness requires a WebGPU backend.');
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
  const target = new THREE.RenderTarget(SIZE, SIZE, { type: THREE.UnsignedByteType });
  const red = makeSource([255, 0, 0], 0.1);
  const blue = makeSource([0, 0, 255], -0.1);
  const unified = new UnifiedSplatMesh(renderer, 2);
  unified.addSource(red, { opacity: 0.6 });
  unified.addSource(blue, { opacity: 0.6 });
  scene.add(unified);

  const sample = (z: number, x = SIZE >> 1) =>
    sampleScene(renderer, scene, camera, target, unified, z, x);

  // Overlapping static sources + camera-order reversal.
  const fromPositiveZ = await sample(3);
  const debugState = unified as unknown as {
    workBuffer: { centers: THREE.StorageBufferAttribute };
  };
  const gatheredCenters = Array.from(
    new Float32Array(await renderer.getArrayBufferAsync(debugState.workBuffer.centers)),
  ).slice(0, 8);
  const fromNegativeZ = await sample(-3);

  // Whole-source visibility.
  unified.setSourceVisible(blue, false);
  const blueHidden = await sample(3);
  unified.setSourceVisible(blue, true);

  // Live source movement.
  blue.position.x = 0.25;
  blue.updateMatrixWorld();
  const movedPixel = await sample(3, (SIZE >> 1) + 26);
  blue.position.x = 0;
  blue.updateMatrixWorld();

  // Whole-source opacity.
  unified.setSourceOpacity(blue, 0);
  const blueFaded = await sample(3);
  unified.setSourceOpacity(blue, 0.6);

  // Hide/show after another source overwrote the same work slice.
  unified.setSourceVisible(red, false);
  await sample(3);
  unified.setSourceVisible(red, true);
  const afterHideShow = await sample(3);
  const centersAfterHideShow = Array.from(
    new Float32Array(await renderer.getArrayBufferAsync(debugState.workBuffer.centers)),
  ).slice(0, 8);

  // One modifier-hidden splat (stable slot, drawable=0 in center.w).
  unified.removeSource(red);
  unified.removeSource(blue);
  const hideAll = makeSource([0, 255, 0], 0);
  hideAll.modifiers = [() => ({ visible: bool(false) })];
  unified.addSource(hideAll);
  const modifierHidden = await sample(3);
  const centersWithHidden = Array.from(
    new Float32Array(await renderer.getArrayBufferAsync(debugState.workBuffer.centers)),
  ).slice(0, 4);
  const modifierSlotKept = (unified.geometry as THREE.InstancedBufferGeometry).instanceCount === 1;
  unified.removeSource(hideAll);

  // Dynamic-capacity source whose active range changes.
  const dynamic = new SplatMesh({ capacity: 8 });
  const range = dynamic.appendRange({
    count: 1,
    positions: new Float32Array([0, 0, 0.05]),
    colors: new Uint8Array([255, 255, 0, 255]),
    covariances: new Float32Array([0.04, 0, 0, 0.04, 0, 0.04]),
  });
  unified.addSource(dynamic);
  const dynamicPresent = await sample(3);
  const dynamicCountPresent = (unified.geometry as THREE.InstancedBufferGeometry).instanceCount;
  dynamic.removeRange(range);
  const dynamicRemoved = await sample(3);
  const dynamicCountRemoved = (unified.geometry as THREE.InstancedBufferGeometry).instanceCount;
  unified.removeSource(dynamic);
  unified.addSource(red, { opacity: 0.6 });
  unified.addSource(blue, { opacity: 0.6 });

  // Overflow eviction and later re-admission.
  const tiny = new UnifiedSplatMesh(renderer, 1);
  const low = makeSource([255, 0, 0], 0.1);
  const high = makeSource([0, 0, 255], -0.1);
  tiny.addSource(low, { priority: 0 });
  tiny.addSource(high, { priority: 1 });
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  tiny.update(camera);
  const overflowDropped =
    tiny.droppedSourceCount === 1 &&
    (tiny.geometry as THREE.InstancedBufferGeometry).instanceCount === 1;
  tiny.removeSource(high);
  tiny.update(camera);
  const overflowReadmitted =
    tiny.droppedSourceCount === 0 &&
    (tiny.geometry as THREE.InstancedBufferGeometry).instanceCount === 1;
  tiny.dispose();
  low.dispose();
  high.dispose();

  // Rotated source still gathers and draws (matrix world centers).
  const rotated = makeSource([128, 128, 128], 0);
  rotated.rotation.y = Math.PI / 2;
  rotated.updateMatrixWorld();
  const rotatedUnified = new UnifiedSplatMesh(renderer, 1);
  rotatedUnified.addSource(rotated);
  const rotatedScene = new THREE.Scene();
  rotatedScene.add(rotatedUnified);
  const rotatedPixel = await sampleScene(renderer, rotatedScene, camera, target, rotatedUnified, 3);
  rotatedUnified.dispose();
  rotated.dispose();

  // Streamed + static overlap: order must flip with camera (not "static always front").
  const streamed = makeStreamedSource([255, 0, 0], 0.1);
  const staticOverStreamed = makeSource([0, 0, 255], -0.1);
  const streamedUnified = new UnifiedSplatMesh(renderer, 2);
  streamedUnified.addSource(streamed, { opacity: 0.6 });
  streamedUnified.addSource(staticOverStreamed, { opacity: 0.6 });
  const streamedScene = new THREE.Scene();
  streamedScene.add(streamedUnified);
  const streamedFromPos = await sampleScene(
    renderer,
    streamedScene,
    camera,
    target,
    streamedUnified,
    3,
  );
  const streamedFromNeg = await sampleScene(
    renderer,
    streamedScene,
    camera,
    target,
    streamedUnified,
    -3,
  );
  const streamedFlipsOrder =
    streamedFromPos[0] > streamedFromPos[2] && streamedFromNeg[2] > streamedFromNeg[0];
  streamedUnified.dispose();
  streamed.dispose();
  staticOverStreamed.dispose();

  // SH under opposite views + rotated source (unified SH direction transform).
  const shMesh = makeShSource();
  const shUnified = new UnifiedSplatMesh(renderer, 1);
  shUnified.addSource(shMesh);
  const shScene = new THREE.Scene();
  shScene.add(shUnified);
  const shFromPos = await sampleScene(renderer, shScene, camera, target, shUnified, 3);
  const shFromNeg = await sampleScene(renderer, shScene, camera, target, shUnified, -3);
  shMesh.rotation.y = Math.PI / 2;
  shMesh.updateMatrixWorld();
  const shRotated = await sampleScene(renderer, shScene, camera, target, shUnified, 3);
  const shViewDependent = Math.abs(shFromPos[0] - shFromNeg[0]) > 20;
  const shUnderRotation = shRotated.some((c) => c > 0);
  shUnified.dispose();
  shMesh.dispose();

  const fades = [1, 0.75, 0.5, 0.25] as const;
  const mid = SIZE >> 1;
  const edgeX = mid + 12;
  const fadeScene = new THREE.Scene();
  const mergedMesh = makeLodSource(0.8, true);
  const mergedUnified = new UnifiedSplatMesh(renderer, 1);
  mergedUnified.addSource(mergedMesh);
  fadeScene.add(mergedUnified);
  const mergedCenters: number[] = [];
  const mergedRatios: number[] = [];
  const mergedStoredAlpha: number[] = [];
  for (const opacity of fades) {
    mergedUnified.setSourceOpacity(mergedMesh, opacity);
    const centerPx = await sampleScene(renderer, fadeScene, camera, target, mergedUnified, 3);
    const edgePx = await sampleScene(renderer, fadeScene, camera, target, mergedUnified, 3, edgeX);
    mergedCenters.push(centerPx[0]);
    mergedRatios.push(shapeRatio(centerPx, edgePx));
    const colors = new Float32Array(
      await renderer.getArrayBufferAsync(
        (mergedUnified as unknown as { workBuffer: { colors: THREE.StorageBufferAttribute } })
          .workBuffer.colors,
      ),
    );
    mergedStoredAlpha.push(colors[3] ?? 0);
  }
  const mergedLodStable =
    ratiosStable(mergedRatios) &&
    monotonicallyDecreasing(mergedCenters) &&
    mergedStoredAlpha.every((alpha) => Math.abs(alpha - 1.6) < 0.05);
  mergedUnified.dispose();
  mergedMesh.dispose();

  const leafMesh = makeLodSource(0.35, true);
  const leafUnified = new UnifiedSplatMesh(renderer, 1);
  leafUnified.addSource(leafMesh);
  const leafScene = new THREE.Scene();
  leafScene.add(leafUnified);
  const leafCenters: number[] = [];
  const leafRatios: number[] = [];
  for (const opacity of fades) {
    leafUnified.setSourceOpacity(leafMesh, opacity);
    const centerPx = await sampleScene(renderer, leafScene, camera, target, leafUnified, 3);
    const edgePx = await sampleScene(renderer, leafScene, camera, target, leafUnified, 3, edgeX);
    leafCenters.push(centerPx[0]);
    leafRatios.push(shapeRatio(centerPx, edgePx));
  }
  const leafLodStable = ratiosStable(leafRatios) && monotonicallyDecreasing(leafCenters);
  leafUnified.dispose();
  leafMesh.dispose();

  const standaloneMesh = makeLodSource(0.8, true);
  const fadeUniform = uniform(1);
  const fadeValue = fadeUniform as unknown as { value: number };
  standaloneMesh.modifiers = [
    (ctx) => ({ color: vec4(ctx.color.rgb, ctx.color.a.mul(fadeUniform)) }),
  ];
  const standaloneScene = new THREE.Scene();
  standaloneScene.add(standaloneMesh);
  const standaloneCenters: number[] = [];
  const standaloneRatios: number[] = [];
  for (const opacity of fades) {
    fadeValue.value = opacity;
    camera.position.set(0, 0, 3);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    standaloneMesh.update(camera, renderer);
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(standaloneScene, camera);
    renderer.setRenderTarget(null);
    const centerPixel = await renderer.readRenderTargetPixelsAsync(target, mid, mid, 1, 1);
    const edgePixel = await renderer.readRenderTargetPixelsAsync(target, edgeX, mid, 1, 1);
    const centerPx = [
      centerPixel[0] as number,
      centerPixel[1] as number,
      centerPixel[2] as number,
      centerPixel[3] as number,
    ] as const;
    const edgePx = [
      edgePixel[0] as number,
      edgePixel[1] as number,
      edgePixel[2] as number,
      edgePixel[3] as number,
    ] as const;
    standaloneCenters.push(centerPx[0]);
    standaloneRatios.push(shapeRatio(centerPx, edgePx));
  }
  const standaloneLodStable =
    ratiosStable(standaloneRatios) && monotonicallyDecreasing(standaloneCenters);
  standaloneMesh.dispose();

  const countingFades = [1, 0.75, 0.5, 0.25, 0] as const;
  const overlapMerged = makeLodSource(0.8, true);
  overlapMerged.position.z = 0.12;
  overlapMerged.updateMatrixWorld();
  const overlapLeaf = makeLodSource(0.35, true);
  overlapLeaf.position.z = -0.12;
  overlapLeaf.updateMatrixWorld();
  const overlapUnified = new UnifiedSplatMesh(renderer, 2, { sortStrategy: 'counting' });
  overlapUnified.addSource(overlapMerged);
  overlapUnified.addSource(overlapLeaf);
  const overlapScene = new THREE.Scene();
  overlapScene.add(overlapUnified);
  const overlapFromPos = await sampleScene(renderer, overlapScene, camera, target, overlapUnified, 3);
  const overlapFromNeg = await sampleScene(renderer, overlapScene, camera, target, overlapUnified, -3);
  const overlapCentersW: number[] = [];
  const overlapColorsA: number[] = [];
  const overlapRatios: number[] = [];
  for (const opacity of countingFades) {
    overlapUnified.setSourceOpacity(overlapMerged, opacity);
    overlapUnified.setSourceOpacity(overlapLeaf, opacity);
    const centerPx = await sampleScene(renderer, overlapScene, camera, target, overlapUnified, 3);
    const edgePx = await sampleScene(renderer, overlapScene, camera, target, overlapUnified, 3, edgeX);
    if (opacity > 0) overlapRatios.push(shapeRatio(centerPx, edgePx));
    const work = overlapUnified as unknown as {
      workBuffer: { centers: THREE.StorageBufferAttribute; colors: THREE.StorageBufferAttribute };
    };
    const centers = new Float32Array(await renderer.getArrayBufferAsync(work.workBuffer.centers));
    const colors = new Float32Array(await renderer.getArrayBufferAsync(work.workBuffer.colors));
    overlapCentersW.push(centers[3] ?? -1, centers[7] ?? -1);
    overlapColorsA.push(colors[3] ?? -1, colors[7] ?? -1);
  }
  const overlapCountingStable =
    overlapFromPos.some((c) => c > 0) &&
    overlapFromNeg.some((c) => c > 0) &&
    ratiosStable(overlapRatios, 0.12) &&
    overlapColorsA.filter((alpha) => Math.abs(alpha - 1.6) < 0.08).length === countingFades.length &&
    overlapColorsA.filter((alpha) => Math.abs(alpha - 0.7) < 0.08).length === countingFades.length &&
    countingFades.every(
      (opacity, index) =>
        Math.abs((overlapCentersW[index * 2] ?? -1) - opacity) < 0.05 &&
        Math.abs((overlapCentersW[index * 2 + 1] ?? -1) - opacity) < 0.05,
    );
  overlapUnified.dispose();
  overlapMerged.dispose();
  overlapLeaf.dispose();

  const result = {
    fromPositiveZ: [...fromPositiveZ],
    fromNegativeZ: [...fromNegativeZ],
    blueHidden: [...blueHidden],
    blueFaded: [...blueFaded],
    afterHideShow: [...afterHideShow],
    gatheredCenters,
    centersAfterHideShow,
    centersWithHidden,
    modifierHidden: [...modifierHidden],
    dynamicPresent: [...dynamicPresent],
    dynamicRemoved: [...dynamicRemoved],
    dynamicCountPresent,
    dynamicCountRemoved,
    rotatedPixel: [...rotatedPixel],
    streamedFromPos: [...streamedFromPos],
    streamedFromNeg: [...streamedFromNeg],
    shFromPos: [...shFromPos],
    shFromNeg: [...shFromNeg],
    shRotated: [...shRotated],
    instanceCount: (unified.geometry as THREE.InstancedBufferGeometry).instanceCount,
    flipsOrder: fromPositiveZ[0] > fromPositiveZ[2] && fromNegativeZ[2] > fromNegativeZ[0],
    hidesSource: blueHidden[0] > 0 && blueHidden[2] === 0,
    fadesSource: blueFaded[0] > 0 && blueFaded[2] === 0,
    movedPixel: [...movedPixel],
    movedSource: movedPixel[2] > movedPixel[0],
    hideShowRestored: afterHideShow[0] > 0 && afterHideShow[2] > 0,
    modifierCollapsed: modifierSlotKept && centersWithHidden[3] === 0 && modifierHidden[1] === 0,
    dynamicFollowsCut:
      dynamicCountPresent === 1 && dynamicCountRemoved === 0 && dynamicPresent[0] > 0,
    overflowEviction: overflowDropped && overflowReadmitted,
    rotatedSource: rotatedPixel.some((c) => c > 0),
    streamedStaticFlipsOrder: streamedFlipsOrder,
    shViewDependent,
    shUnderRotation,
    mergedLodStable,
    leafLodStable,
    standaloneLodStable,
    overlapCountingStable,
    directCountingStable: standaloneLodStable,
    mergedRatios,
    leafRatios,
    standaloneRatios,
    overlapRatios,
    overlapCentersW,
    overlapColorsA,
  };
  Object.assign(window, { __unifiedHarness: result });
  if (status) status.textContent = JSON.stringify(result, null, 2);
  const required = [
    result.flipsOrder,
    result.hidesSource,
    result.fadesSource,
    result.movedSource,
    result.hideShowRestored,
    result.modifierCollapsed,
    result.dynamicFollowsCut,
    result.overflowEviction,
    result.rotatedSource,
    result.streamedStaticFlipsOrder,
    result.shViewDependent,
    result.shUnderRotation,
    result.mergedLodStable,
    result.leafLodStable,
    result.standaloneLodStable,
    result.overlapCountingStable,
    result.directCountingStable,
  ];
  if (required.some((ok) => !ok)) {
    throw new Error(`Unified renderer GPU harness failed: ${JSON.stringify(result)}`);
  }
}

void run().catch((error: unknown) => {
  if (status)
    status.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(error);
});
