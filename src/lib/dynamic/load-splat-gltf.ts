/**
 * {@link loadSplatGltf}: Gaussian splats from a glTF under the ratified
 * `KHR_gaussian_splatting` extension, skinned and animated through glTF's own
 * skins and animations.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { SplatMesh } from '../core/splat-mesh';
import { SH_C0, writeCovariance, type SplatData } from '../core/splat-data';
import type { SplatMeshOptions } from '../core/splat-mesh-types';
import { SkinnedSplatMesh, type SplatSkinData } from './skinned-splat-mesh';

const EXTENSION = 'KHR_gaussian_splatting';
/** GLTFLoader keeps attributes it does not know under their lowercased names. */
const ATTRIBUTE = {
  rotation: `${EXTENSION}:ROTATION`.toLowerCase(),
  scale: `${EXTENSION}:SCALE`.toLowerCase(),
  opacity: `${EXTENSION}:OPACITY`.toLowerCase(),
  sh0: `${EXTENSION}:SH_DEGREE_0_COEF_0`.toLowerCase(),
} as const;

/**
 * Playback hints a clip may carry in its glTF `extras.vlam` (kept on
 * `clip.userData.vlam`): how the clip is meant to be played.
 *
 * @experimental
 */
export interface SplatGltfClipHints {
  /** `'repeat'` (an `AnimationAction`'s default) or `'once'` (`LoopOnce`). */
  readonly loop?: 'repeat' | 'once';
  /** With `loop: 'repeat'`, how many times. */
  readonly repetitions?: number;
  /** Layered on top of other clips; the loader already made the clip additive. */
  readonly additive?: boolean;
}

/**
 * Options of {@link loadSplatGltf}: those of the splat meshes it makes, and
 * the glTF loader to parse with.
 *
 * @experimental
 */
export interface LoadSplatGltfOptions extends SplatMeshOptions {
  /**
   * A configured `GLTFLoader` (a `LoadingManager`, a meshopt decoder for
   * `EXT_meshopt_compression`); a plain one by default.
   */
  readonly loader?: GLTFLoader;
  /**
   * Skin the splats of skinned primitives (default `true`). With `false` they
   * load as plain `SplatMesh`es in the bind pose, for a draw path that cannot
   * run the skin modifier (a pooled WebGL2 unified draw).
   */
  readonly skinning?: boolean;
}

/**
 * A loaded splat glTF.
 *
 * @experimental
 */
export interface SplatGltf {
  /** The glTF's scene, its splat primitives replaced by {@link meshes}. */
  readonly scene: THREE.Group;
  /**
   * The splat meshes, in the order of the file's primitives:
   * {@link SkinnedSplatMesh}es bound to their skeleton where the file skins
   * them, plain `SplatMesh`es otherwise.
   */
  readonly meshes: SplatMesh[];
  /**
   * The file's animations, for an `AnimationMixer` rooted at {@link scene}.
   * Clips flagged additive are already additive; hints are on `userData.vlam`.
   */
  readonly animations: THREE.AnimationClip[];
  /** What GLTFLoader returned, for anything else in the file. */
  readonly gltf: GLTF;
}

/** sRGB transfer of a linear channel value, as a byte. */
const linearToSrgbByte = (linear: number): number => {
  const v = Math.min(Math.max(linear, 0), 1);
  const srgb = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(srgb * 255);
};

