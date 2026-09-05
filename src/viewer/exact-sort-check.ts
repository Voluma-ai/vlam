import * as THREE from 'three/webgpu';
import { MergedSplatMesh, type SplatData } from '../lib/core';

/** GPU regression for exact global ordering with live per-source placement. */
export async function verifyExactMergedSort(renderer: THREE.WebGPURenderer) {
  const count = 2051; // Cross radix workgroups and leave a partial final group.
  const data = (color: readonly [number, number, number]): SplatData => {
    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 4);
    const covariances = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) {
      // Repeated depths exercise stable ties across radix workgroups.
      // Keep the non-probe splats outside the center pixel.
      positions.set([i === 0 ? 0 : 2, 0, (i % 13) / 16], i * 3);
      colors.set([...color, 160], i * 4);
      covariances.set([0.01, 0, 0, 0.01, 0, 0.01], i * 6);
    }
    return { count, positions, colors, covariances };
  };
  const redData = data([255, 0, 0]);
  const blueData = data([0, 0, 255]);
  const mesh = new MergedSplatMesh({
    capacity: 8192,
    sortStrategy: 'exact',
    sortMetric: 'depth',
    sortIntervalMs: 0,
  });
  const transforms = [
    new THREE.Matrix4().makeTranslation(0, 0, 0.25),
    new THREE.Matrix4().makeTranslation(0, 0, -0.25),
  ];
  const red = mesh.addSource(redData, transforms[0], { orientation: 'source' });
  const blue = mesh.addSource(blueData, transforms[1], { orientation: 'source' });
  const state = mesh as unknown as {
    radixSorterLoad: Promise<void>;
    sorter: { kind: string; exactDepth: boolean };
    sourceIndexAttribute: THREE.StorageBufferAttribute;
    splatIndexAttribute: THREE.StorageInstancedBufferAttribute;
  };
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  const target = new THREE.RenderTarget(256, 256, { type: THREE.UnsignedByteType });
  const samples: Array<{ pose: string; count: number; pixel: number[]; stable: boolean }> = [];
  try {
    await state.radixSorterLoad;
    const sample = async (pose: string, cameraZ: number, blueVisible = true) => {
      camera.position.set(0, 0, cameraZ);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      mesh.update(camera, renderer);
      if (
        state.sorter.kind !== 'radix' ||
        state.sorter.exactDepth !== (mesh.sortStrategy === 'exact')
      ) {
        throw new Error('Merged scene did not select the requested radix sorting.');
      }
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      const activeCount = mesh.activeSplatCount;
      const input = new Uint32Array(
        await renderer.getArrayBufferAsync(state.sourceIndexAttribute),
      ).slice(0, activeCount);
      const output = new Float32Array(
        await renderer.getArrayBufferAsync(state.splatIndexAttribute),
      ).slice(0, activeCount);
      // A 2051-element source takes two 2048-wide pool rows. Compare against
      // the known source data and placements, not GPU-generated sort keys.
      const depth = (index: number): number => {
        const source = index < 4096 ? 0 : 1;
        const local = index - source * 4096;
        const point = new THREE.Vector3().fromArray(
          source === 0 ? redData.positions : blueData.positions,
          local * 3,
        );
        point.applyMatrix4(transforms[source]!).applyMatrix4(mesh.matrixWorld);
        return Math.fround(point.applyMatrix4(camera.matrixWorldInverse).z);
      };
      const expected = Array.from(input).sort((a, b) => depth(a) - depth(b));
      const stable =
        output.length === count * (blueVisible ? 2 : 1) &&
        new Set(output).size === output.length &&
        output.every((index, i) => index === expected[i]);
      if (!stable) throw new Error(`Exact merged permutation/depth/tie check failed: ${pose}`);
      const pixel = Array.from(await renderer.readRenderTargetPixelsAsync(target, 128, 128, 1, 1));
      samples.push({ pose, count: activeCount, pixel, stable });
      renderer.render(scene, camera);
      return pixel;
    };
    const front = await sample('front', 3);
    const back = await sample('back', -3);
    transforms[1]!.makeTranslation(0, 0, 0.5);
    mesh.setSourceTransform(blue, transforms[1]!);
    const moved = await sample('source moved', 3);
    mesh.setSourceTransform(red, transforms[0]!); // force an identical re-sort
    await sample('identical sort', 3);
    // Exercise HD → SD → HD on the same combined pool and stationary camera.
    await mesh.setSortStrategy('counting');
    mesh.update(camera, renderer);
    if (state.sorter.kind !== 'counting') throw new Error('SD did not select counting.');
    await mesh.setSortStrategy('radix');
    const switched = await sample('radix after SD', 3);
    const liveSwitch = switched.every((value, index) => value === moved[index]);
    await mesh.setSortStrategy('exact');
    await sample('exact after radix', 3);
    transforms[1]!.makeRotationY(Math.PI / 2).scale(new THREE.Vector3(2, 1, 0.5));
    transforms[1]!.setPosition(0, 0, 0.5);
    mesh.setSourceTransform(blue, transforms[1]!);
    await sample('source rotated and scaled', 3);
    mesh.removeSource(blue);
    const removed = await sample('source removed', 3, false);
    const flipsOrder = front[0]! > front[2]! && back[2]! > back[0]!;
    const movedSource = moved[2]! > moved[0]!;
    const removedSource = removed[0]! > 0 && removed[2] === 0;
    return {
      passed: flipsOrder && movedSource && removedSource && liveSwitch,
      liveSwitch,
      flipsOrder,
      movedSource,
      removedSource,
      samples,
    };
  } finally {
    renderer.setRenderTarget(null);
    target.dispose();
    mesh.dispose();
  }
}
