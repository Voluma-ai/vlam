/**
 * A procedural Canada goose as Gaussian splats (viewer-only, `?scene=procedural:goose`).
 *
 * The goose is built skeleton-first so it can be rigged later without being
 * regenerated: every splat is authored in the bind pose (wings spread) and
 * carries up to two bone indices and a blend weight, and the pose it is baked
 * in (wings folded by default) comes from the same linear blend skinning a GPU
 * modifier would run. Each flight feather is a bone of its own, carrying its
 * stack of coverts, because a wing folds by closing its feathers like a fan;
 * skinning them rigidly to the arm bones would point them the wrong way.
 *
 * Plumage is laid as overlapping feather shingles of thin, surface-aligned
 * splats with a pale fringe, over an opaque under-layer. Lighting is a soft
 * sky and key light baked from the posed normals: no cast shadows and no
 * view-dependent SH, both of which would be wrong once a bone moves.
 *
 * Model space is metres, +Y up, the goose facing +X and standing on y = 0.
 */
import type { SplatData } from '../lib/core';

type Vec3 = readonly [number, number, number];
type Rgb = readonly [number, number, number];
type Mat3 = readonly [number, number, number, number, number, number, number, number, number];
/** A transform: row-major 3×3 linear part and a translation. */
interface Xf {
  readonly r: Mat3;
  readonly t: Vec3;
}

/** Joint angles of the goose, relative to its standing pose. */
export interface GoosePose {
  /** 0 spreads the wings flat, 1 folds them against the body. Default 1. */
  readonly wingFold?: number;
  /** Lifts the spread wings above the horizontal, in radians (the upstroke of a flap). */
  readonly wingRaise?: number;
  /** Extra bend at each neck joint in radians; positive curls the head forward. Default 0. */
  readonly neckCurl?: number;
  /** Twist at each neck joint in radians; positive turns the head to its left. */
  readonly neckTwist?: number;
  /** Sideways bend at each neck joint in radians; positive leans the neck to its right. */
  readonly neckLean?: number;
  /** Head turn and nod on top of the neck, in radians; positive looks left and down. */
  readonly headYaw?: number;
  readonly headPitch?: number;
  /** Opening angle of the lower mandible in radians. Default 0. */
  readonly billOpen?: number;
  /** Tail swing to the side and lift, in radians. */
  readonly tailWag?: number;
  readonly tailLift?: number;
}

export interface ProceduralGooseOptions {
  readonly pose?: GoosePose;
  /** Seed of the feather jitter; the same seed gives the same goose. Default 1. */
  readonly seed?: number;
  /** Stands the goose on a patch of ground that takes its shadow. Default true. */
  readonly ground?: boolean;
}

/** The skinning data of a {@link ProceduralGoose}, for a GPU rig (`goose-rig.ts`). */
export interface GooseRig {
  /** Bone names; `.R` and `.L` mark the right and left side. */
  readonly bones: readonly string[];
  /** Parent bone index per bone, -1 for the root. */
  readonly parents: readonly number[];
  /** Bone-to-model matrices of the baked pose, 12 floats per bone (3×4, row-major). */
  readonly boneMatrices: Float32Array;
  /** Two bone indices per splat. */
  readonly splatBones: Uint8Array;
  /** Weight of each splat's first bone; the second bone has the rest. */
  readonly splatWeights: Float32Array;
}

/** What the baked lighting was computed from, for a rig that relights as bones move. */
export interface GooseSurface {
  /** Unlit color and opacity, 4 bytes per splat, where `data.colors` holds the lit color. */
  readonly albedo: Uint8Array;
  /** Unit surface normal per splat in the baked pose, 3 floats. */
  readonly normals: Float32Array;
  /** Sheen strength per splat, 0..1. */
  readonly gloss: Float32Array;
  /**
   * How much of the folded wings' shadow falls on each splat, 0..1 in thirds.
   * It is baked into `data.colors`; a rig fades it as the wings open.
   */
  readonly wingShade: Float32Array;
}

export interface ProceduralGoose {
  readonly data: SplatData;
  readonly rig: GooseRig;
  readonly surface: GooseSurface;
}

const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (lo: number, hi: number, x: number): number => {
  const t = clamp01((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
};

const fullPose = (pose: GoosePose = {}): Required<GoosePose> => ({
  wingFold: clamp01(pose.wingFold ?? 1),
  wingRaise: pose.wingRaise ?? 0,
  neckCurl: pose.neckCurl ?? 0,
  neckTwist: pose.neckTwist ?? 0,
  neckLean: pose.neckLean ?? 0,
  headYaw: pose.headYaw ?? 0,
  headPitch: pose.headPitch ?? 0,
  billOpen: pose.billOpen ?? 0,
  tailWag: pose.tailWag ?? 0,
  tailLift: pose.tailLift ?? 0,
});

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > 1e-12 ? [a[0] / length, a[1] / length, a[2] / length] : [1, 0, 0];
};
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  mix(a[0], b[0], t),
  mix(a[1], b[1], t),
  mix(a[2], b[2], t),
];
const tint = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k];

const IDENTITY_3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const IDENTITY: Xf = { r: IDENTITY_3, t: [0, 0, 0] };

const translation = (x: number, y: number, z: number): Xf => ({ r: IDENTITY_3, t: [x, y, z] });

/** Rotation about the X (0), Y (1) or Z (2) axis. */
function rotation(axis: 0 | 1 | 2, angle: number): Xf {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const r: Mat3 =
    axis === 0
      ? [1, 0, 0, 0, c, -s, 0, s, c]
      : axis === 1
        ? [c, 0, s, 0, 1, 0, -s, 0, c]
        : [c, -s, 0, s, c, 0, 0, 0, 1];
  return { r, t: [0, 0, 0] };
}

const rotate = (r: Mat3, v: Vec3): Vec3 => [
  r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
  r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
  r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
];

const mul3 = (a: Mat3, b: Mat3): Mat3 => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
  a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
  a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
  a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
  a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
  a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
  a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];

const mul = (a: Xf, b: Xf): Xf => ({ r: mul3(a.r, b.r), t: add(rotate(a.r, b.t), a.t) });
const compose = (...parts: Xf[]): Xf => parts.reduce(mul);
const applyPoint = (a: Xf, p: Vec3): Vec3 => add(rotate(a.r, p), a.t);

/** Inverse of a rigid transform (rotation and translation only). */
function invertRigid(a: Xf): Xf {
  const r: Mat3 = [a.r[0], a.r[3], a.r[6], a.r[1], a.r[4], a.r[7], a.r[2], a.r[5], a.r[8]];
  return { r, t: scale(rotate(r, a.t), -1) };
}

