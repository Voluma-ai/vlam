/**
 * Writes Gaussian splats as a binary glTF (`.glb`) under the ratified
 * `KHR_gaussian_splatting` extension, optionally skinned and animated: a
 * POINTS primitive whose vertices are splats, the standard `JOINTS_0` /
 * `WEIGHTS_0` attributes plus a glTF skin, and animations on the joint nodes.
 *
 * `KHR_gaussian_splatting` says nothing about skinning; the skin here is the
 * same one a triangle mesh would carry, so any glTF tool sees the skeleton
 * and its clips. `@voluma/vlam/dynamic`'s `loadSplatGltf` turns the result
 * back into a `SkinnedSplatMesh` bound to that skeleton.
 *
 * Splats are written as
 *  - `POSITION` float32,
 *  - `KHR_gaussian_splatting:ROTATION` snorm16 xyzw,
 *  - `KHR_gaussian_splatting:SCALE` float32 (linear),
 *  - `KHR_gaussian_splatting:OPACITY` float32 (a vertex attribute element
 *    must be 4-byte aligned, so unorm8 would take the same space),
 *  - `KHR_gaussian_splatting:SH_DEGREE_0_COEF_0` float32, from the sRGB
 *    color bytes (`colorSpace: 'srgb_rec709_display'`).
 *
 * Higher SH degrees are not written. A repo tool, not public API.
 */
import { SH_C0, type SplatData } from '../../lib/core/splat-data';

/** glTF's name for the extension, and its attribute prefix. */
export const KHR_GAUSSIAN_SPLATTING = 'KHR_gaussian_splatting';

/** Bones that move each splat (see `SplatSkinData` in `@voluma/vlam/dynamic`). */
export interface SplatGlbSkin {
  readonly bonesPerSplat: 1 | 2 | 4;
  /** `count · bonesPerSplat` bone indices. */
  readonly indices: ArrayLike<number>;
  /** `count · bonesPerSplat` weights; normalized per splat on write. */
  readonly weights: ArrayLike<number>;
}

/** The skeleton in its bind pose: rigid bones (rotation and translation only). */
export interface SplatGlbSkeleton {
  readonly names: readonly string[];
  /** Parent bone of each bone, `-1` for a root. */
  readonly parents: readonly number[];
  /** Each bone's bind-pose world matrix, 3×4 row-major (12 floats per bone). */
  readonly world: ArrayLike<number>;
}

/**
 * Hints for a player, stored in `animation.extras.vlam`: how the clip is
 * meant to be played. A plain glTF player ignores them.
 */
export interface SplatGlbClipHints {
  readonly loop?: 'repeat' | 'once';
  /** With `loop: 'repeat'`, how many times (unset: forever). */
  readonly repetitions?: number;
  /**
   * The clip is written as absolute poses but meant to be layered on top of
   * others as offsets from its first frame (`AnimationUtils.makeClipAdditive`).
   */
  readonly additive?: boolean;
}

/** An animation as sampled poses: every bone's world matrix at each key time. */
export interface SplatGlbAnimation {
  readonly name: string;
  /** Key times in seconds, increasing. */
  readonly times: ArrayLike<number>;
  /** One pose per key time, in the layout of {@link SplatGlbSkeleton.world}. */
  readonly poses: readonly ArrayLike<number>[];
  readonly hints?: SplatGlbClipHints;
}

export interface SplatGlbInput {
  /** The splats, in the bind pose when skinned. Colors are sRGB bytes. */
  readonly data: Pick<SplatData, 'count' | 'positions' | 'colors' | 'covariances'>;
  /** Name of the scene's root node and the splat mesh (default `splats`). */
  readonly name?: string;
  readonly skin?: SplatGlbSkin;
  /** Required with {@link skin}. */
  readonly skeleton?: SplatGlbSkeleton;
  /** Need {@link skeleton}. */
  readonly animations?: readonly SplatGlbAnimation[];
  /** `asset.generator` (default `VLAM! splat-gltf`). */
  readonly generator?: string;
}

// glTF accessor component types.
const UNSIGNED_BYTE = 5121;
const SHORT = 5122;
const UNSIGNED_SHORT = 5123;
const FLOAT = 5126;

