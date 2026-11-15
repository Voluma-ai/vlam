/**
 * {@link SkinnedSplatMesh}: a static splat skinned by a `THREE.Skeleton`, the
 * splat counterpart of `THREE.SkinnedMesh`. Whatever moves the bones moves the
 * splats: glTF clips under an `AnimationMixer` (with cross-fades and action
 * weights), IK, physics or plain code.
 *
 * The splats stay in the pool as captured (the bind pose). Each splat carries
 * up to four bone indices and weights in float channels; a small RGBA float
 * texture holds one 3×4 matrix per bone, from the bind pose to the current
 * one, refreshed in `update`. A `SplatModifier` blends a splat's bone
 * matrices and moves its center and shape (the linear part goes through the
 * covariance as `M·Σ·Mᵀ`); a position-only twin in `sortDisplacement` makes
 * the standalone WebGPU sort see the posed centers.
 */
import * as THREE from 'three/webgpu';
import { dot, float, int, ivec2, mat3, textureLoad, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { SplatMesh } from '../core/splat-mesh';
import type { SplatData } from '../core/splat-data';
import type { SplatContext, SplatModifier } from '../core/splat-modifier';
import type { SplatMeshOptions, SplatRange, SplatUpdateOptions } from '../core/splat-mesh-types';
import { packPaletteSh } from '../core/sh-pack';

/** Bone indices pack two to a float32 channel, 12 bits each (exact below 2²⁴). */
const INDEX_RADIX = 4096;
/**
 * Most bones a skeleton bound to a {@link SkinnedSplatMesh} may have.
 *
 * @experimental
 */
export const SKINNED_SPLAT_MAX_BONES = INDEX_RADIX;
/** Weights are stored in 8 bits each, the last one implied (1 − the others). */
const WEIGHT_STEPS = 255;
const WEIGHT_RADIX = 256;
const INDEX_CHANNELS = ['vlamSkinIndex01', 'vlamSkinIndex23'] as const;
const WEIGHT_CHANNEL = 'vlamSkinWeight';
/** Margin added around the posed bounds when they are set, as a fraction of their size. */
const BOUNDS_MARGIN = 0.25;
/**
 * Bounds the mesh set itself shrink back once their diagonal is this many
 * times what the pose (with its margin) needs: after root motion returns, or
 * a wide pose ends, so the sort keeps its depth precision.
 */
const BOUNDS_SHRINK_RATIO = 2;

/**
 * Per-splat skinning: which bones move each splat, and how much.
 *
 * @experimental
 */
export interface SplatSkinData {
  /** Bones per splat (the length of each splat's run in {@link indices} and {@link weights}). */
  readonly bonesPerSplat: 1 | 2 | 4;
  /** `count · bonesPerSplat` indices into `skeleton.bones`. */
  readonly indices: ArrayLike<number>;
  /**
   * `count · bonesPerSplat` weights, normalized per splat (all zero means the
   * first bone alone). Stored in 8 bits each.
   */
  readonly weights: ArrayLike<number>;
}

/**
 * Options of {@link SkinnedSplatMesh}.
 *
 * @experimental
 */
export interface SkinnedSplatMeshOptions extends SplatMeshOptions {
  /** The splats' bone indices and weights, in the order of the data's splats. */
  skin: SplatSkinData;
}

/** The weights as the GPU decodes them: quantized, the last one implied. */
function quantizeWeights(skin: SplatSkinData, count: number): Float32Array {
  const n = skin.bonesPerSplat;
  const out = new Float32Array(count * n);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += Math.max(0, Number(skin.weights[i * n + k]) || 0);
    if (!(sum > 0)) {
      out[i * n] = 1;
      continue;
    }
    let stored = 0;
    for (let k = 0; k < n - 1; k++) {
      const steps = Math.min(
        Math.round((Math.max(0, Number(skin.weights[i * n + k]) || 0) / sum) * WEIGHT_STEPS),
        WEIGHT_STEPS - stored,
      );
      out[i * n + k] = steps / WEIGHT_STEPS;
      stored += steps;
    }
    out[i * n + n - 1] = (WEIGHT_STEPS - stored) / WEIGHT_STEPS;
  }
  return out;
}

