/**
 * A live rig for the procedural goose (viewer-only), built on the library's
 * general rigging: the splats of `goose-procedural.ts` in a
 * `SkinnedSplatMesh`, bound to a `THREE.Skeleton` of the goose's bones. A
 * pose costs one small texture upload and no per-splat CPU work.
 *
 * The goose's skeleton is flat: its pose function (`gooseBoneMatrices`)
 * already gives every bone's model-space matrix, so each bone is a root whose
 * matrix is set directly, and the inverse bind matrices are the baked pose's.
 * Any other rig (a glTF character, a hand-built creature) binds the same way
 * with a bone hierarchy instead.
 *
 * On top of the skin, a goose-only modifier relights the unlit color from the
 * turned normal, so a wing is lit from above once it opens. It reads two
 * channels of its own: `gooseSurface` (the baked normal and sheen) and
 * `gooseShade` (the folded wings' shadow on the flanks).
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  clamp,
  dot,
  float,
  int,
  max,
  mix,
  normalize,
  pow,
  sign,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import type { SplatData, SplatMeshOptions, SplatModifier, SplatRange } from '../lib/core';
import { SkinnedSplatMesh } from '../lib/dynamic';
import {
  GOOSE_LIGHT,
  gooseBoneMatrices,
  type GoosePose,
  type ProceduralGoose,
} from './goose-procedural';

const NORMAL_STEPS = 1023;
const GLOSS_STEPS = 15;

/** Strength of the grazing-angle sheen: a gain on the lit color and a small added floor. */
const RIM_GAIN = 0.7;
const RIM_FLOOR = 0.012;

/** An octahedral unit normal in two 10-bit lanes, and the sheen in 4 bits above them. */
export function packGooseSurface(nx: number, ny: number, nz: number, gloss: number): number {
  const sum = Math.abs(nx) + Math.abs(ny) + Math.abs(nz) || 1;
  let x = nx / sum;
  let y = ny / sum;
  if (nz < 0) {
    const fold = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    y = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
    x = fold;
  }
  const lane = (value: number): number => Math.round((value * 0.5 + 0.5) * NORMAL_STEPS);
  const lanes = NORMAL_STEPS + 1;
  return lane(x) + lanes * (lane(y) + lanes * Math.round(gloss * GLOSS_STEPS));
}

/** The CPU inverse of the normal lanes of {@link packGooseSurface}, as the shader decodes it. */
export function unpackGooseNormal(packed: number): [number, number, number] {
  const lanes = NORMAL_STEPS + 1;
  const x = ((packed % lanes) / NORMAL_STEPS) * 2 - 1;
  const y = ((Math.floor(packed / lanes) % lanes) / NORMAL_STEPS) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  const t = Math.max(-z, 0);
  const nx = x - Math.sign(x) * t;
  const ny = y - Math.sign(y) * t;
  const length = Math.hypot(nx, ny, z) || 1;
  return [nx / length, ny / length, z / length];
}

