// Guide sample: docs/guide/dynamic-splats.md - rigging a static splat in
// code: with the skin of a rigged proxy mesh, or with a skin and a skeleton
// computed from where the splats sit.
// Experimental: `@voluma/vlam/dynamic`.
import * as THREE from 'three/webgpu';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { SplatData } from '@voluma/vlam';
import { SkinnedSplatMesh, computeSplatSkinWeights } from '@voluma/vlam/dynamic';

/**
 * A scan animated by a glTF rig: a low-poly `SkinnedMesh` in the splat's
 * frame, its skeleton and its clips. Each splat takes the bones of the proxy
 * vertex nearest it.
 */
export function rigFromProxy(splats: SplatData, gltf: GLTF, splatToProxy?: THREE.Matrix4) {
  const proxy = gltf.scene.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
  proxy.visible = false;
  const mesh = new SkinnedSplatMesh(splats, {
    // `splatToProxy` when the scan and the proxy were not made in the same frame.
    skin: computeSplatSkinWeights(splats, proxy, { bonesPerSplat: 2, splatToProxy }),
  });
  proxy.add(mesh); // the proxy's frame is the bind space
  mesh.bind(proxy.skeleton, proxy.bindMatrix);

  const mixer = new THREE.AnimationMixer(gltf.scene);
  if (gltf.animations[0]) mixer.clipAction(gltf.animations[0]).play();
  return { mesh, mixer };
}

/**
 * A splat rigged without a proxy: a chain of bones up the data's Y axis, each
 * splat weighted between the two bones it sits between, so the splat bends
 * instead of tearing. `swayChain` below animates it.
 */
export function rigAsChain(splats: SplatData, boneCount = 4) {
  // The splat's extent along the chain.
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < splats.count; i++) {
    const y = splats.positions[i * 3 + 1]!;
    low = Math.min(low, y);
    high = Math.max(high, y);
  }
  const step = (high - low) / boneCount || 1;

  // The skin: two bone indices and two weights per splat.
  const indices = new Uint16Array(splats.count * 2);
  const weights = new Float32Array(splats.count * 2);
  for (let i = 0; i < splats.count; i++) {
    const along = (splats.positions[i * 3 + 1]! - low) / step; // 0 … boneCount
    const bone = Math.min(Math.floor(along), boneCount - 1);
    const next = Math.min(bone + 1, boneCount - 1);
    const t = Math.min(Math.max(along - bone, 0), 1);
    indices.set([bone, next], i * 2);
    weights.set([1 - t, t], i * 2);
  }

  // The skeleton, in the data's own axes (the mesh applies no upright
  // correction): each bone at the joint it turns about, parented to the last.
  const bones = Array.from({ length: boneCount }, (_, index) => {
    const bone = new THREE.Bone();
    bone.name = `bone${index}`;
    bone.position.y = index === 0 ? low : step;
    return bone;
  });
  for (let i = 1; i < boneCount; i++) bones[i - 1]!.add(bones[i]!);

  const mesh = new SkinnedSplatMesh(splats, { skin: { bonesPerSplat: 2, indices, weights } });
  // The bones live under the mesh, so binding without a matrix makes the
  // current pose the bind pose, as THREE.SkinnedMesh.bind does.
  mesh.add(bones[0]!);
  mesh.bind(new THREE.Skeleton(bones));
  return { mesh, bones };
}

/** A looping clip for {@link rigAsChain}: keyframe tracks on the bones, as a glTF carries them. */
export function swayChain(mesh: SkinnedSplatMesh, bones: THREE.Bone[], seconds = 2) {
  const times = Array.from({ length: 31 }, (_, i) => (i / 30) * seconds);
  const axis = new THREE.Vector3(0, 0, 1);
  const tracks = bones.slice(1).map((bone, index) => {
    const values = times.flatMap((t) =>
      new THREE.Quaternion()
        .setFromAxisAngle(axis, 0.2 * Math.sin((2 * Math.PI * t) / seconds - index))
        .toArray(),
    );
    return new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values);
  });
  const mixer = new THREE.AnimationMixer(mesh);
  mixer.clipAction(new THREE.AnimationClip('sway', seconds, tracks)).play();
  // Per frame: mixer.update(dt); mesh.update(camera, renderer); renderer.render(…).
  return mixer;
}