type Quat = [number, number, number, number];
type Vec3 = [number, number, number];
/** A rigid transform: rotation matrix (row-major 3×3) and translation. */
interface Rigid {
  readonly r: number[];
  readonly t: Vec3;
}

const readRigid = (m: ArrayLike<number>, bone: number): Rigid => {
  const o = bone * 12;
  const at = (i: number): number => Number(m[o + i]);
  return {
    r: [at(0), at(1), at(2), at(4), at(5), at(6), at(8), at(9), at(10)],
    t: [at(3), at(7), at(11)],
  };
};

/** `a⁻¹ · b` for rigid `a`. */
function relative(a: Rigid, b: Rigid): Rigid {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a.r[i]! * b.r[j]! + a.r[3 + i]! * b.r[3 + j]! + a.r[6 + i]! * b.r[6 + j]!;
    }
  }
  const d: Vec3 = [b.t[0] - a.t[0], b.t[1] - a.t[1], b.t[2] - a.t[2]];
  const t: Vec3 = [0, 1, 2].map(
    (i) => a.r[i]! * d[0] + a.r[3 + i]! * d[1] + a.r[6 + i]! * d[2],
  ) as Vec3;
  return { r, t };
}

/** Unit quaternion (x, y, z, w) of a row-major rotation matrix. */
export function quaternionOfMatrix(r: ArrayLike<number>): Quat {
  const m00 = r[0]!;
  const m01 = r[1]!;
  const m02 = r[2]!;
  const m10 = r[3]!;
  const m11 = r[4]!;
  const m12 = r[5]!;
  const m20 = r[6]!;
  const m21 = r[7]!;
  const m22 = r[8]!;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const length = Math.hypot(...q) || 1;
  return q.map((v) => v / length) as Quat;
}

/**
 * Eigen decomposition of a symmetric 3×3 matrix (upper triangle
 * `m00 m01 m02 m11 m12 m22`) by cyclic Jacobi rotations: the eigenvalues and
 * the eigenvectors as the columns of a proper rotation (row-major).
 */
export function symmetricEigen(
  c: ArrayLike<number>,
  offset = 0,
): { values: Vec3; vectors: number[] } {
  const a = [
    [c[offset]!, c[offset + 1]!, c[offset + 2]!],
    [c[offset + 1]!, c[offset + 3]!, c[offset + 4]!],
    [c[offset + 2]!, c[offset + 4]!, c[offset + 5]!],
  ] as number[][];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(a[0]![1]!) + Math.abs(a[0]![2]!) + Math.abs(a[1]![2]!);
    const scale = Math.abs(a[0]![0]!) + Math.abs(a[1]![1]!) + Math.abs(a[2]![2]!);
    if (off <= 1e-15 * scale || off === 0) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p]![q]!;
      if (apq === 0) continue;
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cos = 1 / Math.sqrt(t * t + 1);
      const sin = t * cos;
      for (let k = 0; k < 3; k++) {
        const akp = a[k]![p]!;
        const akq = a[k]![q]!;
        a[k]![p] = cos * akp - sin * akq;
        a[k]![q] = sin * akp + cos * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p]![k]!;
        const aqk = a[q]![k]!;
        a[p]![k] = cos * apk - sin * aqk;
        a[q]![k] = sin * apk + cos * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k]![p]!;
        const vkq = v[k]![q]!;
        v[k]![p] = cos * vkp - sin * vkq;
        v[k]![q] = sin * vkp + cos * vkq;
      }
    }
  }
  const vectors = v.flat();
  // A proper rotation: flip the last column if the basis is left-handed.
  const det =
    vectors[0]! * (vectors[4]! * vectors[8]! - vectors[5]! * vectors[7]!) -
    vectors[1]! * (vectors[3]! * vectors[8]! - vectors[5]! * vectors[6]!) +
    vectors[2]! * (vectors[3]! * vectors[7]! - vectors[4]! * vectors[6]!);
  if (det < 0) for (const i of [2, 5, 8]) vectors[i] = -vectors[i]!;
  return { values: [a[0]![0]!, a[1]![1]!, a[2]![2]!], vectors };
}