/** The transform mirrored across the z = 0 plane. */
function mirrorZ(a: Xf): Xf {
  const r = a.r;
  return {
    r: [r[0], r[1], -r[2], r[3], r[4], -r[5], -r[6], -r[7], r[8]],
    t: [a.t[0], a.t[1], -a.t[2]],
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Anatomy (body-local metres unless noted; the body frame is tilted in model space) ---

const BODY_TILT = 10 * DEG;
const BODY_REAR = -0.24;
const BODY_FRONT = 0.2;
const BODY_LENGTH = BODY_FRONT - BODY_REAR;
const BODY_RADIUS = 0.112;
/** Half-width over half-height: the bare body is slim, the folded wings make up the rest. */
const BODY_WIDTH = 0.87;

const NECK_POINTS: readonly (readonly [number, number])[] = [
  [0.125, 0.045],
  [0.185, 0.125],
  [0.212, 0.215],
  [0.198, 0.3],
  [0.205, 0.355],
];
const NECK_BONES = 5;
/** Path parameter below which the neck wears breast plumage instead of black. */
const NECK_SOCK = 0.1;
const HEAD_ANGLE = -18 * DEG;
const HEAD_CENTER: Vec3 = [0.012, 0.014, 0];
const HEAD_HALF_LENGTH = 0.038;
const BILL_BASE_X = HEAD_CENTER[0] + HEAD_HALF_LENGTH - 0.004;
const GAPE_Y = HEAD_CENTER[1] - 0.0085;
const BILL_LENGTH = 0.058;

const TAIL_BASE: Vec3 = [-0.222, 0.02, 0];
const HIP: Vec3 = [-0.03, -0.045, 0.046];
const TIBIA_ANGLE = -35 * DEG;
const TIBIA_LENGTH = 0.08;
const TARSUS_ANGLE = 0;
const TARSUS_LENGTH = 0.1;
/** Height of the foot joint above the ground. */
const FOOT_HEIGHT = 0.0125;

const SHOULDER: Vec3 = [0.09, 0.07, 0.07];
const HUMERUS_LENGTH = 0.13;
const FOREARM_LENGTH = 0.15;
const HAND_LENGTH = 0.11;
/** In-plane angle of each arm bone, [spread, folded]: 0 points out, positive forward. */
const ARM_ANGLES = [
  [-10 * DEG, -98 * DEG],
  [15 * DEG, 50 * DEG],
  [-15 * DEG, -98 * DEG],
] as const;
/** Folding drops the wing about the body axis, onto the flank. */
const WING_ROLL = 72 * DEG;

type FeatherKind = 'primary' | 'secondary' | 'tertial';

/** A flight feather of the right wing; each is a bone carrying its coverts. */
interface WingFeather {
  readonly name: string;
  readonly kind: FeatherKind;
  /** Arm bone it grows from: 0 humerus, 1 forearm, 2 hand. */
  readonly arm: 0 | 1 | 2;
  /** Distance of its base along that bone. */
  readonly along: number;
  /** In-plane angle when spread and when folded. */
  readonly spread: number;
  readonly folded: number;
  /** Folded stacking height, so inner feathers lie over outer ones. */
  readonly lift: number;
  readonly length: number;
  readonly width: number;
}

const WING_FEATHERS: readonly WingFeather[] = (() => {
  const feathers: WingFeather[] = [];
  for (let i = 0; i < 10; i++) {
    const f = i / 9;
    feathers.push({
      name: `primary${i}`,
      kind: 'primary',
      arm: 2,
      along: HAND_LENGTH * ((i + 0.5) / 10),
      spread: mix(-80, -22, f ** 1.3) * DEG,
      folded: mix(-106, -102, f) * DEG,
      lift: 0.0005 + 0.0002 * (9 - i),
      length: 0.2 + 0.07 * (1 - ((i - 6.5) / 6.5) ** 2),
      width: mix(0.036, 0.028, f),
    });
  }
  for (let j = 0; j < 14; j++) {
    const f = j / 13;
    feathers.push({
      name: `secondary${j}`,
      kind: 'secondary',
      arm: 1,
      along: FOREARM_LENGTH * (1 - (j + 0.5) / 14),
      spread: mix(-84, -92, f) * DEG,
      folded: mix(-100, -92, f) * DEG,
      lift: 0.003 + 0.0002 * j,
      length: mix(0.17, 0.16, f),
      width: 0.045,
    });
  }
  for (let k = 0; k < 4; k++) {
    feathers.push({
      name: `tertial${k}`,
      kind: 'tertial',
      arm: 0,
      along: HUMERUS_LENGTH * (1 - (k + 0.5) / 4),
      spread: mix(-95, -110, k / 3) * DEG,
      folded: (-90 - k) * DEG,
      lift: 0.0055 + 0.0005 * k,
      length: 0.19 - 0.02 * k,
      width: 0.05,
    });
  }
  return feathers;
})();

// --- Plumage (sRGB 0..255) ---

interface Plumage {
  readonly base: Rgb;
  readonly tip: Rgb;
  /** Visible feather length. */
  readonly length: number;
  /** How far the tip stands off the body; scapulars drape over the folded wing. */
  readonly lift: number;
  /** Width of the pale fringe at the tip, in metres. */
  readonly fringe: number;
}

const LIFT = 0.0045;
const BACK: Plumage = {
  base: [66, 53, 42],
  tip: [170, 152, 126],
  length: 0.034,
  lift: LIFT,
  fringe: 0.004,
};
const SCAPULAR: Plumage = {
  base: [64, 51, 40],
  tip: [176, 158, 132],
  length: 0.06,
  lift: 0.007,
  fringe: 0.0055,
};
const FLANK: Plumage = {
  base: [116, 96, 75],
  tip: [204, 188, 166],
  length: 0.027,
  lift: LIFT,
  fringe: 0.0055,
};
const BELLY: Plumage = {
  base: [192, 182, 166],
  tip: [228, 222, 210],
  length: 0.02,
  lift: LIFT,
  fringe: 0.004,
};
const BREAST: Plumage = {
  base: [150, 136, 118],
  tip: [222, 212, 196],
  length: 0.017,
  lift: LIFT,
  fringe: 0.0035,
};
const WHITE: Plumage = {
  base: [220, 216, 208],
  tip: [246, 244, 238],
  length: 0.026,
  lift: LIFT,
  fringe: 0.004,
};
const RUMP: Plumage = {
  base: [22, 21, 22],
  tip: [36, 35, 36],
  length: 0.022,
  lift: LIFT,
  fringe: 0.002,
};
const TAIL_COVERT: Plumage = {
  base: [222, 218, 210],
  tip: [246, 244, 238],
  length: 0.04,
  lift: LIFT,
  fringe: 0.005,
};
const BLACK: Rgb = [22, 21, 23];
const BILL: Rgb = [36, 34, 32];
const LEG: Rgb = [44, 43, 44];

const blend = (a: Plumage, b: Plumage, t: number): Plumage => ({
  base: mixRgb(a.base, b.base, t),
  tip: mixRgb(a.tip, b.tip, t),
  length: mix(a.length, b.length, t),
  lift: mix(a.lift, b.lift, t),
  fringe: mix(a.fringe, b.fringe, t),
});

/** Smooth value noise in 0..1 over a 2D lattice. */
function noise2(x: number, y: number): number {
  const hash = (i: number, j: number): number => {
    const h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const i = Math.floor(x);
  const j = Math.floor(y);
  const u = smoothstep(0, 1, x - i);
  const v = smoothstep(0, 1, y - j);
  return mix(mix(hash(i, j), hash(i + 1, j), u), mix(hash(i, j + 1), hash(i + 1, j + 1), u), v);
}

/** Shifts a color warmer (`k` > 0) or cooler, as worn and fresh feathers differ. */
const warm = (c: Rgb, k: number): Rgb => [c[0] * (1 + 0.05 * k), c[1], c[2] * (1 - 0.08 * k)];

/** Body plumage at a surface point: `s` runs tail (0) to breast (1), `theta` from the top. */
function bodyPlumage(s: number, theta: number): Plumage {
  const side = theta > Math.PI ? TAU - theta : theta;
  const top = 1 - smoothstep(0.3 * Math.PI, 0.45 * Math.PI, side);
  const under = smoothstep(0.62 * Math.PI, 0.8 * Math.PI, side);
  let plumage = blend(FLANK, BACK, top);
  const shoulder = smoothstep(0.12 * Math.PI, 0.22 * Math.PI, side) * top;
  plumage = blend(
    plumage,
    SCAPULAR,
    shoulder * smoothstep(0.42, 0.55, s) * (1 - smoothstep(0.8, 0.9, s)),
  );
  plumage = blend(plumage, BELLY, under);
  plumage = blend(plumage, BREAST, smoothstep(0.74, 0.92, s));
  plumage = blend(plumage, WHITE, under * (1 - smoothstep(0.4, 0.55, s)));
  plumage = blend(plumage, RUMP, top * (1 - smoothstep(0.24, 0.3, s)));
  return blend(plumage, TAIL_COVERT, 1 - smoothstep(0.1, 0.15, s));
}

function bodyRadius(s: number): number {
  const u = 0.06 + 0.94 * Math.min(Math.max(s, -0.05), 1);
  const profile = Math.sqrt(Math.max(0, 1 - Math.abs(2 * u - 1) ** 2.2));
  return Math.max(0.002, BODY_RADIUS * profile * (0.45 + 0.55 * smoothstep(0, 0.5, s)));
}

const bodyCentre = (s: number): number => 0.03 * (1 - s) ** 2 - 0.012;
/** The belly is flatter than the back. */
const BODY_BELLY = 0.88;

function bodySurface(s: number, theta: number): Vec3 {
  const r = bodyRadius(s);
  const c = Math.cos(theta);
  return [
    mix(BODY_REAR, BODY_FRONT, s),
    bodyCentre(s) + r * (c >= 0 ? 1 : BODY_BELLY) * c,
    BODY_WIDTH * r * Math.sin(theta),
  ];
}

/** Approximate distance of a body-local point outside the body surface (negative inside). */
function bodyClearance(p: Vec3): number {
  const s = (p[0] - BODY_REAR) / BODY_LENGTH;
  const dy = p[1] - bodyCentre(Math.min(s, 1));
  const rho = Math.hypot(dy / (dy >= 0 ? 1 : BODY_BELLY), p[2] / BODY_WIDTH);
  // Past the tip of the breast, the distance to the tip keeps the field smooth.
  return s > 1 ? Math.hypot(rho, p[0] - BODY_FRONT) : rho - bodyRadius(s);
}

/** Unit outward normal of the body at a point on or near its surface. */
function bodyNormal(p: Vec3): Vec3 {
  const h = 4e-4;
  return normalize([
    bodyClearance([p[0] + h, p[1], p[2]]) - bodyClearance([p[0] - h, p[1], p[2]]),
    bodyClearance([p[0], p[1] + h, p[2]]) - bodyClearance([p[0], p[1] - h, p[2]]),
    bodyClearance([p[0], p[1], p[2] + h]) - bodyClearance([p[0], p[1], p[2] - h]),
  ]);
}

/** Where the breast faces forward: it is covered from the front, not in rings. */
const BREAST_CAP = 0.9;

/**
 * Surface coordinates `[s, theta]` of the body point nearest `q`. Along the
 * body that is the point at the same x. On the breast cap the surface faces
 * forward and x says little, so `cap` solves for the point with the same
 * front view (y, z) instead.
 */
function bodyCoords(q: Vec3, cap: boolean): readonly [number, number] {
  const angle = (s: number): number => {
    const dy = q[1] - bodyCentre(s);
    return Math.atan2(q[2] / BODY_WIDTH, dy / (dy >= 0 ? 1 : BODY_BELLY));
  };
  if (!cap) {
    const s = (q[0] - BODY_REAR) / BODY_LENGTH;
    return [s, angle(s)];
  }
  // The radius shrinks steadily from mid-body to the tip of the breast.
  let lo = 0.6;
  let hi = 1;
  for (let k = 0; k < 14; k++) {
    const mid = (lo + hi) / 2;
    const dy = q[1] - bodyCentre(mid);
    const rho = Math.hypot(dy / (dy >= 0 ? 1 : BODY_BELLY), q[2] / BODY_WIDTH);
    if (rho > bodyRadius(mid)) hi = mid;
    else lo = mid;
  }
  return [lo, angle(lo)];
}

/** Catmull-Rom through {@link NECK_POINTS}, `t` in 0..1 from the body to the head joint. */
function neckPoint(t: number): Vec3 {
  const last = NECK_POINTS.length - 1;
  const x = Math.min(Math.max(t, 0), 1) * last;
  const i = Math.min(Math.floor(x), last - 1);
  const f = x - i;
  const at = (k: number): readonly [number, number] =>
    NECK_POINTS[Math.min(Math.max(k, 0), last)] as readonly [number, number];
  const spline = (axis: 0 | 1): number => {
    const p0 = at(i - 1)[axis];
    const p1 = at(i)[axis];
    const p2 = at(i + 1)[axis];
    const p3 = at(i + 2)[axis];
    return (
      0.5 *
      (2 * p1 +
        (p2 - p0) * f +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f +
        (3 * p1 - p0 - 3 * p2 + p3) * f * f * f)
    );
  };
  return [spline(0), spline(1), 0];
}

// --- Skeleton ---

const armAngle = (arm: 0 | 1 | 2, fold: number): number =>
  mix(ARM_ANGLES[arm][0], ARM_ANGLES[arm][1], fold);

/** Each right arm bone relative to its parent (the body for the humerus). */
function armLocals(fold: number, raise = 0): readonly [Xf, Xf, Xf] {
  return [
    compose(
      translation(...SHOULDER),
      rotation(0, WING_ROLL * fold - raise),
      rotation(1, armAngle(0, fold)),
    ),
    compose(translation(0, 0, HUMERUS_LENGTH), rotation(1, armAngle(1, fold) - armAngle(0, fold))),
    compose(translation(0, 0, FOREARM_LENGTH), rotation(1, armAngle(2, fold) - armAngle(1, fold))),
  ];
}

/**
 * A feather bone relative to its arm bone; `tuck` tips it toward the body and
 * `roll` turns it about its shaft.
 */
function featherLocal(feather: WingFeather, fold: number, tuck: number, roll: number): Xf {
  return compose(
    translation(0, 0, feather.along),
    rotation(1, mix(feather.spread, feather.folded, fold) - armAngle(feather.arm, fold)),
    rotation(0, tuck),
    translation(0, feather.lift * (0.25 + 0.75 * fold), 0),
    // Each vane is also tilted like a blind's slat, so neighbours overlap one way.
    rotation(2, roll + 6 * DEG),
  );
}

/**
 * How each folded feather settles on the body, so the wing wraps the flank
 * and back instead of lying in one flat plane: `tuck` tips it toward the body
 * as far as it can go without sinking into the plumage, and `roll` turns its
 * vane to face the way the body surface under it does.
 */
const FOLDED_FIT: readonly { readonly tuck: number; readonly roll: number }[] = (() => {
  const [humerus, forearm, hand] = armLocals(1);
  const arms = [humerus, mul(humerus, forearm), mul(mul(humerus, forearm), hand)] as const;
  return WING_FEATHERS.map((feather) => {
    const shaftAt = (tuck: number): Xf => mul(arms[feather.arm], featherLocal(feather, 1, tuck, 0));
    let tuck = 0;
    for (let degrees = 24; degrees > 0 && tuck === 0; degrees--) {
      const shaft = shaftAt(degrees * DEG);
      let clear = true;
      // The base stays where its bone is; only the free two thirds can settle.
      for (let k = 2; k <= 6 && clear; k++) {
        const p = applyPoint(shaft, [0, 0, (feather.length * k) / 6]);
        clear = p[2] > 0.012 && bodyClearance(p) > 0.007;
      }
      if (clear) tuck = degrees * DEG;
    }
    const shaft = shaftAt(tuck);
    const p = applyPoint(shaft, [0, 0, feather.length * 0.35]);
    const gradient = (axis: 0 | 1 | 2): number => {
      const step: [number, number, number] = [0, 0, 0];
      step[axis] = 1e-3;
      return bodyClearance(add(p, step)) - bodyClearance(sub(p, step));
    };
    const outward = rotate(
      invertRigid(shaft).r,
      normalize([gradient(0), gradient(1), gradient(2)]),
    );
    const roll = Math.max(-70 * DEG, Math.min(70 * DEG, Math.atan2(-outward[0], outward[1])));
    return { tuck, roll };
  });
})();

interface Skeleton {
  readonly names: string[];
  readonly parents: number[];
  readonly world: Xf[];
  /** Index of the first right-side bone; the left side follows as a mirror. */
  readonly sideStart: number;
  readonly sideCount: number;
}

function buildSkeleton(pose: Required<GoosePose>): Skeleton {
  const names: string[] = [];
  const parents: number[] = [];
  const world: Xf[] = [];
  const bone = (name: string, parent: number, local: Xf): number => {
    names.push(name);
    parents.push(parent);
    world.push(parent < 0 ? local : mul(world[parent] as Xf, local));
    return names.length - 1;
  };

  const body = bone('body', -1, rotation(2, BODY_TILT));
  let parent = body;
  let previousAngle = 0;
  let previousLength = 0;
  for (let k = 0; k < NECK_BONES; k++) {
    const from = neckPoint(k / NECK_BONES);
    const to = neckPoint((k + 1) / NECK_BONES);
    const angle = Math.atan2(from[0] - to[0], to[1] - from[1]);
    const offset = k === 0 ? translation(from[0], from[1], 0) : translation(0, previousLength, 0);
    parent = bone(
      `neck${k}`,
      parent,
      compose(
        offset,
        rotation(2, angle - previousAngle - pose.neckCurl),
        rotation(1, pose.neckTwist),
        rotation(0, pose.neckLean),
      ),
    );
    previousAngle = angle;
    previousLength = Math.hypot(to[0] - from[0], to[1] - from[1]);
  }
  const head = bone(
    'head',
    parent,
    compose(
      translation(0, previousLength, 0),
      rotation(2, HEAD_ANGLE - previousAngle - pose.headPitch),
      rotation(1, pose.headYaw),
    ),
  );
  bone('jaw', head, compose(translation(BILL_BASE_X, GAPE_Y, 0), rotation(2, -pose.billOpen)));
  bone(
    'tail',
    body,
    compose(translation(...TAIL_BASE), rotation(1, pose.tailWag), rotation(2, -pose.tailLift)),
  );

  const sideStart = names.length;
  const tibia = bone('tibia.R', body, compose(translation(...HIP), rotation(2, TIBIA_ANGLE)));
  const tarsus = bone(
    'tarsus.R',
    tibia,
    compose(translation(0, -TIBIA_LENGTH, 0), rotation(2, TARSUS_ANGLE - TIBIA_ANGLE)),
  );
  const foot = bone(
    'foot.R',
    tarsus,
    compose(translation(0, -TARSUS_LENGTH, 0), rotation(2, -TARSUS_ANGLE - BODY_TILT)),
  );

  const fold = pose.wingFold;
  const locals = armLocals(fold, pose.wingRaise);
  const humerus = bone('humerus.R', body, locals[0]);
  const forearm = bone('forearm.R', humerus, locals[1]);
  const hand = bone('hand.R', forearm, locals[2]);
  const arms = [humerus, forearm, hand] as const;
  WING_FEATHERS.forEach((feather, i) => {
    const fit = FOLDED_FIT[i] as { tuck: number; roll: number };
    bone(
      `${feather.name}.R`,
      arms[feather.arm],
      featherLocal(feather, fold, fit.tuck * fold, fit.roll * fold),
    );
  });

  const sideCount = names.length - sideStart;
  for (let i = 0; i < sideCount; i++) {
    const source = sideStart + i;
    const sourceParent = parents[source] as number;
    names.push((names[source] as string).replace(/\.R$/, '.L'));
    parents.push(sourceParent < sideStart ? sourceParent : sourceParent + sideCount);
    world.push(mirrorZ(world[source] as Xf));
  }

  // Stand the feet on the ground.
  const lift = FOOT_HEIGHT - (world[foot] as Xf).t[1];
  for (let i = 0; i < world.length; i++) {
    const w = world[i] as Xf;
    world[i] = { r: w.r, t: [w.t[0], w.t[1] + lift, w.t[2]] };
  }
  // The ground is its own root, so it stays put whatever the goose does.
  names.push('ground');
  parents.push(-1);
  world.push(IDENTITY);
  return { names, parents, world, sideStart, sideCount };
}

// --- Splat authoring ---

/** Collects bind-pose splats; positions and axes are given in the current `frame`. */
class SplatSink {
  readonly positions: number[] = [];
  /** Row-major 3×3 per splat whose columns are the scaled axes, so Σ = M·Mᵀ. */
  readonly axes: number[] = [];
  readonly colors: number[] = [];
  readonly alphas: number[] = [];
  readonly gloss: number[] = [];
  readonly bones: number[] = [];
  readonly weights: number[] = [];
  private frame: Xf = IDENTITY;
  private boneA = 0;
  private boneB = 0;
  private weightA = 1;

  get count(): number {
    return this.alphas.length;
  }

  /** Authors what follows in `frame`, bound to `bone`. */
  bind(frame: Xf, bone: number): void {
    this.frame = frame;
    this.skin(bone, bone, 1);
  }

  skin(boneA: number, boneB: number, weightA: number): void {
    this.boneA = boneA;
    this.boneB = boneB;
    this.weightA = weightA;
  }

  /** A splat at `p` with orthonormal axes `u`, `v`, `n` and standard deviations per axis. */
  add(
    p: Vec3,
    u: Vec3,
    v: Vec3,
    n: Vec3,
    su: number,
    sv: number,
    sn: number,
    color: Rgb,
    alpha = 0.92,
    gloss = 0,
  ): void {
    const { r } = this.frame;
    const P = applyPoint(this.frame, p);
    const U = rotate(r, u);
    const V = rotate(r, v);
    const N = rotate(r, n);
    this.positions.push(P[0], P[1], P[2]);
    this.axes.push(
      U[0] * su,
      V[0] * sv,
      N[0] * sn,
      U[1] * su,
      V[1] * sv,
      N[1] * sn,
      U[2] * su,
      V[2] * sv,
      N[2] * sn,
    );
    this.colors.push(color[0], color[1], color[2]);
    this.alphas.push(alpha);
    this.gloss.push(gloss);
    this.bones.push(this.boneA, this.boneB);
    this.weights.push(this.weightA);
  }

  /** Appends a z-mirrored copy of splats `[from, count)`, with bones remapped. */
  mirror(from: number, mirrorBone: (bone: number) => number): void {
    const end = this.count;
    for (let i = from; i < end; i++) {
      this.positions.push(
        this.positions[i * 3] as number,
        this.positions[i * 3 + 1] as number,
        -(this.positions[i * 3 + 2] as number),
      );
      for (let k = 0; k < 9; k++) {
        const value = this.axes[i * 9 + k] as number;
        this.axes.push(k >= 6 ? -value : value);
      }
      for (let k = 0; k < 3; k++) this.colors.push(this.colors[i * 3 + k] as number);
      this.alphas.push(this.alphas[i] as number);
      this.gloss.push(this.gloss[i] as number);
      this.bones.push(
        mirrorBone(this.bones[i * 2] as number),
        mirrorBone(this.bones[i * 2 + 1] as number),
      );
      this.weights.push(this.weights[i] as number);
    }
  }
}

/** Where a point of a feather lies: position, surface normal, shaft and across directions. */
interface Placement {
  readonly p: Vec3;
  readonly n: Vec3;
  readonly t: Vec3;
  readonly w: Vec3;
}
/** Maps feather coordinates (`x` across, `d` along the shaft, `lift` off the surface). */
type Place = (x: number, d: number, lift: number) => Placement;

interface FeatherSpec {
  readonly length: number;
  readonly width: number;
  /** Fraction of the length where the rounded tip begins. */
  readonly tipStart: number;
  /** Splat spacing along and across the feather, in metres. */
  readonly grain: readonly [number, number];
  /** Fraction of the length that lies under the feathers in front and is not drawn. */
  readonly hidden?: number;
  readonly liftBase: number;
  readonly liftTip: number;
  /** Color at `a` (-1..1 across), `b` (0..1 along) and `edge` (metres inside the outline). */
  readonly color: (a: number, b: number, edge: number) => Rgb;
  /** Color of the shaft, drawn when given. */
  readonly shaft?: Rgb;
  /** Opacity of the loose barbs that stray past the tip; none when absent. */
  readonly wisps?: number;
}

/**
 * One feather. Each column of splats is a bundle of barbs: thin splats laid
 * along the barb direction, sharing a tone and ending at their own length, so
 * the vane shows streaks and a frayed tip instead of a clean outline.
 */
function addFeather(sink: SplatSink, rng: () => number, place: Place, spec: FeatherSpec): void {
  const { length, width, tipStart } = spec;
  const rows = Math.max(3, Math.ceil(length / spec.grain[0]));
  const columns = Math.max(3, Math.ceil(width / spec.grain[1]));
  const firstRow = Math.floor((spec.hidden ?? 0) * rows);
  const reach = 1 - tipStart;
  const lift = (b: number): number => mix(spec.liftBase, spec.liftTip, b);
  const barbAxes = (at: Placement, a: number): readonly [Vec3, Vec3, Vec3] => {
    // Barbs leave the shaft outward and toward the tip.
    const barb = 0.6 * Math.max(-1, Math.min(1, a * 2));
    const u = normalize(add(scale(at.t, Math.cos(barb)), scale(at.w, Math.sin(barb))));
    const v = normalize(cross(at.n, u));
    return [u, v, cross(u, v)];
  };
  for (let j = 0; j < columns; j++) {
    const tone = 0.9 + 0.2 * rng();
    const ragged = 0.9 + 0.13 * rng();
    // Now and then the vane has parted and a bundle stops short.
    const parted = rng() < 0.06 ? 0.6 + 0.3 * rng() : 2;
    const centre = ((j + 0.5) / columns) * 2 - 1;
    const tipEnd = (a: number): number =>
      Math.min(parted, tipStart + reach * Math.sqrt(Math.max(0, 1 - a * a)) * ragged);
    for (let i = firstRow; i < rows; i++) {
      const b = (i + 0.3 + 0.4 * rng()) / rows;
      const a = centre + (0.8 * (rng() - 0.5)) / columns;
      const side = b < tipStart ? mix(0.55, 1, b / tipStart) : 1;
      const end = tipEnd(a);
      if (b > end || Math.abs(a) > side) continue;
      const at = place(a * 0.5 * width, b * length, lift(b));
      const [u, v, n] = barbAxes(at, a);
      const edge = Math.min((end - b) * length, (side - Math.abs(a)) * 0.5 * width);
      sink.add(
        at.p,
        u,
        v,
        n,
        (length / rows) * 0.8,
        Math.max((width / columns) * 0.45, 0.0006),
        0.0005,
        tint(spec.color(a, b, edge), tone),
      );
    }
    if (spec.wisps && rng() < 0.6) {
      const b = tipEnd(centre) + 0.02 + 0.05 * rng();
      const at = place(centre * 0.5 * width, b * length, lift(1) + 0.0004);
      const [u, v, n] = barbAxes(at, centre);
      sink.add(
        at.p,
        u,
        v,
        n,
        0.0022,
        0.0005,
        0.0004,
        tint(spec.color(centre, 1, 0), tone),
        spec.wisps,
      );
    }
  }
  if (!spec.shaft) return;
  const steps = Math.ceil(rows * 1.5);
  for (let i = Math.floor((spec.hidden ?? 0) * steps); i < steps; i++) {
    const b = (i + 0.5) / steps;
    const at = place(0, b * length * 0.95, lift(b) + 0.0003);
    const v = normalize(cross(at.n, at.t));
    sink.add(
      at.p,
      at.t,
      v,
      cross(at.t, v),
      (length / steps) * 0.7,
      Math.max(0.0004, width * 0.014 * (1 - 0.6 * b)),
      0.0004,
      spec.shaft,
    );
  }
}

/**
 * A contour feather's coloring: darkest where the feather in front lies over
 * it and brightening to the tip, a slightly darker centre, and a soft pale
 * fringe. Together the rows read as overlapping shingles with depth.
 */
function contourColor(
  plumage: Plumage,
  shade: number,
  rng: () => number,
  rootShade = 0.62,
): (a: number, b: number, edge: number) => Rgb {
  return (a, b, edge) => {
    const fringe = 0.85 * (1 - smoothstep(0, plumage.fringe, edge)) * smoothstep(0.3, 0.7, b);
    const depth = mix(rootShade, 1, smoothstep(0.25, 0.9, b));
    const centre = 1 - 0.1 * Math.max(0, 1 - Math.abs(a) * 4);
    return tint(
      mixRgb(tint(plumage.base, depth * centre), plumage.tip, fringe),
      shade * (0.96 + 0.08 * rng()),
    );
  };
}

interface TubeSpec {
  /** Centre line, `t` in 0..1. */
  readonly path: (t: number) => Vec3;
  /** Radii along the two cross-section axes. */
  readonly radii: (t: number) => readonly [number, number];
  /** Not parallel to the path; the first cross-section axis is `tangent × reference`. */
  readonly reference: Vec3;
  /** Ring spacing along the surface, and splat spacing around a ring. */
  readonly spacing: number;
  readonly around: number;
  /** Standard deviations along the path, around it and through the surface. */
  readonly size: readonly [number, number, number];
  readonly color: (t: number, phi: number, p: Vec3) => Rgb;
  /** Angular range around the path; the whole ring by default. */
  readonly phi?: readonly [number, number];
  readonly alpha?: number;
  readonly gloss?: number | ((t: number, phi: number) => number);
  /** Skin per ring: two bones and the weight of the first. */
  readonly skin?: (t: number) => readonly [number, number, number];
}

/** A tube of surface-aligned splats around a path: necks, legs, toes, the head and the bill. */
function addTube(sink: SplatSink, rng: () => number, spec: TubeSpec): void {
  const [lo, hi] = spec.phi ?? [0, TAU];
  const surface = (t: number, phi: number): Vec3 => {
    const centre = spec.path(t);
    const tangent = normalize(sub(spec.path(t + 1e-3), spec.path(t - 1e-3)));
    const n1 = normalize(cross(tangent, spec.reference));
    const n2 = cross(tangent, n1);
    const [r1, r2] = spec.radii(Math.min(Math.max(t, 0), 1));
    return add(centre, add(scale(n1, r1 * Math.cos(phi)), scale(n2, r2 * Math.sin(phi))));
  };
  let t = 0.002;
  while (t < 1) {
    const [r1, r2] = spec.radii(t);
    const perimeter = (hi - lo) * Math.sqrt((r1 * r1 + r2 * r2) / 2);
    const count = Math.max(3, Math.round(perimeter / spec.around));
    const phase = rng();
    if (spec.skin) sink.skin(...spec.skin(t));
    for (let k = 0; k < count; k++) {
      const phi = lo + ((k + phase) / count) * (hi - lo);
      const p = surface(t, phi);
      const u = normalize(sub(surface(t + 2e-3, phi), surface(t - 2e-3, phi)));
      const around = normalize(sub(surface(t, phi + 0.02), surface(t, phi - 0.02)));
      let n = normalize(cross(u, around));
      if (dot(n, sub(p, spec.path(t))) < 0) n = scale(n, -1);
      const v = normalize(cross(n, u));
      sink.add(
        p,
        u,
        v,
        cross(u, v),
        spec.size[0],
        spec.size[1],
        spec.size[2],
        spec.color(t, phi, p),
        spec.alpha,
        typeof spec.gloss === 'function' ? spec.gloss(t, phi) : spec.gloss,
      );
    }
    const mid = (lo + hi) / 2;
    const step = sub(surface(t + 1e-3, mid), surface(t, mid));
    const speed = Math.hypot(step[0], step[1], step[2]) / 1e-3;
    t += Math.min(Math.max(spec.spacing / Math.max(speed, 1e-6), 2e-4), 0.05);
  }
}

// --- Parts ---

/** Body-local point where the neck leaves the body; feathers near it lean with the neck. */
const NECK_ROOT: Vec3 = [0.155, 0.085, 0];

function addBody(
  sink: SplatSink,
  rng: () => number,
  body: number,
  neck: number,
  tail: number,
): void {
  // Opaque under-layer, so no gap between feathers shows through the goose.
  const underlay = (p: Vec3, plumage: Plumage): void => {
    const n = bodyNormal(p);
    const t = normalize(cross(n, Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]));
    const w = cross(n, t);
    sink.add(
      sub(p, scale(n, 0.001)),
      t,
      w,
      n,
      0.0048,
      0.0048,
      0.001,
      mixRgb(plumage.base, plumage.tip, 0.3),
      1,
    );
  };
  /** Visits a jittered grid over the breast cap as seen from the front. */
  const overCap = (spacing: number, visit: (s: number, theta: number) => void): void => {
    const reach = bodyRadius(BREAST_CAP);
    const centre = bodyCentre(1);
    for (let y = -reach; y <= reach; y += spacing) {
      for (let z = -reach; z <= reach; z += spacing) {
        const q: Vec3 = [
          BODY_FRONT,
          centre + y + spacing * (rng() - 0.5),
          z + spacing * (rng() - 0.5),
        ];
        const [s, theta] = bodyCoords(q, true);
        if (s >= BREAST_CAP) visit(s, theta);
      }
    }
  };
  for (let s = 0; s < BREAST_CAP; s += 0.007 / BODY_LENGTH) {
    const count = Math.max(4, Math.round((TAU * bodyRadius(s)) / 0.007));
    for (let k = 0; k < count; k++) {
      const theta = ((k + rng()) / count) * TAU;
      underlay(bodySurface(s, theta), bodyPlumage(s, theta));
    }
  }
  overCap(0.006, (s, theta) => underlay(bodySurface(s, theta), bodyPlumage(s, theta)));
  // The rear end, under the tail coverts.
  sink.add(
    [mix(BODY_REAR, BODY_FRONT, -0.02), bodyCentre(-0.02), 0],
    [0, 0, 1],
    [0, 1, 0],
    [-1, 0, 0],
    0.014,
    0.014,
    0.006,
    tint(TAIL_COVERT.base, 0.9),
    1,
  );

  const feather = (s0: number, theta0: number): void => {
    const p0 = bodySurface(s0, theta0);
    const n0 = bodyNormal(p0);
    const cap = s0 > BREAST_CAP - 0.04;
    // Feathers lie back along the body; on the breast they also sweep down
    // from the neck, so they never meet in a point at the front.
    const flow: Vec3 = [-1, -0.9 * smoothstep(0.72, 0.98, s0), 0];
    const f0 = normalize(sub(flow, scale(n0, dot(flow, n0))));
    const w0 = cross(n0, f0);
    // Broad patches of the plumage run a little darker, lighter, warmer or cooler.
    const patch = noise2(s0 * 7 + 2 * Math.cos(theta0), 2 * Math.sin(theta0));
    const hue = 2 * noise2(s0 * 5 + 9 + 1.5 * Math.cos(theta0), 4 + 1.5 * Math.sin(theta0)) - 1;
    const regional = bodyPlumage(s0, theta0);
    const plumage: Plumage = {
      ...regional,
      base: warm(regional.base, hue),
      tip: warm(regional.tip, hue),
    };
    // No two feathers lie quite the same way.
    const skew = 0.35 * (rng() - 0.5);
    const place: Place = (x0, d0, lift) => {
      const x = x0 * Math.cos(skew) - d0 * Math.sin(skew);
      const d = x0 * Math.sin(skew) + d0 * Math.cos(skew);
      const p = bodySurface(...bodyCoords(add(p0, add(scale(f0, d), scale(w0, x))), cap));
      const n = bodyNormal(p);
      const t = normalize(sub(f0, scale(n, dot(f0, n))));
      return { p: add(p, scale(n, lift)), n, t, w: cross(n, t) };
    };
    // Feathers around the foot of the neck lean with it, and the rump
    // feathers around the tail swing with it, so neither turns at a seam.
    const toNeck = sub(p0, NECK_ROOT);
    const toTail = sub(p0, TAIL_BASE);
    const neckFollow = 0.6 * (1 - smoothstep(0.05, 0.12, Math.hypot(...toNeck)));
    const tailFollow = 0.75 * (1 - smoothstep(0.03, 0.1, Math.hypot(...toTail)));
    if (tailFollow > neckFollow) sink.skin(body, tail, 1 - tailFollow);
    else sink.skin(body, neck, 1 - neckFollow);
    const length = plumage.length * (0.8 + 0.45 * rng());
    addFeather(sink, rng, place, {
      length,
      width: length * (0.75 + 0.2 * rng()),
      tipStart: 0.55 + 0.12 * rng(),
      grain: [0.0023, 0.0021],
      hidden: 0.3,
      liftBase: 0.0008,
      liftTip: plumage.lift * (0.8 + 0.5 * rng()),
      color: contourColor(plumage, (0.84 + 0.3 * patch) * (0.93 + 0.14 * rng()), rng),
      wisps: 0.35,
      ...(length > 0.03 ? { shaft: mixRgb(plumage.base, plumage.tip, 0.35) } : {}),
    });
  };
  // Contour feathers in staggered rows, each tip lying over the bases behind it.
  let row = 0;
  for (let s0 = 0; s0 < BREAST_CAP; s0 += 0.0105 / BODY_LENGTH, row++) {
    const count = Math.max(4, Math.round((TAU * bodyRadius(s0)) / 0.0135));
    for (let k = 0; k < count; k++) {
      feather(s0, ((k + 0.5 * (row % 2) + 0.5 * rng()) / count) * TAU);
    }
  }
  overCap(0.0105, feather);
  sink.skin(body, body, 1);
}

/** Black plumage: velvety, with a few feather tips catching the light. */
const blackFeather = (rng: () => number): Rgb =>
  tint(BLACK, rng() < 0.1 ? 1.5 + 1.1 * rng() : 0.65 + 0.55 * rng());

/** The neck's centre line, continued straight below its base into the body. */
function neckPath(t: number): Vec3 {
  if (t >= 0) return neckPoint(t);
  const from = neckPoint(0);
  const slope = scale(sub(neckPoint(0.01), from), 100);
  return add(from, scale(slope, t));
}

function neckRadii(t: number): readonly [number, number] {
  const u = Math.max(t, 0);
  const r = mix(0.058, 0.0235, smoothstep(0, 0.36, u)) - 0.0025 * smoothstep(0.5, 1, u);
  return [r * 1.05, r];
}

const NECK_LENGTH = (() => {
  let length = 0;
  for (let i = 0; i < 40; i++) {
    const step = sub(neckPoint((i + 1) / 40), neckPoint(i / 40));
    length += Math.hypot(step[0], step[1], step[2]);
  }
  return length;
})();

const SOCK: Plumage = {
  base: [18, 17, 19],
  tip: [30, 29, 32],
  length: 0.022,
  lift: 0.0035,
  fringe: 0.002,
};

function addNeck(sink: SplatSink, rng: () => number, skeleton: Skeleton): void {
  const body = skeleton.names.indexOf('body');
  const neck0 = skeleton.names.indexOf('neck0');
  const skin = (t: number): readonly [number, number, number] => {
    const x = Math.min(Math.max(t, 0), 0.9999) * NECK_BONES;
    const k = Math.floor(x);
    const f = x - k;
    // The foot of the neck belongs to the body; above it, each joint blends
    // its two bones over the half-segments around it.
    if (f < 0.5) {
      if (k === 0) return [neck0, body, smoothstep(0, 0.5, f)];
      return [neck0 + k, neck0 + k - 1, 0.5 + 0.5 * smoothstep(0, 0.5, f)];
    }
    const next = k === NECK_BONES - 1 ? neck0 + k : neck0 + k + 1;
    return [neck0 + k, next, 1 - 0.5 * smoothstep(0.5, 1, f)];
  };
  /** The edge of the black sock, an uneven line of feather tips. */
  const sock = (phi: number): number => NECK_SOCK + 0.008 * Math.sin(phi * 17);
  addTube(sink, rng, {
    path: neckPoint,
    radii: neckRadii,
    reference: [0, 0, 1],
    spacing: 0.0022,
    around: 0.0017,
    size: [0.0028, 0.001, 0.0005],
    color: (t, phi) => {
      if (t < sock(phi) + 0.014 * (rng() - 0.5)) {
        return tint(mixRgb(BREAST.base, BREAST.tip, rng()), 0.9 + 0.12 * rng());
      }
      // Faint lengthwise furrows, wandering a little up the neck.
      const furrow = 0.88 + 0.16 * Math.cos(phi * 13 + 2.5 * Math.sin(t * 9));
      return tint(blackFeather(rng), furrow);
    },
    gloss: 0.07,
    skin,
  });

  // Feathers around the foot of the neck: they hang down over the breast and
  // lean with the neck, so the two read as one plumage and not a joint.
  for (let t0 = -0.01, row = 0; t0 < NECK_SOCK + 0.07; t0 += 0.011 / NECK_LENGTH, row++) {
    const [r1, r2] = neckRadii(t0);
    const count = Math.round((Math.PI * (r1 + r2)) / 0.011);
    for (let k = 0; k < count; k++) {
      const phi0 = ((k + 0.5 * (row % 2) + 0.5 * rng()) / count) * TAU;
      const black = t0 > sock(phi0) + 0.012 * (rng() - 0.5);
      // The upper breast pales toward the sock.
      const plumage = black ? SOCK : blend(BREAST, WHITE, 0.4 * smoothstep(0, NECK_SOCK, t0));
      const place: Place = (x, d, lift) => {
        const t = t0 - d / NECK_LENGTH;
        const phi = phi0 + x / r2;
        const centre = neckPath(t);
        const tangent = normalize(sub(neckPath(t + 1e-3), neckPath(t - 1e-3)));
        const n1 = normalize(cross(tangent, [0, 0, 1]));
        const n2 = cross(tangent, n1);
        const [a, b] = neckRadii(t);
        const n = normalize(add(scale(n1, b * Math.cos(phi)), scale(n2, a * Math.sin(phi))));
        const p = add(centre, add(scale(n1, a * Math.cos(phi)), scale(n2, b * Math.sin(phi))));
        const flow = scale(tangent, -1);
        return { p: add(p, scale(n, lift)), n, t: flow, w: cross(n, flow) };
      };
      sink.skin(...skin(t0));
      // Higher up the feathers lie flush, so the collar ends without a step.
      const flush = 1 - smoothstep(NECK_SOCK, NECK_SOCK + 0.07, t0);
      const length = plumage.length * (0.85 + 0.4 * rng());
      addFeather(sink, rng, place, {
        length,
        width: length * (0.7 + 0.2 * rng()),
        tipStart: 0.55 + 0.12 * rng(),
        grain: [0.0021, 0.0019],
        hidden: 0.2,
        liftBase: 0.0006,
        liftTip: 0.0008 + plumage.lift * flush * (0.8 + 0.5 * rng()),
        color: contourColor(plumage, 0.9 + 0.2 * rng(), rng),
        wisps: 0.35,
      });
    }
  }
}

/** White chinstrap coverage at a head-local point, 0..1; `fray` shifts the edge in metres. */
function chinstrap(p: Vec3, fray: number): number {
  const x = p[0] - HEAD_CENTER[0];
  const y = p[1] - HEAD_CENTER[1];
  // Behind a line running from the chin up to behind the eye, ahead of the nape.
  const front = (x - 0.014) * -0.931 + (y + 0.03) * -0.364;
  const back = (x + 0.027) * 0.995 + (y + 0.034) * -0.104;
  return smoothstep(-0.001, 0.001, Math.min(front, back, 0.015 - y) + fray);
}

function addHead(sink: SplatSink, rng: () => number): void {
  const [cx, cy] = HEAD_CENTER;
  addTube(sink, rng, {
    path: (t) => [
      cx + mix(-HEAD_HALF_LENGTH, HEAD_HALF_LENGTH, t),
      cy - 0.004 * smoothstep(0.5, 1, t),
      0,
    ],
    radii: (t) => {
      if (t < 0.4) {
        const cap = Math.sqrt(Math.max(0, 1 - (1 - t / 0.4) ** 2));
        return [0.031 * cap, 0.0265 * cap];
      }
      const taper = smoothstep(0.4, 1, t);
      return [mix(0.031, 0.0145, taper), mix(0.0265, 0.0125, taper)];
    },
    reference: [0, 0, 1],
    spacing: 0.0013,
    around: 0.0011,
    size: [0.0016, 0.0008, 0.0005],
    color: (_t, _phi, p) => {
      // The patch's edge is feather tips, not a line; its feathers shade to cream below.
      const white = chinstrap(p, 0.0022 * (rng() - 0.5));
      const cream = mixRgb(WHITE.tip, [226, 216, 198], smoothstep(0, -0.03, p[1] - cy));
      return mixRgb(blackFeather(rng), tint(cream, 0.86 + 0.14 * rng()), white);
    },
    gloss: 0.08,
  });
  for (const side of [1, -1]) {
    const eye: Vec3 = [cx + 0.011, cy + 0.01, side * 0.0186];
    const out: Vec3 = [0, 0, side];
    const X: Vec3 = [1, 0, 0];
    const Y: Vec3 = [0, side, 0];
    const disc = (
      dx: number,
      dy: number,
      dz: number,
      size: number,
      color: Rgb,
      alpha: number,
      gloss = 0,
    ): void =>
      sink.add(
        [eye[0] + dx, eye[1] + dy, eye[2] + side * dz],
        X,
        Y,
        out,
        size,
        size,
        size * 0.4,
        color,
        alpha,
        gloss,
      );
    // Eyelids, then a dark brown iris around the pupil.
    for (let k = 0; k < 18; k++) {
      const angle = (k / 18) * TAU;
      disc(
        0.0052 * Math.cos(angle),
        0.0046 * Math.sin(angle),
        -0.0004,
        0.001,
        tint([58, 54, 52], 0.85 + 0.3 * rng()),
        0.9,
      );
    }
    disc(0, 0, 0.0002, 0.003, [16, 11, 8], 1);
    for (let k = 0; k < 14; k++) {
      const angle = (k / 14) * TAU;
      disc(
        0.0029 * Math.cos(angle),
        0.0029 * Math.sin(angle),
        0.0006,
        0.0009,
        tint([70, 42, 22], 0.8 + 0.4 * rng()),
        0.85,
        0.5,
      );
    }
    disc(0, 0, 0.001, 0.0016, [6, 5, 5], 1);
    // The catchlight that makes the eye read as wet, and its fainter echo.
    disc(0.0009, 0.0013, 0.0016, 0.00055, [255, 255, 255], 0.95);
    disc(-0.0012, -0.001, 0.0014, 0.0005, [150, 160, 175], 0.35);
  }
}

const MOUTH: Rgb = [168, 96, 94];

/**
 * Upper mandible (head-bound) when `lower` is false, else the lower one in
 * the jaw frame, each with the lining of the mouth it shows when open.
 */
function addMandible(sink: SplatSink, rng: () => number, lower: boolean): void {
  // The tip is a broad, rounded spatula seen from above, blunter in profile.
  const tipRound = (t: number, from = 0.84): number =>
    Math.sqrt(Math.max(0, 1 - smoothstep(from, 1, t) ** 2));
  const origin: Vec3 = lower ? [0, 0, 0] : [BILL_BASE_X, GAPE_Y, 0];
  const length = (lower ? 0.92 : 1) * BILL_LENGTH;
  // Deep at the base, a slightly hollow culmen, then the swell of the nail.
  const depth = (t: number): number =>
    lower
      ? 0.0078 * (1 - 0.5 * t) * tipRound(t)
      : (0.0168 * (1 - 0.62 * t ** 0.85) + 0.0016 * Math.exp(-(((t - 0.9) / 0.07) ** 2))) *
        tipRound(t);
  const width = (t: number): number =>
    (lower ? 0.0108 : 0.0124) * (1 - 0.26 * t) * tipRound(t, 0.72);
  // The nail of the upper mandible hooks down over the lower one.
  const path = (t: number): Vec3 => [
    origin[0] + length * t,
    origin[1] - (lower ? 0 : 0.0022 * smoothstep(0.75, 1, t)),
    0,
  ];
  // Head feathers reach onto the base of the bill in an uneven line.
  const feathered = (t: number, phi: number): boolean => t < 0.06 + 0.06 * noise2(phi * 3, 5);
  // The nostril of the upper mandible, in units of its radius: < 1 inside it.
  // `height` is 0 at the gape and 1 at the culmen.
  const nostril = (t: number, height: number): readonly [number, number] => {
    const along = (t - 0.37) / 0.085;
    const up = (height - 0.56 - 0.4 * (t - 0.37)) / 0.11;
    return [lower ? 9 : Math.hypot(along, up), up];
  };
  addTube(sink, rng, {
    path,
    radii: (t) => [depth(t), width(t)],
    reference: [0, 0, 1],
    spacing: 0.001,
    around: 0.0009,
    size: [0.001, 0.0007, 0.0004],
    // The first cross-section axis points down, so the upper half is the far side of the ring.
    phi: lower ? [-Math.PI / 2, Math.PI / 2] : [Math.PI / 2, (3 * Math.PI) / 2],
    color: (t, phi, p) => {
      if (feathered(t, phi)) return blackFeather(rng);
      // 0 at the gape, 1 at the culmen (or the chin).
      const height = Math.abs(Math.cos(phi));
      // Horn is not even: worn patches, fine growth lines, a paler ridge and nail.
      let tone = 0.72 + 0.5 * noise2(t * 14 + (lower ? 7 : 0), height * 5 + p[2] * 300);
      tone *= 0.95 + 0.07 * Math.sin(height * 38 + 4 * noise2(t * 9, 2));
      let color = mixRgb(BILL, [56, 52, 47], smoothstep(0.84, 0.92, t));
      if (!lower) {
        // The nostril: a dark oval recess with a paler lower lip.
        const [inside, up] = nostril(t, height);
        if (inside < 1) tone = 0.12;
        else if (inside < 1.7 && up < 0.3) tone *= 1.9;
        tone *= 1 + 0.22 * smoothstep(0.78, 1, height);
        // The groove where the nail meets the rest of the bill.
        if (Math.abs(t - 0.825 - 0.03 * (1 - height)) < 0.008) tone *= 0.6;
      }
      // The cutting edge: a paler rim with the comb of lamellae just visible.
      if (height < 0.12 && t < 0.88) {
        color = mixRgb(color, [70, 65, 60], 0.35 + 0.3 * Math.sin(t * 300));
      }
      return tint(color, tone * (0.93 + 0.14 * rng()));
    },
    alpha: 0.97,
    // Horn has a dull sheen, worn matte in places; the nail is polished and
    // the nostril, a hole, has none.
    gloss: (t, phi) => {
      const height = Math.abs(Math.cos(phi));
      if (feathered(t, phi)) return 0.05;
      if (nostril(t, height)[0] < 1) return 0;
      return mix(0.18, 0.5, smoothstep(0.82, 0.9, t)) * (0.5 + noise2(t * 11 + 3, height * 4));
    },
  });

  // The lining: the palate above, the floor of the mouth and the tongue below.
  const facing: Vec3 = [0, lower ? 1 : -1, 0];
  const level = origin[1] + (lower ? -0.0006 : 0.0006);
  for (let t = 0.04; t < 0.9; t += 0.0013 / length) {
    const half = width(t) * 0.85;
    for (let z = -half; z <= half; z += 0.0012) {
      sink.add(
        [origin[0] + length * t, level, z + 0.0006 * (rng() - 0.5)],
        [1, 0, 0],
        lower ? [0, 0, -1] : [0, 0, 1],
        facing,
        0.0011,
        0.001,
        0.0004,
        // Darker toward the throat.
        tint(MOUTH, mix(0.3, 0.95, smoothstep(0, 0.5, t)) * (0.9 + 0.2 * rng())),
        1,
        0.3,
      );
    }
  }
  if (!lower) return;
  addTube(sink, rng, {
    path: (t) => [length * mix(0.1, 0.78, t), -0.0004, 0],
    radii: (t) => {
      const swell = Math.sin(Math.PI * Math.min(Math.max(t, 0), 1)) ** 0.6;
      return [0.0032 * swell, 0.0058 * swell];
    },
    reference: [0, 0, 1],
    spacing: 0.0011,
    around: 0.001,
    size: [0.0011, 0.0008, 0.0004],
    phi: [Math.PI / 2, (3 * Math.PI) / 2],
    color: () => tint([198, 124, 122], 0.9 + 0.2 * rng()),
    gloss: 0.5,
  });
}

function addTail(sink: SplatSink, rng: () => number, tail: Xf, bone: number): void {
  const count = 14;
  for (let i = 0; i < count; i++) {
    const fan = mix(-32, 32, i / (count - 1)) * DEG;
    const outward = Math.abs(i - (count - 1) / 2);
    sink.bind(
      compose(
        tail,
        // The shaft is the frame's +Z: turn it to point back, then fan and arch it.
        rotation(1, -90 * DEG + fan),
        rotation(2, -0.6 * fan),
        translation(0, -0.0015 * outward, 0),
      ),
      bone,
    );
    const length = 0.125 - 0.003 * outward;
    addFeather(sink, rng, flatPlace(0, 0), {
      length,
      width: 0.036,
      tipStart: 0.8,
      grain: [0.0034, 0.003],
      liftBase: 0,
      liftTip: 0,
      color: (_a, _b, edge) =>
        tint(
          mixRgb([26, 24, 24], [58, 53, 48], 1 - smoothstep(0, 0.0025, edge)),
          0.85 + 0.3 * rng(),
        ),
      shaft: [58, 52, 48],
    });
  }
}

/** A flat feather in the current frame: shaft along +Z from `z0`, normal +Y at height `y0`. */
function flatPlace(z0: number, y0: number, x0 = 0): Place {
  return (x, d, lift) => ({
    p: [x0 + x, y0 + lift, z0 + d],
    n: [0, 1, 0],
    t: [0, 0, 1],
    w: [1, 0, 0],
  });
}

function addLeg(sink: SplatSink, rng: () => number, skeleton: Skeleton): void {
  const index = (name: string): number => skeleton.names.indexOf(name);
  const frame = (name: string): Xf => skeleton.world[index(name)] as Xf;

  sink.bind(frame('tibia.R'), index('tibia.R'));
  addTube(sink, rng, {
    path: (t) => [0, -TIBIA_LENGTH * t, 0],
    radii: (t) => {
      const r = mix(0.034, 0.011, smoothstep(0, 0.9, t));
      return [r, r * 0.9];
    },
    reference: [0, 0, 1],
    spacing: 0.003,
    around: 0.0026,
    size: [0.0036, 0.0016, 0.0005],
    color: (t, phi) =>
      tint(
        mixRgb(BELLY.tip, BELLY.base, smoothstep(0.3, 1, t)),
        // Up under the belly little light reaches the leg.
        mix(0.6, 1, smoothstep(0, 0.75, t)) *
          (0.78 + 0.22 * rng()) *
          (0.92 + 0.08 * Math.cos(phi * 9)),
      ),
  });

  // Scutes: a coarse reticulate pattern of lighter and darker scales.
  const scales = (t: number, phi: number, rows: number): number => {
    const cell =
      Math.floor(t * rows) * 7 + Math.floor((phi / TAU) * 7 + (Math.floor(t * rows) % 2) / 2);
    const hash = Math.sin(cell * 127.1) * 43758.5453;
    return 0.75 + 0.5 * (hash - Math.floor(hash));
  };
  sink.bind(frame('tarsus.R'), index('tarsus.R'));
  addTube(sink, rng, {
    path: (t) => [0, -TARSUS_LENGTH * t, 0],
    radii: (t) => {
      const knob = 1 + 0.45 * (1 - smoothstep(0, 0.12, t)) + 0.3 * smoothstep(0.88, 1, t);
      return [0.0085 * knob, 0.0065 * knob];
    },
    reference: [0, 0, 1],
    spacing: 0.0016,
    around: 0.0015,
    size: [0.0014, 0.0012, 0.0005],
    color: (t, phi) => {
      // Broad plates run across the front of the leg, small scales behind.
      const plates =
        Math.cos(phi) < -0.2 ? 0.86 + 0.26 * smoothstep(-0.3, 0.3, Math.sin(t * 105)) : 1;
      const shaded = mix(0.78, 1, smoothstep(0, 0.35, t));
      return tint(LEG, scales(t, phi, 34) * plates * shaded * (0.9 + 0.2 * rng()));
    },
    alpha: 0.97,
    gloss: 0.25,
  });

  sink.bind(frame('foot.R'), index('foot.R'));
  const sole = -FOOT_HEIGHT + 0.004;
  const toes = [
    { angle: -30 * DEG, length: 0.072 },
    { angle: 0, length: 0.086 },
    { angle: 30 * DEG, length: 0.074 },
    { angle: 165 * DEG, length: 0.018 },
  ];
  const toePoint = (toe: { angle: number; length: number }, u: number): Vec3 => [
    toe.length * u * Math.cos(toe.angle),
    mix(-0.003, sole, smoothstep(0, 0.3, u)),
    toe.length * u * Math.sin(toe.angle),
  ];
  for (const toe of toes) {
    addTube(sink, rng, {
      path: (t) => toePoint(toe, t),
      radii: (t) => {
        // Slight swellings at the toe joints, tapering into the claw.
        const r = mix(0.0052, 0.0022, t) * (1 + 0.18 * Math.max(0, Math.sin(t * 9.5)));
        return [r, r * 0.8];
      },
      reference: [0, 1, 0],
      spacing: 0.0015,
      around: 0.0014,
      size: [0.0013, 0.0011, 0.0005],
      color: (t, phi) =>
        tint(mixRgb(LEG, [20, 19, 19], smoothstep(0.85, 0.95, t)), scales(t, phi, 22)),
      alpha: 0.97,
      gloss: 0.25,
    });
  }
  // Webbing between the three forward toes, with a concave trailing edge.
  for (let w = 0; w < 2; w++) {
    const from = toes[w] as { angle: number; length: number };
    const to = toes[w + 1] as { angle: number; length: number };
    for (let i = 0; i < 44; i++) {
      for (let j = 1; j < 22; j++) {
        const across = (j + 0.6 * (rng() - 0.5)) / 22;
        const u = ((i + rng()) / 44) * (0.9 - 0.14 * Math.sin(Math.PI * across));
        if (u < 0.12) continue;
        const a = toePoint(from, u);
        const b = toePoint(to, u);
        const p: Vec3 = [mix(a[0], b[0], across), mix(a[1], b[1], across), mix(a[2], b[2], across)];
        sink.add(
          p,
          [1, 0, 0],
          [0, 0, -1],
          [0, 1, 0],
          0.0016,
          0.0016,
          0.0005,
          tint([40, 38, 38], 0.85 + 0.3 * rng()),
          0.95,
          0.15,
        );
      }
    }
  }
}

const ARM_BROWN: Rgb = [84, 70, 56];
const COVERT: Plumage = {
  base: [80, 66, 52],
  tip: [178, 160, 134],
  length: 0.03,
  lift: 0,
  fringe: 0.0045,
};

function addWing(sink: SplatSink, rng: () => number, skeleton: Skeleton): void {
  const index = (name: string): number => skeleton.names.indexOf(name);
  const frame = (name: string): Xf => skeleton.world[index(name)] as Xf;

  // The arm itself: a thin blade that the coverts lie over.
  const arms = [
    { name: 'humerus.R', length: HUMERUS_LENGTH, radius: [0.014, 0.012] },
    { name: 'forearm.R', length: FOREARM_LENGTH, radius: [0.011, 0.009] },
    { name: 'hand.R', length: HAND_LENGTH, radius: [0.008, 0.004] },
  ] as const;
  for (const arm of arms) {
    sink.bind(frame(arm.name), index(arm.name));
    addTube(sink, rng, {
      path: (t) => [0, 0, arm.length * t],
      radii: (t) => {
        const r = mix(arm.radius[0], arm.radius[1], t);
        return [r * 0.3, r];
      },
      reference: [1, 0, 0],
      spacing: 0.003,
      around: 0.0026,
      size: [0.0034, 0.0018, 0.0005],
      color: () => tint(ARM_BROWN, 0.8 + 0.4 * rng()),
    });
  }

  for (const feather of WING_FEATHERS) {
    const name = `${feather.name}.R`;
    sink.bind(frame(name), index(name));
    const { kind, length, width } = feather;
    const vane: Rgb =
      kind === 'primary' ? [34, 30, 28] : kind === 'secondary' ? [52, 44, 37] : [78, 64, 50];
    const fringe: Rgb = kind === 'tertial' ? [158, 140, 114] : [104, 92, 78];
    const fringeWidth = kind === 'tertial' ? 0.005 : 0.003;
    const shade = 0.88 + 0.24 * rng();
    addFeather(sink, rng, flatPlace(0, 0), {
      length,
      width,
      tipStart: kind === 'primary' ? 0.72 : 0.82,
      grain: [0.0036, 0.0033],
      liftBase: 0,
      liftTip: 0,
      color: (a, _b, edge) =>
        tint(
          mixRgb(
            // The vane is a shade darker along the shaft.
            tint(vane, 1 - 0.12 * Math.max(0, 1 - Math.abs(a) * 3)),
            fringe,
            (1 - smoothstep(0, fringeWidth, edge)) * (kind === 'primary' ? 0.3 : 0.8),
          ),
          shade * (0.94 + 0.12 * rng()),
        ),
      shaft: kind === 'primary' ? [74, 66, 58] : [96, 84, 70],
    });
    // Its coverts, each row lying over the next one's base: one greater and
    // one median, then small lesser and marginal coverts that vary in size and
    // sit a little to either side, so the wing's leading half is scaled like
    // the body rather than striped.
    const reach = kind === 'primary' ? 0.3 : 0.42;
    const tiers = [
      { from: -0.01, to: reach * length, height: 0.002, width: 0.85, sway: 0 },
      { from: -0.016, to: 0.24 * length, height: 0.0031, width: 0.7, sway: 0.2 },
      { from: -0.021, to: 0.13 * length, height: 0.0041, width: 0.55, sway: 0.35 },
      { from: -0.026, to: 0.02, height: 0.005, width: 0.5, sway: 0.4 },
      { from: -0.034, to: -0.004, height: 0.0057, width: 0.45, sway: 0.4 },
    ];
    for (const tier of tiers) {
      const tierLength = (tier.to - tier.from) * (0.8 + 0.4 * rng());
      const tierWidth = width * tier.width * (0.85 + 0.3 * rng());
      addFeather(sink, rng, flatPlace(tier.from, tier.height, width * tier.sway * (rng() - 0.5)), {
        length: tierLength,
        width: tierWidth,
        tipStart: 0.5 + 0.15 * rng(),
        grain: [0.0026, 0.0024],
        liftBase: 0,
        liftTip: 0.0012,
        // A covert's base can show once the wing folds, so it is darkened less.
        color: contourColor(COVERT, 0.84 + 0.3 * rng(), rng, 0.72),
        wisps: 0.3,
        ...(tierLength > 0.035 ? { shaft: mixRgb(COVERT.base, COVERT.tip, 0.4) } : {}),
      });
    }
  }
}

/**
 * A round patch of ground under the goose, fading out at its edge, with the
 * soft shadow of the body and the darker contact shadows of the feet.
 */
function addGround(sink: SplatSink, rng: () => number, feet: readonly Vec3[]): void {
  const reach = 0.45;
  const spacing = 0.011;
  // The key light comes from the front right, so the shadow falls back and left.
  const cast = (height: number): readonly [number, number] => [
    (-KEY_LIGHT[0] / KEY_LIGHT[1]) * height,
    (-KEY_LIGHT[2] / KEY_LIGHT[1]) * height,
  ];
  const blob = (x: number, z: number, cx: number, cz: number, rx: number, rz: number): number =>
    1 - smoothstep(0.35, 1.15, Math.hypot((x - cx) / rx, (z - cz) / rz));
  const [bodyX, bodyZ] = cast(0.26);
  for (let x = -reach; x <= reach; x += spacing) {
    for (let z = -reach; z <= reach; z += spacing) {
      const px = x + spacing * (rng() - 0.5);
      const pz = z + spacing * (rng() - 0.5);
      const edge = Math.hypot(px, pz) / reach + 0.12 * (noise2(px * 9, pz * 9) - 0.5);
      const alpha = 0.96 * (1 - smoothstep(0.5, 1, edge));
      if (alpha < 0.03) continue;
      let light = 1 - 0.5 * blob(px, pz, -0.03 + bodyX, bodyZ, 0.3, 0.17);
      light *= 1 - 0.3 * blob(px, pz, -0.03, 0, 0.24, 0.13);
      for (const foot of feet)
        light *= 1 - 0.55 * blob(px, pz, foot[0] + 0.035, foot[2], 0.07, 0.06);
      const grain = 0.82 + 0.3 * noise2(px * 60, pz * 60) + 0.1 * (rng() - 0.5);
      const patch = 0.9 + 0.2 * noise2(px * 6 + 3, pz * 6);
      sink.add(
        [px, 0.0004, pz],
        [1, 0, 0],
        [0, 0, -1],
        [0, 1, 0],
        spacing * 0.7,
        spacing * 0.7,
        0.0004,
        tint([68, 65, 59], light * grain * patch),
        alpha,
      );
    }
  }
}

/** Wing bones: the arms and every flight feather, on both sides. */
const WING_BONE = /^(humerus|forearm|hand|primary|secondary|tertial)/;

/**
 * Tucks the body's plumage under the folded wings. The folded wing is fitted
 * to the body's surface, but the body's feathers stand off that surface and
 * the wing's feathers are wide, so in places the two share a depth and the
 * flank shows through the wing. Each body splat with folded wing under it or
 * level with it moves inward along its normal until it sits just inside the
 * wing's innermost layer, so the wing always lies on top. The test uses the
 * folded pose whatever pose is baked, so the body is the same in every pose.
 */
function tuckUnderWings(sink: SplatSink, bind: Skeleton, folded: Skeleton): void {
  const cell = 0.003;
  const key = (p: Vec3): number =>
    Math.floor(p[0] / cell) +
    1024 +
    2048 * (Math.floor(p[1] / cell) + 1024 + 2048 * (Math.floor(p[2] / cell) + 1024));
  const skins = folded.world.map((world, i) => mul(world, invertRigid(bind.world[i] as Xf)));
  const isWing = folded.names.map((name) => WING_BONE.test(name));
  const body = folded.names.indexOf('body');
  const at = (i: number): Vec3 => {
    const a = skins[sink.bones[i * 2] as number] as Xf;
    const b = skins[sink.bones[i * 2 + 1] as number] as Xf;
    const w = sink.weights[i] as number;
    const p: Vec3 = [
      sink.positions[i * 3] as number,
      sink.positions[i * 3 + 1] as number,
      sink.positions[i * 3 + 2] as number,
    ];
    const pa = applyPoint(a, p);
    const pb = applyPoint(b, p);
    return [mix(pb[0], pa[0], w), mix(pb[1], pa[1], w), mix(pb[2], pa[2], w)];
  };
  const wing = new Set<number>();
  for (let i = 0; i < sink.count; i++) {
    if (isWing[sink.bones[i * 2] as number]) wing.add(key(at(i)));
  }
  // How far outside a body splat the wing may lie and still need it tucked
  // (feathers have size), how deep a wing stack is looked for, and the gap
  // left under the innermost wing layer.
  const above = 0.006;
  const below = 0.03;
  const gap = 0.004;
  for (let i = 0; i < sink.count; i++) {
    if (sink.bones[i * 2] !== body) continue;
    // The splat's normal is its thin axis, in the bind frame of the body,
    // which the folded pose leaves where it is.
    const n = normalize([
      sink.axes[i * 9 + 2] as number,
      sink.axes[i * 9 + 5] as number,
      sink.axes[i * 9 + 8] as number,
    ]);
    const p = at(i);
    let deepest = -Infinity;
    for (let d = -above; d <= below; d += cell / 2) {
      if (wing.has(key(sub(p, scale(n, d))))) deepest = d;
    }
    if (deepest === -Infinity) continue;
    const push = deepest + gap;
    for (let c = 0; c < 3; c++) {
      sink.positions[i * 3 + c] = (sink.positions[i * 3 + c] as number) - (n[c] as number) * push;
    }
  }
}

/**
 * How much of the wings' shadow falls on each splat that is not part of a
 * wing: a short march up and toward the key light through a grid of the wing
 * splats. It gives the flank its contact shadow under the folded wing.
 */
function wingShade(
  positions: Float32Array,
  normals: Float32Array,
  bones: readonly number[],
  isWing: readonly boolean[],
  skip: number,
): Float32Array {
  const cell = 0.008;
  const key = (x: number, y: number, z: number): number =>
    Math.floor(x / cell) +
    512 +
    1024 * (Math.floor(y / cell) + 512 + 1024 * (Math.floor(z / cell) + 512));
  const count = positions.length / 3;
  const occupied = new Set<number>();
  for (let i = 0; i < count; i++) {
    if (isWing[bones[i * 2] as number]) {
      occupied.add(
        key(
          positions[i * 3] as number,
          positions[i * 3 + 1] as number,
          positions[i * 3 + 2] as number,
        ),
      );
    }
  }
  const shade = new Float32Array(count);
  const rays: readonly Vec3[] = [[0, 1, 0], KEY_LIGHT];
  for (let i = 0; i < count; i++) {
    const bone = bones[i * 2] as number;
    if (isWing[bone] || bone === skip) continue;
    let deepest = 0;
    for (const ray of rays) {
      for (let d = 0.008; d <= 0.056; d += 0.006) {
        const hit = occupied.has(
          key(
            (positions[i * 3] as number) + (normals[i * 3] as number) * 0.003 + ray[0] * d,
            (positions[i * 3 + 1] as number) + (normals[i * 3 + 1] as number) * 0.003 + ray[1] * d,
            (positions[i * 3 + 2] as number) + (normals[i * 3 + 2] as number) * 0.003 + ray[2] * d,
          ),
        );
        if (hit) {
          deepest = Math.max(deepest, 1 - (d - 0.008) / 0.06);
          break;
        }
      }
    }
    // Thirds, so a rig can carry it in two bits.
    shade[i] = Math.round(deepest * 3) / 3;
  }
  return shade;
}

// --- Baking ---

/** Key light direction and the two half-vectors (one per flank) of the baked sheen. */
const KEY_LIGHT = normalize([0.3, 0.9, 0.2]);
const SHEEN = [
  normalize(add(KEY_LIGHT, normalize([0.3, 0.1, 1]))),
  normalize(add(KEY_LIGHT, normalize([0.3, 0.1, -1]))),
] as const;

/**
 * The baked light, exported so `goose-rig.ts` can relight in the shader with
 * the same numbers: a sky term from `sky[0]` (facing down) to `sky[1]` (up),
 * and a key light of strength `key` along `direction`, wrapped by `wrap`.
 */
export const GOOSE_LIGHT = {
  direction: KEY_LIGHT,
  sheen: SHEEN,
  sky: [0.16, 0.42],
  key: 0.75,
  wrap: 0.25,
  sheenStrength: 0.6,
  sheenPower: 24,
  /** How dark the full shadow of a folded wing is. */
  wingShade: 0.5,
  gamma: 2.2,
} as const;

/** Bone-to-model matrices of a pose, 12 floats per bone (3×4, row-major), in rig bone order. */
export function gooseBoneMatrices(pose: GoosePose = {}): Float32Array {
  return packBones(buildSkeleton(fullPose(pose)).world);
}

function packBones(world: readonly Xf[]): Float32Array {
  const out = new Float32Array(world.length * 12);
  world.forEach(({ r, t }, i) => {
    out.set([r[0], r[1], r[2], t[0], r[3], r[4], r[5], t[1], r[6], r[7], r[8], t[2]], i * 12);
  });
  return out;
}

/**
 * The matrix per bone that carries a splat from the pose it was baked in to
 * another: `posed · baked⁻¹`, in the layout of {@link gooseBoneMatrices}.
 * A splat moves by the weighted blend of its two bones' matrices.
 */
export function gooseSkinMatrices(
  posed: Float32Array,
  baked: Float32Array,
  out: Float32Array = new Float32Array(posed.length),
): Float32Array {
  const read = (m: Float32Array, o: number): Xf => ({
    r: [
      m[o] as number,
      m[o + 1] as number,
      m[o + 2] as number,
      m[o + 4] as number,
      m[o + 5] as number,
      m[o + 6] as number,
      m[o + 8] as number,
      m[o + 9] as number,
      m[o + 10] as number,
    ],
    t: [m[o + 3] as number, m[o + 7] as number, m[o + 11] as number],
  });
  for (let o = 0; o < posed.length; o += 12) {
    const { r, t } = mul(read(posed, o), invertRigid(read(baked, o)));
    out.set([r[0], r[1], r[2], t[0], r[3], r[4], r[5], t[1], r[6], r[7], r[8], t[2]], o);
  }
  return out;
}

const toLinear = (byte: number): number => clamp01(byte / 255) ** GOOSE_LIGHT.gamma;
const toByte = (linear: number): number =>
  Math.round(255 * clamp01(linear) ** (1 / GOOSE_LIGHT.gamma));

/**
 * Builds the goose and bakes it in `options.pose`.
 *
 * The returned {@link GooseRig} holds what a skinning modifier needs: per-splat
 * bones and weights, and the bone matrices the splats were baked with. To move
 * a bone later, apply `newBoneMatrix · bakedBoneMatrix⁻¹` to its splats.
 */
export function createProceduralGoose(options: ProceduralGooseOptions = {}): ProceduralGoose {
  const rng = mulberry32(options.seed ?? 1);
  const bind = buildSkeleton(fullPose({ wingFold: 0 }));
  const posed = buildSkeleton(fullPose(options.pose));
  const index = (name: string): number => bind.names.indexOf(name);
  const frame = (name: string): Xf => bind.world[index(name)] as Xf;

  const sink = new SplatSink();
  sink.bind(frame('body'), index('body'));
  addBody(sink, rng, index('body'), index('neck0'), index('tail'));
  addNeck(sink, rng, bind);
  sink.bind(frame('head'), index('head'));
  addHead(sink, rng);
  addMandible(sink, rng, false);
  sink.bind(frame('jaw'), index('jaw'));
  addMandible(sink, rng, true);
  addTail(sink, rng, frame('tail'), index('tail'));
  const sideStart = sink.count;
  addLeg(sink, rng, bind);
  addWing(sink, rng, bind);
  sink.mirror(sideStart, (bone) => (bone < bind.sideStart ? bone : bone + bind.sideCount));
  tuckUnderWings(sink, bind, buildSkeleton(fullPose()));
  const ground = index('ground');
  if (options.ground ?? true) {
    sink.bind(IDENTITY, ground);
    const foot = frame('foot.R').t;
    addGround(sink, rng, [foot, [foot[0], foot[1], -foot[2]]]);
  }

  // Linear blend skinning from the bind pose into the requested one.
  const skins = posed.world.map((world, i) => mul(world, invertRigid(bind.world[i] as Xf)));
  const count = sink.count;
  const positions = new Float32Array(count * 3);
  const covariances = new Float32Array(count * 6);
  const colors = new Uint8Array(count * 4);
  const albedo = new Uint8Array(count * 4);
  const normals = new Float32Array(count * 3);
  const L = GOOSE_LIGHT;
  for (let i = 0; i < count; i++) {
    const a = skins[sink.bones[i * 2] as number] as Xf;
    const b = skins[sink.bones[i * 2 + 1] as number] as Xf;
    const wa = sink.weights[i] as number;
    const r = a.r.map((value, k) => value * wa + (b.r[k] as number) * (1 - wa)) as unknown as Mat3;
    const t: Vec3 = [
      a.t[0] * wa + b.t[0] * (1 - wa),
      a.t[1] * wa + b.t[1] * (1 - wa),
      a.t[2] * wa + b.t[2] * (1 - wa),
    ];
    const p = applyPoint({ r, t }, [
      sink.positions[i * 3] as number,
      sink.positions[i * 3 + 1] as number,
      sink.positions[i * 3 + 2] as number,
    ]);
    positions.set(p, i * 3);
    const m = mul3(r, sink.axes.slice(i * 9, i * 9 + 9) as unknown as Mat3);
    covariances[i * 6] = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
    covariances[i * 6 + 1] = m[0] * m[3] + m[1] * m[4] + m[2] * m[5];
    covariances[i * 6 + 2] = m[0] * m[6] + m[1] * m[7] + m[2] * m[8];
    covariances[i * 6 + 3] = m[3] * m[3] + m[4] * m[4] + m[5] * m[5];
    covariances[i * 6 + 4] = m[3] * m[6] + m[4] * m[7] + m[5] * m[8];
    covariances[i * 6 + 5] = m[6] * m[6] + m[7] * m[7] + m[8] * m[8];

    // The surface normal is the thin axis.
    normals.set(normalize([m[2], m[5], m[8]]), i * 3);
  }

  const isWing = posed.names.map((name) => WING_BONE.test(name));
  const shade = wingShade(positions, normals, sink.bones, isWing, ground);
  for (let i = 0; i < count; i++) {
    // Sky, ground bounce and a wrapped key light, less the shadow of the wings.
    const n: Vec3 = [
      normals[i * 3] as number,
      normals[i * 3 + 1] as number,
      normals[i * 3 + 2] as number,
    ];
    const lit = 1 - L.wingShade * (shade[i] as number);
    const sky = mix(L.sky[0], L.sky[1], 0.5 + 0.5 * n[1]);
    const key = L.key * Math.max(0, (dot(n, L.direction) + L.wrap) / (1 + L.wrap));
    const sheen =
      (sink.gloss[i] as number) *
      L.sheenStrength *
      Math.max(Math.abs(dot(n, L.sheen[0])), Math.abs(dot(n, L.sheen[1]))) ** L.sheenPower;
    for (let c = 0; c < 3; c++) {
      const source = sink.colors[i * 3 + c] as number;
      albedo[i * 4 + c] = Math.round(Math.min(Math.max(source, 0), 255));
      colors[i * 4 + c] = toByte(toLinear(source) * (sky + key) * lit + sheen);
    }
    colors[i * 4 + 3] = albedo[i * 4 + 3] = Math.round(255 * (sink.alphas[i] as number));
  }

  return {
    data: { count, positions, colors, covariances },
    rig: {
      bones: posed.names,
      parents: posed.parents,
      boneMatrices: packBones(posed.world),
      splatBones: Uint8Array.from(sink.bones),
      splatWeights: Float32Array.from(sink.weights),
    },
    surface: { albedo, normals, gloss: Float32Array.from(sink.gloss), wingShade: shade },
  };
}
