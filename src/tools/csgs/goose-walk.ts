/**
 * Builds VLAM's own 4DGS demo clip: the pixel-art goose (`assets/goose.sog`,
 * the mascot sprite extruded into a slab of splats) walking in place and
 * honking, as a looping `.csgs` stream. Run by
 * `scripts/generate-goose-clip.mjs`, which writes `assets/goose-walk/`.
 *
 * The goose is cut into parts by where a splat sits on the 16-pixel sprite
 * grid, and each part follows a small analytic motion:
 *  - the two feet step in turn (lift and swing forward, slide back);
 *  - the body dips between steps;
 *  - the neck and head bob with the walk and, in the second half of the
 *    loop, stretch up for two honks (a smooth blend up the neck, so the
 *    pixels stretch instead of tearing);
 *  - the lower mandible swings open about its hinge during a honk.
 *
 * Almost every motion is a translation rounded to the position grid, so the
 * splats of a part share one knot-to-knot difference and the entropy coder
 * spends next to nothing on them: the clip is one keyed section of the whole
 * goose plus three small delta sections.
 *
 * The source capture is in 3DGS orientation (Y down); the clip is written
 * Y-up with the feet on y = 0, like Faltwerk's clips, so it plays with
 * `orientation: 'source'`.
 */
import type { SplatData } from '../../lib/core/splat-data';
import { csgsStateAfter, type CsgsParams, type CsgsSection } from '../../lib/formats/csgs';
import { encodeCsgsSection } from './encode-csgs';

const SH_C0 = 0.28209479177387814;
/** One sprite pixel in metres: the goose is 16 pixels (1 m) tall. */
const PX = 1 / 16;
const FPS = 32;
const SECTION_FRAMES = 16;
const SECTIONS = 4;
/** Knots of a moving curve: one every 2.5 frames. */
const KNOTS = 7;
/** Knots of the body's dip: the section's first, middle and last pose. */
const BODY_KNOTS = 3;
/** Quantization steps: position (m), quaternion, log-scale, opacity logit, DC color. */
const STEP = { P: 1 / 1024, R: 1 / 128, S: 1 / 32, O: 1 / 8, D: 1 / 128 } as const;

/** Where the parts sit, in sprite pixels: `h` above the ground, `col` from the beak tip back. */
const FOOT_TOP = 2.2;
/** Columns left of this belong to the front foot. */
const FOOT_SPLIT = 2.9;
/** Height of the feet relative to the capture's. */
const FOOT_SQUASH = 0.72;
/** The neck blend runs between these heights; above it the head moves rigidly. */
const NECK_BASE = 8.6;
const NECK_TOP = 11.2;
/** The lower mandible: a thin strip under the upper bill, hinged at its back end. */
// The strip's splats span h 11.7 to 12.2 (its top face is dense at 12.1 to
// 12.2); the gap to the upper bill runs up to 12.5.
const JAW = { hMin: 11.2, hMax: 12.3, colMax: 1.33, hingeCol: 1.33, hingeH: 11.95 } as const;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/** A smooth 0 → 1 → 0 bump: up over `[a, b]`, down over `[c, d]`. */
function bump(a: number, b: number, c: number, d: number, x: number): number {
  return smoothstep(a, b, x) * (1 - smoothstep(c, d, x));
}

/** The pose at loop time `t` (seconds, period 2), in sprite pixels and radians. */
function pose(t: number) {
  const walk = 2 * Math.PI * t; // one stride (two steps) per second
  const foot = (phase: number) => ({
    // Swing (sin > 0): lifted, moving forward (−x). Stance: on the ground, sliding back.
    x: 1.0 * Math.cos(phase),
    // Low enough that the lifted foot stays clear of the white underside.
    y: 0.22 * Math.max(0, Math.sin(phase)),
  });
  const honk = bump(1.0, 1.2, 1.8, 2.0, t);
  return {
    front: foot(walk),
    rear: foot(walk + Math.PI),
    // Lowest with both feet down and apart, never above the standing height.
    // Vertical only: a knot difference the whole body shares in one axis
    // costs the entropy coder ~2 bits per splat and knot, and zero is free.
    bodyY: -0.3 * Math.cos(walk) ** 2,
    head: {
      x: 0.45 * Math.cos(2 * walk) * (1 - 0.6 * honk) - 0.5 * honk,
      y: 1.15 * honk,
    },
    jaw: ((32 * Math.PI) / 180) * (bump(1.15, 1.27, 1.38, 1.5, t) + bump(1.5, 1.62, 1.73, 1.85, t)),
  };
}