/** Accumulates bufferViews and accessors into one binary chunk. */
class BinaryBuilder {
  readonly bufferViews: Record<string, unknown>[] = [];
  readonly accessors: Record<string, unknown>[] = [];
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  accessor(
    array: ArrayBufferView,
    componentType: number,
    type: 'SCALAR' | 'VEC3' | 'VEC4' | 'MAT4',
    count: number,
    options: { normalized?: boolean; target?: number; minMax?: boolean; byteStride?: number } = {},
  ): number {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    const byteOffset = this.length;
    this.parts.push(bytes);
    this.length += bytes.byteLength;
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const view: Record<string, unknown> = { buffer: 0, byteOffset, byteLength: bytes.byteLength };
    if (options.target !== undefined) view.target = options.target;
    if (options.byteStride !== undefined) view.byteStride = options.byteStride;
    this.bufferViews.push(view);
    const accessor: Record<string, unknown> = {
      bufferView: this.bufferViews.length - 1,
      componentType,
      count,
      type,
    };
    if (options.normalized) accessor.normalized = true;
    if (options.minMax) {
      const width = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
      const values = array as unknown as ArrayLike<number>;
      const min = new Array<number>(width).fill(Infinity);
      const max = new Array<number>(width).fill(-Infinity);
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < width; k++) {
          const value = values[i * width + k]!;
          if (value < min[k]!) min[k] = value;
          if (value > max[k]!) max[k] = value;
        }
      }
      accessor.min = min.map((x) => Math.fround(x));
      accessor.max = max.map((x) => Math.fround(x));
    }
    this.accessors.push(accessor);
    return this.accessors.length - 1;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
}

const ARRAY_BUFFER = 34962;

/** The splat attributes of a POINTS primitive, in `builder`. */
function writeSplats(
  builder: BinaryBuilder,
  data: SplatGlbInput['data'],
  skin: SplatGlbSkin | undefined,
): Record<string, number> {
  const n = data.count;
  const rotation = new Int16Array(n * 4);
  const scale = new Float32Array(n * 3);
  const opacity = new Float32Array(n);
  const sh0 = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const { values, vectors } = symmetricEigen(data.covariances, i * 6);
    for (let k = 0; k < 3; k++) scale[i * 3 + k] = Math.sqrt(Math.max(values[k]!, 0));
    const q = quaternionOfMatrix(vectors);
    // One sign for every splat (w ≥ 0), so the file compresses better.
    const sign = q[3] < 0 ? -1 : 1;
    for (let k = 0; k < 4; k++) rotation[i * 4 + k] = Math.round(sign * q[k]! * 32767);
    for (let k = 0; k < 3; k++) sh0[i * 3 + k] = (data.colors[i * 4 + k]! / 255 - 0.5) / SH_C0;
    opacity[i] = data.colors[i * 4 + 3]! / 255;
  }
  const prefix = `${KHR_GAUSSIAN_SPLATTING}:`;
  const vertex = { target: ARRAY_BUFFER };
  const attributes: Record<string, number> = {
    POSITION: builder.accessor(data.positions, FLOAT, 'VEC3', n, { ...vertex, minMax: true }),
    [`${prefix}ROTATION`]: builder.accessor(rotation, SHORT, 'VEC4', n, {
      ...vertex,
      normalized: true,
    }),
    [`${prefix}SCALE`]: builder.accessor(scale, FLOAT, 'VEC3', n, vertex),
    [`${prefix}OPACITY`]: builder.accessor(opacity, FLOAT, 'SCALAR', n, vertex),
    [`${prefix}SH_DEGREE_0_COEF_0`]: builder.accessor(sh0, FLOAT, 'VEC3', n, vertex),
  };
  if (skin) {
    const per = skin.bonesPerSplat;
    let most = 0;
    for (let i = 0; i < n * per; i++) most = Math.max(most, Number(skin.indices[i]));
    const joints = most > 255 ? new Uint16Array(n * 4) : new Uint8Array(n * 4);
    const weights = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = 0; k < per; k++) sum += Math.max(0, Number(skin.weights[i * per + k]) || 0);
      // unorm8 weights that sum to exactly 255, the remainder on the heaviest.
      let stored = 0;
      let heaviest = 0;
      for (let k = 0; k < per; k++) {
        joints[i * 4 + k] = Number(skin.indices[i * per + k]);
        const w =
          sum > 0 ? Math.max(0, Number(skin.weights[i * per + k]) || 0) / sum : k === 0 ? 1 : 0;
        weights[i * 4 + k] = Math.round(w * 255);
        stored += weights[i * 4 + k]!;
        if (weights[i * 4 + k]! > weights[i * 4 + heaviest]!) heaviest = k;
      }
      weights[i * 4 + heaviest] = weights[i * 4 + heaviest]! + 255 - stored;
    }
    attributes.JOINTS_0 = builder.accessor(
      joints,
      most > 255 ? UNSIGNED_SHORT : UNSIGNED_BYTE,
      'VEC4',
      n,
      vertex,
    );
    attributes.WEIGHTS_0 = builder.accessor(weights, UNSIGNED_BYTE, 'VEC4', n, {
      ...vertex,
      normalized: true,
    });
  }
  return attributes;
}