/** Channel values of a skin (see the module comment). */
function packSkin(skin: SplatSkinData, count: number, quantized: Float32Array) {
  const n = skin.bonesPerSplat;
  const index = (i: number, k: number): number => {
    const value = Number(skin.indices[i * n + k]);
    if (!Number.isInteger(value) || value < 0 || value >= INDEX_RADIX) {
      throw new RangeError(
        `SkinnedSplatMesh: splat ${i} names bone ${value}; indices run 0..${INDEX_RADIX - 1}.`,
      );
    }
    return value;
  };
  const index01 = new Float32Array(count);
  const index23 = n === 4 ? new Float32Array(count) : null;
  const weight = n > 1 ? new Float32Array(count) : null;
  for (let i = 0; i < count; i++) {
    index01[i] = index(i, 0) + (n > 1 ? INDEX_RADIX * index(i, 1) : 0);
    if (index23) index23[i] = index(i, 2) + INDEX_RADIX * index(i, 3);
    if (weight) {
      let packed = 0;
      let radix = 1;
      for (let k = 0; k < n - 1; k++) {
        packed += Math.round(quantized[i * n + k]! * WEIGHT_STEPS) * radix;
        radix *= WEIGHT_RADIX;
      }
      weight[i] = packed;
    }
  }
  return { index01, index23, weight };
}

type ChannelContext = Pick<SplatContext, 'channel'>;

/** The blended rows of a splat's bone matrix (bind pose → current pose). */
function blendedRows(
  bones: THREE.DataTexture,
  n: 1 | 2 | 4,
  ctx: ChannelContext,
): readonly [Node<'vec4'>, Node<'vec4'>, Node<'vec4'>] {
  const radix = int(INDEX_RADIX);
  const pair0 = int(ctx.channel(INDEX_CHANNELS[0]));
  const indices: Node<'int'>[] = [pair0.mod(radix)];
  if (n > 1) indices.push(pair0.div(radix));
  if (n === 4) {
    const pair1 = int(ctx.channel(INDEX_CHANNELS[1]));
    indices.push(pair1.mod(radix), pair1.div(radix));
  }
  const weights: Node<'float'>[] = [];
  if (n > 1) {
    const packed = int(ctx.channel(WEIGHT_CHANNEL));
    let rest: Node<'float'> = float(1);
    let divisor = 1;
    for (let k = 0; k < n - 1; k++) {
      const steps = (divisor === 1 ? packed : packed.div(int(divisor))).mod(int(WEIGHT_RADIX));
      const w = float(steps).div(WEIGHT_STEPS);
      weights.push(w);
      rest = rest.sub(w);
      divisor *= WEIGHT_RADIX;
    }
    weights.push(rest);
  }
  const row = (r: number): Node<'vec4'> => {
    const term = (k: number): Node<'vec4'> => {
      const texel = textureLoad(bones, ivec2(int(r), indices[k]!));
      return n === 1 ? texel : texel.mul(weights[k]!);
    };
    let sum = term(0);
    for (let k = 1; k < indices.length; k++) sum = sum.add(term(k));
    return sum;
  };
  return [row(0), row(1), row(2)];
}

function transformPoint(
  rows: readonly [Node<'vec4'>, Node<'vec4'>, Node<'vec4'>],
  point: Node<'vec3'>,
): Node<'vec3'> {
  const p = vec4(point, 1);
  return vec3(dot(rows[0], p), dot(rows[1], p), dot(rows[2], p));
}

/** The skin modifier: moves each splat's center and shape by its blended bone matrix. */
function skinModifier(bones: THREE.DataTexture, n: 1 | 2 | 4): SplatModifier {
  return (ctx) => {
    const rows = blendedRows(bones, n, ctx);
    const [r0, r1, r2] = rows;
    const linear = mat3(vec3(r0.x, r1.x, r2.x), vec3(r0.y, r1.y, r2.y), vec3(r0.z, r1.z, r2.z));
    const center = ctx.localCenter.add(ctx.offset);
    return {
      offset: transformPoint(rows, center).sub(ctx.localCenter),
      rotation: linear.mul(ctx.rotation),
    };
  };
}