/** The splats of one POINTS primitive, in its node's frame. */
function splatDataOf(points: THREE.Points, colorSpace: string | undefined): SplatData {
  const geometry = points.geometry;
  const position = geometry.getAttribute('position');
  const rotation = geometry.getAttribute(ATTRIBUTE.rotation);
  const scale = geometry.getAttribute(ATTRIBUTE.scale);
  const opacity = geometry.getAttribute(ATTRIBUTE.opacity);
  const sh0 = geometry.getAttribute(ATTRIBUTE.sh0);
  const fallback = geometry.getAttribute('color');
  if (!position || !rotation || !scale || !opacity) {
    throw new Error(`loadSplatGltf: '${points.name}' is missing a ${EXTENSION} attribute.`);
  }
  const count = position.count;
  const positions = new Float32Array(count * 3);
  const covariances = new Float32Array(count * 6);
  const colors = new Uint8Array(count * 4);
  const linear = colorSpace?.startsWith('lin_') === true;
  const toByte = (value: number): number =>
    linear ? linearToSrgbByte(value) : Math.round(Math.min(Math.max(value, 0), 1) * 255);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
    // glTF quaternions are (x, y, z, w); writeCovariance takes (w, x, y, z).
    writeCovariance(
      covariances,
      i,
      scale.getX(i),
      scale.getY(i),
      scale.getZ(i),
      rotation.getW(i),
      rotation.getX(i),
      rotation.getY(i),
      rotation.getZ(i),
    );
    if (sh0) {
      colors[i * 4] = toByte(sh0.getX(i) * SH_C0 + 0.5);
      colors[i * 4 + 1] = toByte(sh0.getY(i) * SH_C0 + 0.5);
      colors[i * 4 + 2] = toByte(sh0.getZ(i) * SH_C0 + 0.5);
    } else if (fallback) {
      // COLOR_0 is linear in glTF.
      colors[i * 4] = linearToSrgbByte(fallback.getX(i));
      colors[i * 4 + 1] = linearToSrgbByte(fallback.getY(i));
      colors[i * 4 + 2] = linearToSrgbByte(fallback.getZ(i));
    } else {
      colors.fill(255, i * 4, i * 4 + 3);
    }
    colors[i * 4 + 3] = Math.round(Math.min(Math.max(opacity.getX(i), 0), 1) * 255);
  }
  return { count, positions, colors, covariances };
}

/** The splats' skin from `JOINTS_0` / `WEIGHTS_0`, with as few bones per splat as the file uses. */
function skinOf(points: THREE.Points): SplatSkinData | null {
  const geometry = points.geometry;
  const joints = geometry.getAttribute('skinIndex');
  const weights = geometry.getAttribute('skinWeight');
  if (!joints || !weights) return null;
  const count = joints.count;
  let used = 1;
  for (let i = 0; i < count && used < 4; i++) {
    if (weights.getW(i) > 0 || weights.getZ(i) > 0) used = 4;
    else if (weights.getY(i) > 0) used = 2;
  }
  const bonesPerSplat = used as 1 | 2 | 4;
  const indices = new Uint16Array(count * bonesPerSplat);
  const values = new Float32Array(count * bonesPerSplat);
  const getters = ['getX', 'getY', 'getZ', 'getW'] as const;
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < bonesPerSplat; k++) {
      indices[i * bonesPerSplat + k] = joints[getters[k]!](i);
      values[i * bonesPerSplat + k] = weights[getters[k]!](i);
    }
  }
  return { bonesPerSplat, indices, weights: values };
}

/** Index of the glTF node `object` belongs to (a multi-primitive mesh's group). */
function nodeIndexOf(gltf: GLTF, object: THREE.Object3D): number | undefined {
  for (let o: THREE.Object3D | null = object; o; o = o.parent) {
    const index = gltf.parser.associations.get(o)?.nodes;
    if (index !== undefined) return index;
  }
  return undefined;
}

/**
 * Loads Gaussian splats from a glTF (`.glb` or `.gltf`) under the ratified
 * `KHR_gaussian_splatting` extension: each splat primitive becomes a
 * `SplatMesh` in its place in the scene. A primitive with `JOINTS_0` /
 * `WEIGHTS_0` on a skinned node becomes a {@link SkinnedSplatMesh} bound to
 * that node's skeleton, as `GLTFLoader` binds a `SkinnedMesh`, so the file's
 * animations under an `AnimationMixer` move the splats.
 *
 * Clips whose `extras.vlam.additive` is set are made additive
 * (`AnimationUtils.makeClipAdditive`, from their first frame); their hints
 * stay on `clip.userData.vlam` ({@link SplatGltfClipHints}).
 *
 * `source` is a URL, the file's bytes, or a glTF your own `GLTFLoader`
 * already parsed, whose scene is then changed in place.
 *
 * Limits: degree-0 color only (higher SH degrees in the file are ignored),
 * and an unskinned primitive keeps its node's transform but not its node's
 * parent skin. Splats are kept in the file's axes (glTF is Y-up), so
 * `orientation` defaults to `'source'`.
 *
 * @example
 * ```ts
 * import * as THREE from 'three/webgpu';
 * import { loadSplatGltf } from '@voluma/vlam/dynamic';
 *
 * const goose = await loadSplatGltf('/procedural-goose.glb');
 * scene.add(goose.scene);
 * const mixer = new THREE.AnimationMixer(goose.scene);
 * mixer.clipAction(THREE.AnimationClip.findByName(goose.animations, 'idle')!).play();
 *
 * renderer.setAnimationLoop(() => {
 *   mixer.update(timer.getDelta());
 *   for (const mesh of goose.meshes) mesh.update(camera, renderer);
 *   renderer.render(scene, camera);
 * });
 * ```
 *
 * @experimental The API may change in a minor release.
 */
