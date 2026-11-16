import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { SkinnedSplatMesh, loadSplatGltf } from '../dynamic';
import { SplatMesh } from '../core/splat-mesh';
import { writeCovariance, type SplatData } from '../core/splat-data';
import {
  symmetricEigen,
  writeSplatGlb,
  type SplatGlbSkeleton,
} from '../../tools/splat-gltf/write-splat-glb';

/**
 * The `KHR_gaussian_splatting` glTF writer (`src/tools/splat-gltf`) against
 * `loadSplatGltf`: what goes in comes back, skinned to the same skeleton and
 * moved by the file's clips the way the writer's poses say.
 */

/** 3×4 row-major rigid matrix: rotation `angle` about z, then translation `t`. */
const rigid = (angle: number, t: [number, number, number]): number[] => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, -s, 0, t[0], s, c, 0, t[1], 0, 0, 1, t[2]];
};
const toMatrix4 = (m: ArrayLike<number>, bone: number): THREE.Matrix4 => {
  const o = bone * 12;
  const e = (i: number): number => Number(m[o + i]);
  return new THREE.Matrix4().set(
    e(0),
    e(1),
    e(2),
    e(3),
    e(4),
    e(5),
    e(6),
    e(7),
    e(8),
    e(9),
    e(10),
    e(11),
    0,
    0,
    0,
    1,
  );
};

/** Two bones, the second a child bent at y = 1, with splats up both. */
function fixture() {
  const count = 64;
  const positions = new Float32Array(count * 3);
  const covariances = new Float32Array(count * 6);
  const colors = new Uint8Array(count * 4);
  const indices = new Uint8Array(count * 2);
  const weights = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const y = (2 * i) / count;
    positions.set([0.1 * Math.sin(i), y, 0.1 * Math.cos(i)], i * 3);
    const q = [Math.cos(i), Math.sin(i), 0.3, -0.2];
    writeCovariance(covariances, i, 0.01 + i * 1e-4, 0.03, 0.002, q[0]!, q[1]!, q[2]!, q[3]!);
    colors.set([(i * 37) % 256, (i * 11) % 256, 200, 40 + i * 3], i * 4);
    indices.set([y < 1 ? 0 : 1, y < 1 ? 1 : 0], i * 2);
    const w = 0.5 + 0.5 * Math.min(Math.abs(y - 1) * 2, 1);
    weights.set([w, 1 - w], i * 2);
  }
  const data: SplatData = { count, positions, colors, covariances };
  const skeleton: SplatGlbSkeleton = {
    names: ['hip', 'knee.L'],
    parents: [-1, 0],
    world: [...rigid(0, [0, 0, 0]), ...rigid(0.2, [0, 1, 0])],
  };
  const bend = (k: number) => [
    ...rigid(0, [0, 0, 0.1 * k]),
    ...rigid(0.2 + 0.6 * k, [0, 1, 0.1 * k]),
  ];
  const times = [0, 0.5, 1];
  const poses = times.map((t) => bend(Math.sin(Math.PI * t)));
  return { data, skeleton, skin: { bonesPerSplat: 2 as const, indices, weights }, times, poses };
}