/** The position part of {@link skinModifier} alone, for `sortDisplacement`. */
function skinSortModifier(bones: THREE.DataTexture, n: 1 | 2 | 4): SplatModifier {
  return (ctx) => {
    const center = ctx.localCenter.add(ctx.offset);
    return { offset: transformPoint(blendedRows(bones, n, ctx), center).sub(ctx.localCenter) };
  };
}

/** SH bands a dynamic pool should allocate for `data`. */
function dataShBands(data: SplatData): 0 | 1 | 2 | 3 {
  const bands = data.shPacked?.bands ?? data.sh?.bands ?? 0;
  return Math.min(Math.max(Math.floor(bands), 0), 3) as 0 | 1 | 2 | 3;
}

/** `data` with palette SH turned into the per-splat form a dynamic pool stores. */
function withPackedSh(data: SplatData, bands: 0 | 1 | 2 | 3): SplatData {
  if (data.shPacked || !data.sh || bands === 0) return data;
  // The pool keeps the packed form only; leaving the palette on would warn.
  const { sh, ...rest } = data;
  return { ...rest, shPacked: packPaletteSh(sh, data.count, bands) };
}

/**
 * A static splat skinned by a `THREE.Skeleton`: the splat counterpart of
 * `THREE.SkinnedMesh` (see the module comment for how it works).
 *
 * The splats' local space is the bind space: the frame the skeleton's
 * inverse bind matrices were made in. With a glTF, put the mesh where the
 * rig's `SkinnedMesh` is (for example as its child) and bind with that
 * mesh's skeleton and `bindMatrix`. The data keeps its own axes (no upright
 * correction is applied), so the skeleton must use the same ones.
 *
 * Bounds follow the pose: each `update` checks the posed reach against
 * `displacementBounds`, grows it when a limb (or root motion) leaves it, and
 * shrinks it back once it is far larger than the pose needs. A box the app
 * sets itself is only ever grown.
 *
 * Limits: view-dependent SH is evaluated in the bind pose, so strong SH on a
 * turned limb is stale. The WebGL2 worker sorter sorts bind-pose centers, and
 * the pooled unified draw rejects channel-reading modifiers. For rigid parts
 * alone (a vehicle's wheels and doors), `MergedSplatMesh` with one source per
 * part is exact on every path.
 *
 * @example
 * ```ts
 * import * as THREE from 'three/webgpu';
 * import { SkinnedSplatMesh, computeSplatSkinWeights } from '@voluma/vlam/dynamic';
 *
 * // A glTF with the rig: a low-poly SkinnedMesh in the splat's frame, and clips.
 * const proxy = gltf.scene.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
 * proxy.visible = false;
 * const mesh = new SkinnedSplatMesh(splats, { skin: computeSplatSkinWeights(splats, proxy) });
 * proxy.add(mesh); // the proxy's frame is the bind space
 * mesh.bind(proxy.skeleton, proxy.bindMatrix);
 * scene.add(gltf.scene);
 *
 * const mixer = new THREE.AnimationMixer(gltf.scene);
 * const walk = mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, 'Walk')!);
 * walk.play();
 * // Later: walk.crossFadeTo(run, 0.4, true).
 *
 * renderer.setAnimationLoop(() => {
 *   mixer.update(timer.getDelta());
 *   mesh.update(camera, renderer); // refreshes the bone texture from the skeleton
 *   renderer.render(scene, camera);
 * });
 * ```
 *
 * @experimental The API may change in a minor release.
 */