export async function loadSplatGltf(
  source: string | ArrayBuffer | GLTF,
  options: LoadSplatGltfOptions = {},
): Promise<SplatGltf> {
  const { loader: given, skinning = true, ...meshOptions } = options;
  let gltf: GLTF;
  if (typeof source === 'object' && 'parser' in source) {
    gltf = source;
  } else {
    const loader = given ?? new GLTFLoader();
    // Files may list the extension as required; the splats are read here.
    loader.register(() => ({ name: EXTENSION }));
    gltf =
      typeof source === 'string'
        ? await loader.loadAsync(source)
        : await loader.parseAsync(source, '');
  }
  const json = gltf.parser.json as {
    nodes?: { skin?: number }[];
    meshes?: { primitives: { extensions?: Record<string, { colorSpace?: string }> }[] }[];
  };

  const found: THREE.Points[] = [];
  gltf.scene.traverse((object) => {
    if (
      (object as THREE.Points).isPoints &&
      (object as THREE.Points).geometry.getAttribute(ATTRIBUTE.rotation)
    ) {
      found.push(object as THREE.Points);
    }
  });

  const meshes: SplatMesh[] = [];
  for (const points of found) {
    const association = gltf.parser.associations.get(points);
    const primitive =
      association?.meshes !== undefined
        ? json.meshes?.[association.meshes]?.primitives[association.primitives ?? 0]
        : undefined;
    const data = splatDataOf(points, primitive?.extensions?.[EXTENSION]?.colorSpace);
    const node = nodeIndexOf(gltf, points);
    const skinIndex = node === undefined ? undefined : json.nodes?.[node]?.skin;
    const skin = skinIndex === undefined || !skinning ? null : skinOf(points);
    const options = { orientation: 'source' as const, ...meshOptions };
    let mesh: SplatMesh;
    if (skin && skinIndex !== undefined) {
      const skinned = new SkinnedSplatMesh(data, { ...options, skin });
      // The cached skeleton, whose bones are the scene's joint nodes.
      const skeleton = (await gltf.parser.getDependency('skin', skinIndex)) as THREE.Skeleton;
      skinned.bind(skeleton, new THREE.Matrix4());
      mesh = skinned;
    } else {
      mesh = new SplatMesh(data, options);
    }
    mesh.name = points.name;
    mesh.position.copy(points.position);
    mesh.quaternion.copy(points.quaternion);
    mesh.scale.copy(points.scale);
    mesh.visible = points.visible;
    mesh.userData = { ...points.userData };
    const parent = points.parent;
    if (parent) {
      const index = parent.children.indexOf(points);
      parent.remove(points);
      parent.add(mesh);
      // Keep the child order of the file.
      parent.children.splice(parent.children.length - 1, 1);
      parent.children.splice(index, 0, mesh);
    }
    if (association) gltf.parser.associations.set(mesh, association);
    points.geometry.dispose();
    meshes.push(mesh);
  }

  const animations = gltf.animations.map((clip) => {
    const hints = (clip.userData as { vlam?: SplatGltfClipHints }).vlam;
    // Already additive when a parsed glTF comes through a second time.
    const additive = hints?.additive && clip.blendMode !== THREE.AdditiveAnimationBlendMode;
    return additive ? THREE.AnimationUtils.makeClipAdditive(clip) : clip;
  });
  return { scene: gltf.scene, meshes, animations, gltf };
}