describe('splat glTF', () => {
  it('decomposes a covariance into scale and a proper rotation', () => {
    const c = new Float32Array(6);
    writeCovariance(c, 0, 0.5, 0.02, 0.1, 0.3, 0.6, -0.2, 0.7);
    const { values, vectors } = symmetricEigen(c);
    const back = new Float32Array(6);
    const r = new THREE.Matrix4().set(
      vectors[0]!,
      vectors[1]!,
      vectors[2]!,
      0,
      vectors[3]!,
      vectors[4]!,
      vectors[5]!,
      0,
      vectors[6]!,
      vectors[7]!,
      vectors[8]!,
      0,
      0,
      0,
      0,
      1,
    );
    expect(r.determinant()).toBeCloseTo(1, 6);
    const q = new THREE.Quaternion().setFromRotationMatrix(r);
    writeCovariance(
      back,
      0,
      ...(values.map(Math.sqrt) as [number, number, number]),
      q.w,
      q.x,
      q.y,
      q.z,
    );
    for (let k = 0; k < 6; k++) expect(back[k]).toBeCloseTo(c[k]!, 6);
  });

  it('round-trips splats, skin, skeleton and clips', async () => {
    const { data, skeleton, skin, times, poses } = fixture();
    const glb = writeSplatGlb({
      data,
      name: 'rig',
      skin,
      skeleton,
      animations: [
        { name: 'bend', times, poses, hints: { loop: 'once' } },
        { name: 'nod', times, poses, hints: { additive: true } },
      ],
    });
    expect(new TextDecoder().decode(glb.subarray(0, 4))).toBe('glTF');
    const loaded = await loadSplatGltf(glb.buffer as ArrayBuffer);

    expect(loaded.meshes).toHaveLength(1);
    const mesh = loaded.meshes[0] as SkinnedSplatMesh;
    expect(mesh).toBeInstanceOf(SkinnedSplatMesh);
    expect(mesh.bonesPerSplat).toBe(2);
    expect(mesh.skeleton?.bones.map((bone) => bone.name)).toEqual(['hip', 'kneeL']);
    expect(loaded.scene.getObjectsByProperty('isPoints', true)).toHaveLength(0);

    // The bind pose gives back the splats as written.
    loaded.scene.updateMatrixWorld(true);
    const rest = mesh.posedSplatData();
    for (let i = 0; i < data.count * 3; i++)
      expect(rest.positions[i]).toBeCloseTo(data.positions[i]!, 5);
    // snorm16 rotations: within a small fraction of the largest variance (0.03²).
    for (let i = 0; i < data.count * 6; i++) {
      expect(Math.abs(rest.covariances[i]! - data.covariances[i]!)).toBeLessThan(1e-5);
    }
    for (let i = 0; i < data.count * 4; i++) {
      expect(Math.abs(rest.colors[i]! - data.colors[i]!)).toBeLessThanOrEqual(1);
    }

    // Clips: names, hints, the additive one made additive.
    expect(loaded.animations.map((clip) => clip.name)).toEqual(['bend', 'nod']);
    expect(loaded.animations[0]!.userData.vlam).toEqual({ loop: 'once' });
    expect(loaded.animations[0]!.blendMode).toBe(THREE.NormalAnimationBlendMode);
    expect(loaded.animations[1]!.blendMode).toBe(THREE.AdditiveAnimationBlendMode);
    expect(loaded.animations[0]!.duration).toBeCloseTo(1);

    // Played halfway, the splats sit where the writer's pose puts them.
    const mixer = new THREE.AnimationMixer(loaded.scene);
    mixer.clipAction(loaded.animations[0]!).play();
    mixer.setTime(0.5);
    loaded.scene.updateMatrixWorld(true);
    const posed = mesh.posedSplatData();
    const skins = [0, 1].map((bone) =>
      toMatrix4(poses[1]!, bone).multiply(toMatrix4(skeleton.world, bone).invert()),
    );
    let worst = 0;
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    for (let i = 0; i < data.count; i++) {
      p.set(0, 0, 0);
      for (let k = 0; k < 2; k++) {
        const w = skin.weights[i * 2 + k]!;
        q.fromArray(data.positions, i * 3).applyMatrix4(skins[skin.indices[i * 2 + k]!]!);
        p.addScaledVector(q, w);
      }
      worst = Math.max(worst, p.distanceTo(q.fromArray(posed.positions, i * 3)));
    }
    // unorm8 weights: 1/510 of the spread between the two bones' targets.
    expect(worst).toBeLessThan(2e-3);
    // And it really moved.
    expect(
      Math.abs(posed.positions[data.count * 3 - 1]! - data.positions[data.count * 3 - 1]!),
    ).toBeGreaterThan(0.05);
  });

  it('converts a glTF the app parsed itself, and can leave skinning out', async () => {
    const { data, skeleton, skin, times, poses } = fixture();
    const glb = writeSplatGlb({
      data,
      skin,
      skeleton,
      animations: [{ name: 'nod', times, poses, hints: { additive: true } }],
    });
    const parsed = await new GLTFLoader().parseAsync(glb.buffer as ArrayBuffer, '');
    expect(parsed.scene.getObjectsByProperty('isPoints', true)).toHaveLength(1);
    const loaded = await loadSplatGltf(parsed, { skinning: false });
    // The app's own scene and clips, changed in place.
    expect(loaded.scene).toBe(parsed.scene);
    expect(loaded.animations[0]).toBe(parsed.animations[0]);
    expect(parsed.scene.getObjectsByProperty('isPoints', true)).toHaveLength(0);
    expect(loaded.meshes[0]).toBeInstanceOf(SplatMesh);
    expect(loaded.meshes[0]).not.toBeInstanceOf(SkinnedSplatMesh);
    // A second pass finds nothing left to convert and keeps the clip as it was.
    const tracks = loaded.animations[0]!.tracks.map((track) => Array.from(track.values));
    const again = await loadSplatGltf(parsed);
    expect(again.meshes).toEqual([]);
    expect(again.animations[0]!.tracks.map((track) => Array.from(track.values))).toEqual(tracks);
  });

  it('loads unskinned splats as a plain SplatMesh', async () => {
    const { data } = fixture();
    const loaded = await loadSplatGltf(writeSplatGlb({ data }).buffer as ArrayBuffer);
    expect(loaded.meshes).toHaveLength(1);
    expect(loaded.meshes[0]).toBeInstanceOf(SplatMesh);
    expect(loaded.meshes[0]).not.toBeInstanceOf(SkinnedSplatMesh);
    expect(loaded.animations).toEqual([]);
  });
});