export class SkinnedSplatMesh extends SplatMesh {
  /** The splats' single range, for channels a host writes (a paint mask). */
  readonly range: SplatRange;
  /** Bones per splat the mesh decodes. */
  readonly bonesPerSplat: 1 | 2 | 4;
  /** The bound skeleton, or `null` before {@link bind} (the splats then rest in the bind pose). */
  skeleton: THREE.Skeleton | null = null;
  /** As `THREE.SkinnedMesh.bindMode`: `'attached'` follows this mesh's world matrix. */
  bindMode: 'attached' | 'detached' = 'attached';
  /** The matrix the skeleton was bound with (bind space → the skeleton's world). */
  readonly bindMatrix = new THREE.Matrix4();
  /** Inverse of {@link bindMatrix}, or of the world matrix in `'attached'` mode. */
  readonly bindMatrixInverse = new THREE.Matrix4();
  private readonly source: SplatData;
  private readonly weights: Float32Array;
  private readonly indices: Uint16Array;
  /** Splat-center box of every bone's splats, in bind space (empty for an unused bone). */
  private boneBoxes: THREE.Box3[] = [];
  private bones: THREE.DataTexture | null = null;
  /** One 3×4 row-major matrix per bone, bind pose → current pose; the texture's data. */
  private matrices = new Float32Array(0);
  private skin: SplatModifier | null = null;
  private skinSort: SplatModifier | null = null;
  /** The bounds {@link followPose} last set, to tell them from a box the app set. */
  private ownedBounds: THREE.Box3 | null = null;
  private readonly scratch = {
    bone: new THREE.Matrix4(),
    box: new THREE.Box3(),
    posed: new THREE.Box3(),
  };

  constructor(data: SplatData, options: SkinnedSplatMeshOptions) {
    const { skin, ...meshOptions } = options;
    const n = skin.bonesPerSplat;
    if (n !== 1 && n !== 2 && n !== 4) {
      throw new RangeError('SkinnedSplatMesh: bonesPerSplat must be 1, 2 or 4.');
    }
    if (skin.indices.length < data.count * n || skin.weights.length < data.count * n) {
      throw new RangeError(
        `SkinnedSplatMesh: the skin needs ${data.count * n} indices and weights ` +
          `(${n} for each of ${data.count} splats).`,
      );
    }
    const shBands = meshOptions.shBands ?? dataShBands(data);
    super({ capacity: Math.max(data.count, 1) }, { ...meshOptions, shBands });
    this.bonesPerSplat = n;
    this.source = data;
    this.weights = quantizeWeights(skin, data.count);
    this.indices = Uint16Array.from({ length: data.count * n }, (_, i) => Number(skin.indices[i]));
    this.range = this.appendRange(withPackedSh(data, shBands));
    const packed = packSkin(skin, data.count, this.weights);
    this.defineChannel(INDEX_CHANNELS[0]);
    this.writeChannel(this.range, INDEX_CHANNELS[0], packed.index01);
    if (packed.index23) {
      this.defineChannel(INDEX_CHANNELS[1]);
      this.writeChannel(this.range, INDEX_CHANNELS[1], packed.index23);
    }
    if (packed.weight) {
      this.defineChannel(WEIGHT_CHANNEL);
      this.writeChannel(this.range, WEIGHT_CHANNEL, packed.weight);
    }
  }

  /** The skin modifier, once bound; on {@link modifiers}, exposed for hosts that restack. */
  get skinModifier(): SplatModifier | null {
    return this.skin;
  }

  /**
   * Binds a skeleton, as `THREE.SkinnedMesh.bind` does: with no `bindMatrix`,
   * the mesh's world matrix becomes the bind matrix and the skeleton's
   * current pose its bind pose (`skeleton.calculateInverses()`).
   */
  bind(skeleton: THREE.Skeleton, bindMatrix?: THREE.Matrix4): void {
    const count = skeleton.bones.length;
    if (count === 0 || count > SKINNED_SPLAT_MAX_BONES) {
      throw new RangeError(
        `SkinnedSplatMesh.bind: a skeleton needs 1 to ${SKINNED_SPLAT_MAX_BONES} bones (got ${count}).`,
      );
    }
    const n = this.bonesPerSplat;
    for (let i = 0; i < this.indices.length; i++) {
      if (this.indices[i]! >= count && this.weights[i]! > 0) {
        throw new RangeError(
          `SkinnedSplatMesh.bind: splat ${Math.floor(i / n)} uses bone ${this.indices[i]}, ` +
            `but the skeleton has ${count}.`,
        );
      }
    }
    if (bindMatrix === undefined) {
      this.updateMatrixWorld(true);
      skeleton.calculateInverses();
      bindMatrix = this.matrixWorld;
    }
    this.bindMatrix.copy(bindMatrix);
    this.bindMatrixInverse.copy(bindMatrix).invert();
    this.skeleton = skeleton;

    this.boneBoxes = this.measureBoneBoxes(count);
    const previous = this.bones;
    this.matrices = new Float32Array(count * 12);
    this.bones = new THREE.DataTexture(this.matrices, 3, count, THREE.RGBAFormat, THREE.FloatType);
    this.bones.needsUpdate = true;
    const oldSkin = this.skin;
    this.skin = skinModifier(this.bones, n);
    this.skinSort = skinSortModifier(this.bones, n);
    // Keep whatever a host stacked after the skin (lighting, a paint tint).
    const rest = this.modifiers.filter((modifier) => modifier !== oldSkin);
    this.modifiers = [this.skin, ...rest];
    this.sortDisplacement = [this.skinSort];
    previous?.dispose();
    this.refreshSkin();
  }