/** A `Matrix4` from 12 floats of the goose layout (3×4, row-major) at `offset`. */
function matrixAt(m: Float32Array, offset: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  const e = (i: number) => m[offset + i]!;
  return out.set(
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
}

/**
 * Relights a skinned splat (see the module comment). It runs after the skin,
 * whose linear part is then `ctx.rotation` and whose posed center is
 * `ctx.localCenter + ctx.offset`.
 */
function gooseLightModifier(wingFold: THREE.UniformNode<'float', number>): SplatModifier {
  const L = GOOSE_LIGHT;
  return (ctx) => {
    const surface = int(ctx.channel('gooseSurface'));
    const lanes = int(NORMAL_STEPS + 1);
    const ex = float(surface.mod(lanes)).div(NORMAL_STEPS).mul(2).sub(1);
    const ey = float(surface.div(lanes).mod(lanes)).div(NORMAL_STEPS).mul(2).sub(1);
    const gloss = float(surface.div(int((NORMAL_STEPS + 1) ** 2))).div(GLOSS_STEPS);
    const ez = float(1).sub(abs(ex)).sub(abs(ey));
    const fold = max(ez.negate(), 0);
    const baked = vec3(ex.sub(sign(ex).mul(fold)), ey.sub(sign(ey).mul(fold)), ez);
    // Context normals stay in the bind pose: turn this one with the skin.
    const n = normalize(ctx.rotation.mul(normalize(baked)));

    // The same sky, key and sheen the generator bakes, from the turned normal.
    const sky = mix(float(L.sky[0]), float(L.sky[1]), n.y.mul(0.5).add(0.5));
    const key = max(
      dot(n, vec3(...L.direction))
        .add(L.wrap)
        .div(1 + L.wrap),
      0,
    ).mul(L.key);
    const sheen = pow(
      max(abs(dot(n, vec3(...L.sheen[0]))), abs(dot(n, vec3(...L.sheen[1])))),
      L.sheenPower,
    )
      .mul(gloss)
      .mul(L.sheenStrength);
    // Feathers scatter light back along grazing angles: a soft rim that rounds
    // the form and gives the black plumage its velvet. View-dependent, so it
    // exists only here and not in the static bake.
    const moved = ctx.localCenter.add(ctx.offset);
    const facing = abs(dot(n, normalize(ctx.cameraLocal.sub(moved))));
    const rim = pow(float(1).sub(facing), 3);
    const shade = ctx.channel('gooseShade');
    const lit = pow(ctx.color.rgb, vec3(L.gamma))
      .mul(sky.add(key))
      // The folded wings' shadow lifts off the flanks as they open.
      .mul(float(1).sub(shade.mul(wingFold).mul(L.wingShade)))
      .mul(rim.mul(RIM_GAIN).add(1))
      .add(rim.mul(RIM_FLOOR))
      .add(sheen);
    return { color: vec4(pow(clamp(lit, 0, 1), vec3(1 / L.gamma)), ctx.color.a) };
  };
}

export interface GooseRigController {
  readonly mesh: SkinnedSplatMesh;
  /** The skin, then the goose's relighting; both on `mesh.modifiers`, exposed for hosts that restack. */
  readonly modifiers: readonly [SplatModifier, SplatModifier];
  /** The goose's one range in the mesh, for channels a host writes (paint's mask). */
  readonly range: SplatRange;
  /** The goose's skeleton: one flat bone per goose bone, named after it. */
  readonly skeleton: THREE.Skeleton;
  /** Moves the goose into `pose`. Cheap enough to call every frame. */
  setPose(pose: GoosePose): void;
  /**
   * The goose's splats in the current pose, on the CPU (`posedSplatData`).
   * Costs a pass over every splat, so call it per query, not per frame.
   */
  posedData(): SplatData;
}

/**
 * Builds the rigged mesh for a goose baked by `createProceduralGoose`.
 * Disposing the mesh releases the rig.
 */
export function createGooseRig(
  goose: ProceduralGoose,
  options: SplatMeshOptions = {},
): GooseRigController {
  const { data, rig, surface } = goose;
  const count = data.count;
  const weights = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    weights[i * 2] = rig.splatWeights[i]!;
    weights[i * 2 + 1] = 1 - rig.splatWeights[i]!;
  }
  // The pool holds the unlit color; the light modifier lights it.
  const mesh = new SkinnedSplatMesh(
    { ...data, colors: surface.albedo },
    { ...options, skin: { bonesPerSplat: 2, indices: rig.splatBones, weights } },
  );

  // Flat bones: each one's matrix is its model-space pose, its inverse bind
  // matrix the baked pose's inverse.
  const bones = rig.bones.map((name) => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.matrixAutoUpdate = false;
    return bone;
  });
  const inverses = bones.map((_, i) => matrixAt(rig.boneMatrices, i * 12).invert());
  const skeleton = new THREE.Skeleton(bones, inverses);
  const place = (matrices: Float32Array): void => {
    bones.forEach((bone, i) => {
      matrixAt(matrices, i * 12, bone.matrix);
      // A matrix set by hand: three recomputes the world matrix only when told.
      bone.matrixWorldNeedsUpdate = true;
    });
  };
  place(rig.boneMatrices);
  // Bone matrices are model-space, not world: skin in the mesh's own frame.
  mesh.bindMode = 'detached';
  mesh.bind(skeleton, new THREE.Matrix4());

  const packedSurface = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    packedSurface[i] = packGooseSurface(
      surface.normals[i * 3]!,
      surface.normals[i * 3 + 1]!,
      surface.normals[i * 3 + 2]!,
      surface.gloss[i]!,
    );
  }
  mesh.defineChannel('gooseSurface');
  mesh.defineChannel('gooseShade');
  mesh.writeChannel(mesh.range, 'gooseSurface', packedSurface);
  mesh.writeChannel(mesh.range, 'gooseShade', surface.wingShade);

  const wingFold = uniform(1);
  const light = gooseLightModifier(wingFold);
  const modifiers = [mesh.skinModifier!, light] as const;
  mesh.modifiers = modifiers;
  return {
    mesh,
    modifiers,
    range: mesh.range,
    skeleton,
    posedData: () => mesh.posedSplatData(),
    setPose(pose) {
      place(gooseBoneMatrices(pose));
      wingFold.value = Math.min(Math.max(pose.wingFold ?? 1, 0), 1);
    },
  };
}