/** Bone locals of a pose: rotation and translation relative to the parent. */
function locals(skeleton: SplatGlbSkeleton, world: ArrayLike<number>): Rigid[] {
  const bones = skeleton.names.map((_, i) => readRigid(world, i));
  return bones.map((bone, i) => {
    const parent = skeleton.parents[i]!;
    return parent < 0 ? bone : relative(bones[parent]!, bone);
  });
}

const TRANSLATION_EPSILON = 1e-6;
const ROTATION_EPSILON = 1e-6;

/** Writes the glTF document; returns the `.glb` bytes. */
export function writeSplatGlb(input: SplatGlbInput): Uint8Array {
  const { data, skin, skeleton } = input;
  if (skin && !skeleton) throw new Error('writeSplatGlb: a skin needs a skeleton.');
  if (input.animations?.length && !skeleton) {
    throw new Error('writeSplatGlb: animations need a skeleton.');
  }
  const name = input.name ?? 'splats';
  const builder = new BinaryBuilder();
  const attributes = writeSplats(builder, data, skin);

  const nodes: Record<string, unknown>[] = [{ name, children: [] as number[] }];
  const rootChildren = nodes[0]!.children as number[];
  const boneNode = (bone: number): number => bone + 1;
  const bind = skeleton ? locals(skeleton, skeleton.world) : [];
  if (skeleton) {
    skeleton.names.forEach((boneName, i) => {
      const local = bind[i]!;
      const node: Record<string, unknown> = {
        name: boneName,
        rotation: quaternionOfMatrix(local.r),
        translation: local.t,
      };
      nodes.push(node);
    });
    skeleton.parents.forEach((parent, i) => {
      if (parent < 0) rootChildren.push(boneNode(i));
      else {
        const parentNode = nodes[boneNode(parent)]!;
        ((parentNode.children ??= []) as number[]).push(boneNode(i));
      }
    });
  }
  const splatNode: Record<string, unknown> = { name: `${name}.splats`, mesh: 0 };
  nodes.push(splatNode);
  rootChildren.push(nodes.length - 1);

  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: input.generator ?? 'VLAM! splat-gltf' },
    extensionsUsed: [KHR_GAUSSIAN_SPLATTING],
    scene: 0,
    scenes: [{ name, nodes: [0] }],
    nodes,
    meshes: [
      {
        name,
        primitives: [
          {
            mode: 0,
            attributes,
            extensions: {
              [KHR_GAUSSIAN_SPLATTING]: { kernel: 'ellipse', colorSpace: 'srgb_rec709_display' },
            },
          },
        ],
      },
    ],
  };

  if (skin && skeleton) {
    const inverses = new Float32Array(skeleton.names.length * 16);
    skeleton.names.forEach((_, i) => {
      const { r, t } = readRigid(skeleton.world, i);
      // inverse = [Rᵀ | −Rᵀt], column-major.
      const o = i * 16;
      for (let c = 0; c < 3; c++) {
        for (let row = 0; row < 3; row++) inverses[o + c * 4 + row] = r[c * 3 + row]!;
      }
      for (let row = 0; row < 3; row++) {
        inverses[o + 12 + row] = -(r[row]! * t[0] + r[3 + row]! * t[1] + r[6 + row]! * t[2]);
      }
      inverses[o + 15] = 1;
    });
    splatNode.skin = 0;
    json.skins = [
      {
        name,
        joints: skeleton.names.map((_, i) => boneNode(i)),
        inverseBindMatrices: builder.accessor(inverses, FLOAT, 'MAT4', skeleton.names.length),
      },
    ];
  }

  if (skeleton && input.animations?.length) {
    json.animations = input.animations.map((animation) =>
      writeAnimation(builder, skeleton, bind, animation, boneNode),
    );
  }

  json.accessors = builder.accessors;
  json.bufferViews = builder.bufferViews;
  const bin = builder.bytes();
  json.buffers = [{ byteLength: bin.byteLength }];
  return packGlb(json, bin);
}