  /**
   * Refreshes the bone texture from the skeleton's current bone world
   * matrices (and this mesh's, in `'attached'` mode), and grows the bounds if
   * the pose left them. `update` calls it; call it yourself only to read
   * {@link posedSplatData} between updates.
   *
   * Bones are read through `updateWorldMatrix`, so a bone whose matrix is set
   * by hand (`matrixAutoUpdate = false`) needs `matrixWorldNeedsUpdate = true`,
   * as everywhere in three.js.
   */
  refreshSkin(): void {
    const skeleton = this.skeleton;
    const bones = this.bones;
    if (!skeleton || !bones) return;
    if (this.bindMode === 'attached') {
      this.updateWorldMatrix(true, false);
      this.bindMatrixInverse.copy(this.matrixWorld).invert();
    } else {
      this.bindMatrixInverse.copy(this.bindMatrix).invert();
    }
    const m = this.scratch.bone;
    const matrices = this.matrices;
    const posed = this.scratch.posed.makeEmpty();
    let changed = false;
    skeleton.bones.forEach((bone, i) => {
      bone.updateWorldMatrix(true, false);
      const inverse = skeleton.boneInverses[i];
      // bindMatrixInverse · boneWorld · boneInverse · bindMatrix, as three's skinning.
      m.multiplyMatrices(bone.matrixWorld, inverse ?? m.identity());
      m.premultiply(this.bindMatrixInverse).multiply(this.bindMatrix);
      const e = m.elements;
      const o = i * 12;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 4; c++) {
          const value = e[c * 4 + r]!;
          if (matrices[o + r * 4 + c] !== value) {
            matrices[o + r * 4 + c] = value;
            changed = true;
          }
        }
      }
      const box = this.boneBoxes[i];
      if (box && !box.isEmpty()) posed.union(this.scratch.box.copy(box).applyMatrix4(m));
    });
    if (!changed) return;
    bones.needsUpdate = true;
    this.invalidateSortDisplacement();
    this.followPose(posed);
  }

  /**
   * Keeps {@link displacementBounds} around the pose: grows them when the pose
   * leaves them, and shrinks bounds the mesh set itself once they are far
   * larger than the pose needs. A box the app set is never shrunk, only grown.
   */
  private followPose(posed: THREE.Box3): void {
    if (posed.isEmpty()) return;
    const declared = this.displacementBounds;
    const owned = declared !== null && this.ownedBounds?.equals(declared) === true;
    const size = new THREE.Vector3();
    const withMargin = (box: THREE.Box3) =>
      box.expandByVector(box.getSize(size).multiplyScalar(BOUNDS_MARGIN));
    // Largest diagonal the mesh keeps for its own bounds before shrinking.
    const limit = BOUNDS_SHRINK_RATIO * withMargin(posed.clone()).getSize(size).length();
    if (declared?.containsBox(posed)) {
      if (!owned || declared.getSize(size).length() <= limit) return;
      // Far larger than the pose needs (root motion came back): shrink.
      this.setOwnedBounds(withMargin(posed.clone()));
      return;
    }
    if (!declared || !owned) {
      // Grow an app's box (never below it), or start from the pose.
      this.setOwnedBounds(withMargin(declared ? posed.clone().union(declared) : posed.clone()));
      return;
    }
    // Grow its own bounds along the motion, so a walking rig re-bounds
    // rarely; past the shrink limit, start again from the pose.
    const grown = withMargin(posed.clone().union(declared));
    this.setOwnedBounds(grown.getSize(size).length() <= limit ? grown : withMargin(posed.clone()));
  }

  private setOwnedBounds(box: THREE.Box3): void {
    this.ownedBounds = box.clone();
    this.displacementBounds = box;
  }

  /**
   * The splats in the current pose, on the CPU, matching what the GPU draws
   * (same quantized weights): for picking against posed splats, CPU queries
   * and exports. A pass over every splat; call it per query, not per frame.
   */
  posedSplatData(): SplatData {
    this.refreshSkin();
    const data = this.source;
    if (!this.skeleton) return data;
    const positions = new Float32Array(data.count * 3);
    const covariances = new Float32Array(data.count * 6);
    poseSplats(data, this.indices, this.weights, this.bonesPerSplat, this.matrices, {
      positions,
      covariances,
    });
    return { ...data, positions, covariances };
  }

  override update(
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGPURenderer,
    options?: SplatUpdateOptions,
  ): void {
    this.refreshSkin();
    super.update(camera, renderer, options);
  }

  override dispose(): void {
    this.bones?.dispose();
    this.bones = null;
    super.dispose();
  }

  /** Box of the bind-pose centers of every splat each bone moves at all. */
  private measureBoneBoxes(count: number): THREE.Box3[] {
    const boxes = Array.from({ length: count }, () => new THREE.Box3());
    const n = this.bonesPerSplat;
    const p = new THREE.Vector3();
    const positions = this.source.positions;
    for (let i = 0; i < this.source.count; i++) {
      p.fromArray(positions, i * 3);
      for (let k = 0; k < n; k++) {
        if (this.weights[i * n + k]! > 0) boxes[this.indices[i * n + k]!]?.expandByPoint(p);
      }
    }
    return boxes;
  }
}