/** Eigen-decomposition of a symmetric 3×3 (upper triangle) by Jacobi sweeps. */
function eigenSymmetric(c: ArrayLike<number>, offset: number) {
  const a = [
    [c[offset]!, c[offset + 1]!, c[offset + 2]!],
    [c[offset + 1]!, c[offset + 3]!, c[offset + 4]!],
    [c[offset + 2]!, c[offset + 4]!, c[offset + 5]!],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 12; sweep++) {
    let off = 0;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      off += a[p]![q]! ** 2;
      if (Math.abs(a[p]![q]!) < 1e-300) continue;
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!);
      const tan = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cos = 1 / Math.sqrt(tan * tan + 1);
      const sin = tan * cos;
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
    if (off < 1e-30) break;
  }
  return { values: [a[0]![0]!, a[1]![1]!, a[2]![2]!], vectors: v };
}

/** Quaternion (w, x, y, z) of a rotation matrix given by its columns `m[row][col]`. */
function quaternionOf(m: number[][]): [number, number, number, number] {
  const [m00, m01, m02] = m[0] as [number, number, number];
  const [m10, m11, m12] = m[1] as [number, number, number];
  const [m20, m21, m22] = m[2] as [number, number, number];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    return [s / 4, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return [(m21 - m12) / s, s / 4, (m01 + m10) / s, (m02 + m20) / s];
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return [(m02 - m20) / s, (m01 + m10) / s, s / 4, (m12 + m21) / s];
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, s / 4];
}

type Quaternion = readonly [number, number, number, number];