function writeAnimation(
  builder: BinaryBuilder,
  skeleton: SplatGlbSkeleton,
  bind: Rigid[],
  animation: SplatGlbAnimation,
  boneNode: (bone: number) => number,
): Record<string, unknown> {
  const keys = animation.times.length;
  if (keys < 1 || animation.poses.length !== keys) {
    throw new Error(`writeSplatGlb: animation '${animation.name}' needs one pose per key time.`);
  }
  const times = Float32Array.from(animation.times);
  const posed = animation.poses.map((pose) => locals(skeleton, pose));
  let input: number | null = null;
  const channels: Record<string, unknown>[] = [];
  const samplers: Record<string, unknown>[] = [];
  const sampler = (values: Float32Array, type: 'VEC3' | 'VEC4'): number => {
    input ??= builder.accessor(times, FLOAT, 'SCALAR', keys, { minMax: true });
    const output = builder.accessor(values, FLOAT, type, keys);
    samplers.push({ input, output, interpolation: 'LINEAR' });
    return samplers.length - 1;
  };
  skeleton.names.forEach((_, bone) => {
    const rest = bind[bone]!;
    const restQ = quaternionOfMatrix(rest.r);
    const rotation = new Float32Array(keys * 4);
    const translation = new Float32Array(keys * 3);
    let rotates = false;
    let moves = false;
    let previous = restQ;
    for (let k = 0; k < keys; k++) {
      const local = posed[k]![bone]!;
      let q = quaternionOfMatrix(local.r);
      // Keep neighbouring keys in one hemisphere, for a short interpolation.
      if (q[0] * previous[0] + q[1] * previous[1] + q[2] * previous[2] + q[3] * previous[3] < 0) {
        q = q.map((v) => -v) as Quat;
      }
      previous = q;
      rotation.set(q, k * 4);
      translation.set(local.t, k * 3);
      const dot = Math.abs(q[0] * restQ[0] + q[1] * restQ[1] + q[2] * restQ[2] + q[3] * restQ[3]);
      if (1 - dot > ROTATION_EPSILON) rotates = true;
      for (let c = 0; c < 3; c++) {
        if (Math.abs(local.t[c]! - rest.t[c]!) > TRANSLATION_EPSILON) moves = true;
      }
    }
    if (rotates) {
      channels.push({
        sampler: sampler(rotation, 'VEC4'),
        target: { node: boneNode(bone), path: 'rotation' },
      });
    }
    if (moves) {
      channels.push({
        sampler: sampler(translation, 'VEC3'),
        target: { node: boneNode(bone), path: 'translation' },
      });
    }
  });
  if (channels.length === 0) {
    // glTF needs at least one channel: hold the first root bone still.
    const root = skeleton.parents.findIndex((parent) => parent < 0);
    const rest = quaternionOfMatrix(bind[root]!.r);
    const values = new Float32Array(keys * 4);
    for (let k = 0; k < keys; k++) values.set(rest, k * 4);
    channels.push({
      sampler: sampler(values, 'VEC4'),
      target: { node: boneNode(root), path: 'rotation' },
    });
  }
  const out: Record<string, unknown> = { name: animation.name, channels, samplers };
  if (animation.hints) out.extras = { vlam: animation.hints };
  return out;
}

/** The `.glb` container: header, JSON chunk (space-padded), BIN chunk (zero-padded). */
function packGlb(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.byteLength / 4) * 4;
  const binLength = Math.ceil(bin.byteLength / 4) * 4;
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(text, 20);
  out.fill(0x20, 20 + text.byteLength, 20 + jsonLength);
  const binStart = 20 + jsonLength;
  view.setUint32(binStart, binLength, true);
  view.setUint32(binStart + 4, 0x004e4942, true); // 'BIN\0'
  out.set(bin, binStart + 8);
  return out;
}