/**
 * The CPU twin of the skin modifier: each splat's center and covariance
 * carried by its blended bone matrix (`matrices`: 12 floats per bone, 3×4
 * row-major), with the weights as the GPU decodes them.
 */
function poseSplats(
  data: Pick<SplatData, 'count' | 'positions' | 'covariances'>,
  indices: Uint16Array,
  weights: Float32Array,
  n: number,
  matrices: Float32Array,
  out: { positions: Float32Array; covariances: Float32Array },
): void {
  const m = new Float64Array(12);
  const t = new Float64Array(9);
  const { positions, covariances } = data;
  for (let i = 0; i < data.count; i++) {
    m.fill(0);
    for (let k = 0; k < n; k++) {
      const w = weights[i * n + k]!;
      if (w === 0) continue;
      const o = indices[i * n + k]! * 12;
      for (let e = 0; e < 12; e++) m[e]! += w * matrices[o + e]!;
    }
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    for (let r = 0; r < 3; r++) {
      out.positions[i * 3 + r] =
        m[r * 4]! * x + m[r * 4 + 1]! * y + m[r * 4 + 2]! * z + m[r * 4 + 3]!;
    }
    // Σ' = L·Σ·Lᵀ with L the blended linear part, on the stored upper triangle.
    const c = i * 6;
    const s00 = covariances[c]!;
    const s01 = covariances[c + 1]!;
    const s02 = covariances[c + 2]!;
    const s11 = covariances[c + 3]!;
    const s12 = covariances[c + 4]!;
    const s22 = covariances[c + 5]!;
    for (let r = 0; r < 3; r++) {
      const l0 = m[r * 4]!;
      const l1 = m[r * 4 + 1]!;
      const l2 = m[r * 4 + 2]!;
      t[r * 3] = l0 * s00 + l1 * s01 + l2 * s02;
      t[r * 3 + 1] = l0 * s01 + l1 * s11 + l2 * s12;
      t[r * 3 + 2] = l0 * s02 + l1 * s12 + l2 * s22;
    }
    const entry = (r: number, q: number): number =>
      t[r * 3]! * m[q * 4]! + t[r * 3 + 1]! * m[q * 4 + 1]! + t[r * 3 + 2]! * m[q * 4 + 2]!;
    out.covariances[c] = entry(0, 0);
    out.covariances[c + 1] = entry(0, 1);
    out.covariances[c + 2] = entry(0, 2);
    out.covariances[c + 3] = entry(1, 1);
    out.covariances[c + 4] = entry(1, 2);
    out.covariances[c + 5] = entry(2, 2);
  }
}