function multiply(a: Quaternion, b: Quaternion): [number, number, number, number] {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

/** Interleaves the low 10 bits of three integers (Morton order). */
function morton(x: number, y: number, z: number): number {
  const spread = (v: number) => {
    v &= 0x3ff;
    v = (v | (v << 16)) & 0x30000ff;
    v = (v | (v << 8)) & 0x300f00f;
    v = (v | (v << 4)) & 0x30c30c3;
    return (v | (v << 2)) & 0x9249249;
  };
  return (spread(x) | (spread(y) << 1) | (spread(z) << 2)) >>> 0;
}

/** A Faltwerk scene file, as `loadCsgsClip` reads it. */
export interface GooseWalkScene {
  fps: number;
  sections: { url: string; g0: number; nframes: number }[];
  orbit: { center: number[]; up: number[]; front: number[]; dist: number; fovy_deg: number };
  testcams: never[];
}

export interface GooseWalkClip {
  readonly scene: GooseWalkScene;
  /** One `.csgs` file per section, in `scene.sections` order. */
  readonly files: readonly Uint8Array[];
  /** The decoded sections and params the files were encoded from (for checks). */
  readonly sections: readonly CsgsSection[];
  readonly params: CsgsParams;
}

/** Builds the clip from the decoded goose capture (see the module comment). */
export function buildGooseWalk(data: SplatData): GooseWalkClip {
  const count = data.count;
  // Rest pose, Y-up: rotate the 3DGS frame half a turn about X, feet on y = 0.
  let floor = -Infinity;
  let left = Infinity;
  for (let i = 0; i < count; i++) {
    floor = Math.max(floor, data.positions[i * 3 + 1]!);
    left = Math.min(left, data.positions[i * 3]!);
  }
  const flip: Quaternion = [0, 1, 0, 0];
  const rest = Array.from({ length: count }, (_, i) => {
    const x = data.positions[i * 3]!;
    const y = floor - data.positions[i * 3 + 1]!;
    const z = -data.positions[i * 3 + 2]!;
    const { values, vectors } = eigenSymmetric(data.covariances, i * 6);
    // A proper rotation: flip one axis if the eigenvectors form a reflection.
    const det =
      vectors[0]![0]! * (vectors[1]![1]! * vectors[2]![2]! - vectors[1]![2]! * vectors[2]![1]!) -
      vectors[0]![1]! * (vectors[1]![0]! * vectors[2]![2]! - vectors[1]![2]! * vectors[2]![0]!) +
      vectors[0]![2]! * (vectors[1]![0]! * vectors[2]![1]! - vectors[1]![1]! * vectors[2]![0]!);
    if (det < 0) for (let k = 0; k < 3; k++) vectors[k]![2] = -vectors[k]![2]!;
    const alpha = Math.min(Math.max(data.colors[i * 4 + 3]! / 255, 1 / 510), 1 - 1 / 510);
    return {
      x,
      y,
      z,
      h: y / PX,
      col: (x - left) / PX,
      rotation: multiply(flip, quaternionOf(vectors)),
      logScale: values.map((value) => 0.5 * Math.log(Math.max(value, 1e-12))),
      logit: Math.log(alpha / (1 - alpha)),
      dc: [0, 1, 2].map((c) => (data.colors[i * 4 + c]! / 255 - 0.5) / SH_C0),
      // Bill and feet are the only yellow and orange on a white and blue goose.
      warm: data.colors[i * 4 + 2]! < 0.6 * data.colors[i * 4]!,
    };
  });
  // Neighbours in space next to each other, so knot 0 codes as small differences.
  const order = Array.from({ length: count }, (_, i) => i);
  const key = rest.map((s) =>
    morton(
      Math.round((s.x / PX) * 48 + 512),
      Math.round((s.y / PX) * 48),
      Math.round((s.z / PX) * 48 + 512),
    ),
  );
  order.sort((a, b) => key[a]! - key[b]!);

  const grid = (value: number, step: number) => Math.round(value / step);
  const px = (pixels: number) => grid(pixels * PX, STEP.P);
  const groups: CsgsParams['groups'] = [
    ['P', 3],
    ['R', 4],
    ['S', 3],
    ['O', 1],
    ['D', 3],
  ];
  const steps = [
    STEP.P,
    STEP.P,
    STEP.P,
    STEP.R,
    STEP.R,
    STEP.R,
    STEP.R,
    STEP.S,
    STEP.S,
    STEP.S,
  ].concat([STEP.O, STEP.D, STEP.D, STEP.D]);
  const nSn = 45;
  const scales = new Float32Array(steps.length + nSn).fill(1 / 1024);
  scales.set(steps);
  const params: CsgsParams = {
    L: SECTION_FRAMES,
    ks: [1, BODY_KNOTS, KNOTS],
    groups,
    nSn,
    offsets: new Float32Array(steps.length + nSn),
    scales,
    sharedKnot: false,
    keyInterval: SECTIONS,
  };

  const span = SECTION_FRAMES - 1;
  const sections: CsgsSection[] = [];
  const files: Uint8Array[] = [];
  for (let s = 0; s < SECTIONS; s++) {
    const g0 = s * SECTION_FRAMES;
    const poses = Array.from({ length: KNOTS }, (_, j) =>
      pose((g0 + (j * span) / (KNOTS - 1)) / FPS),
    );
    const k = groups.map(() => new Uint8Array(count));
    const knotOff = groups.map(() => new Uint32Array(count + 1));
    const knots: number[][] = groups.map(() => []);
    order.forEach((source, i) => {
      const splat = rest[source]!;
      // By color, not by region: the body's white underside sits right
      // above the feet and must stay with the body.
      const isFoot = splat.warm && splat.h < FOOT_TOP;
      const neck = isFoot ? 0 : smoothstep(NECK_BASE, NECK_TOP, splat.h);
      const isJaw =
        splat.warm &&
        splat.h > JAW.hMin &&
        splat.h < JAW.hMax &&
        splat.col < JAW.colMax &&
        neck > 0.99;
      // The feet are a little shorter than in the capture, so a lifted foot
      // stays below the white underside instead of shining through it.
      const restY = isFoot ? splat.y * FOOT_SQUASH : splat.y;
      const base = [grid(splat.x, STEP.P), grid(restY, STEP.P), grid(splat.z, STEP.P)];
      // The plain body only dips: three knots (a triangle wave) carry that,
      // and its curve costs a third of a seven-knot one.
      const detailed = isFoot || neck > 0;
      k[0]![i] = detailed ? KNOTS : BODY_KNOTS;
      for (const p of detailed ? poses : [poses[0]!, poses[(KNOTS - 1) / 2]!, poses[KNOTS - 1]!]) {
        if (isFoot) {
          const foot = splat.col < FOOT_SPLIT ? p.front : p.rear;
          knots[0]!.push(base[0]! + px(foot.x), base[1]! + px(foot.y), base[2]!);
          continue;
        }
        let x = base[0]!;
        let y = base[1]! + px(p.bodyY);
        const z = base[2]!;
        if (neck > 0) {
          x += px(neck * p.head.x);
          y += px(neck * p.head.y);
        }
        if (isJaw) {
          // Swing about the hinge: the tip (toward −x) goes down.
          const dx = (splat.col - JAW.hingeCol) * PX;
          const dy = (splat.h - JAW.hingeH) * PX;
          const cos = Math.cos(p.jaw);
          const sin = Math.sin(p.jaw);
          x += grid(dx * cos - dy * sin - dx, STEP.P);
          y += grid(dx * sin + dy * cos - dy, STEP.P);
        }
        knots[0]!.push(x, y, z);
      }
      k[1]![i] = isJaw ? KNOTS : 1;
      for (let j = 0; j < (isJaw ? KNOTS : 1); j++) {
        const half = poses[j]!.jaw / 2;
        const q = isJaw
          ? multiply([Math.cos(half), 0, 0, Math.sin(half)], splat.rotation)
          : splat.rotation;
        knots[1]!.push(...q.map((value) => grid(value, STEP.R)));
      }
      k[2]![i] = 1;
      knots[2]!.push(...splat.logScale.map((value) => grid(value, STEP.S)));
      k[3]![i] = 1;
      knots[3]!.push(grid(splat.logit, STEP.O));
      k[4]![i] = 1;
      knots[4]!.push(...splat.dc.map((value) => grid(value, STEP.D)));
      for (let g = 0; g < groups.length; g++) knotOff[g]![i + 1] = knots[g]!.length;
    });
    const keyed = s === 0;
    const section: CsgsSection = {
      index: s,
      g0,
      nframes: SECTION_FRAMES,
      key: keyed,
      n: count,
      nCont: keyed ? 0 : count,
      ids: Uint32Array.from({ length: count }, (_, i) => i),
      birth: new Uint16Array(keyed ? count : 0),
      // Every splat lives through the whole clip.
      death: new Uint16Array(count).fill(SECTION_FRAMES + 1),
      k,
      knotOff,
      knots: knots.map((values) => Int32Array.from(values)),
      sn: new Uint8Array(count * nSn),
    };
    const previous = sections[s - 1];
    files.push(
      encodeCsgsSection(section, params, {
        state: previous ? csgsStateAfter(previous, params) : null,
      }),
    );
    sections.push(section);
  }

  return {
    scene: {
      fps: FPS,
      sections: sections.map((section, s) => ({
        url: `s${String(s).padStart(4, '0')}.csgs`,
        g0: section.g0,
        nframes: section.nframes,
      })),
      // Side on, the way the sprite is drawn.
      orbit: { center: [0, 0.5, 0], up: [0, 1, 0], front: [0, 0, 1], dist: 2.6, fovy_deg: 30 },
      testcams: [],
    },
    files,
    sections,
    params,
  };
}
