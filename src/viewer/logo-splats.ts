/**
 * Synthetic splats from a 2D logo bitmap (viewer-only).
 *
 * The VLAM! mark is a flat picture: a white left stroke of the V and a flame
 * splash where the right stroke would be. This module gives such a bitmap real
 * depth so the mark can stand inside a scene. Each ink class is sampled on a
 * grid finer than the bitmap's pixels (bilinear ink and color, so a small
 * logo still yields a smooth silhouette), and the inside distance field of its
 * silhouette drives a rounded extrusion profile:
 *
 *  - a **slab** (the white stroke): an extruded cutout, built the way a
 *    trained capture of a flat object is: flat front and back faces of
 *    surface-aligned opaque discs (small at the rim, coarser inside) and a
 *    straight side wall, so the corners stay hard. A disc's covariance normal
 *    is its surface normal, which the viewer's lighting modifier reads.
 *  - a **volume** (the flame): a rounded profile filled through its
 *    depth with softer isotropic splats, hotter toward the core.
 *
 * On top of those, three sprite-like layers for the flame: a wide soft glow,
 * ember particles the viewer animates, and a light pool on the floor below.
 * Layers are contiguous index ranges in the output so one shader modifier can
 * treat each differently.
 */
import type { SplatData } from '../lib/core';

/** RGBA pixels of a logo bitmap, row-major, top row first. */
export interface LogoBitmap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** How much of a pixel (sRGB bytes + alpha) belongs to an ink class, 0..1. */
export type InkClassifier = (r: number, g: number, b: number, a: number) => number;

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Neutral, bright pixels: the white stroke. Edge pixels fade with their alpha. */
export const whiteInk: InkClassifier = (r, g, b, a) => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return (a / 255) * clamp01(1 - (max - min) / 60) * clamp01((min - 90) / 80);
};

/** Warm pixels (red well above blue): the flame, from its yellow core to red drips. */
export const flameInk: InkClassifier = (r, _g, b, a) => (a / 255) * clamp01((r - b - 40) / 60);

/**
 * Rows `[top, bottom)` of the first ink run in the bitmap: the mark itself,
 * excluding a wordmark set below it after a clear gap. A row counts when any
 * pixel is at least half covered by one of `inks` (stray faint pixels and
 * anti-aliasing halos do not). Small gaps inside the mark (a droplet above
 * the flame) are tolerated up to `gapRows` empty rows.
 */
export function markRows(
  bitmap: LogoBitmap,
  inks: readonly InkClassifier[] = [whiteInk, flameInk],
  gapRows = 8,
): readonly [number, number] {
  const { width, height, data } = bitmap;
  const inked = (y: number): boolean => {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      for (const ink of inks) {
        if (
          ink(
            data[i] as number,
            data[i + 1] as number,
            data[i + 2] as number,
            data[i + 3] as number,
          ) >= 0.5
        ) {
          return true;
        }
      }
    }
    return false;
  };
  let top = 0;
  while (top < height && !inked(top)) top++;
  if (top === height) return [0, height];
  let bottom = top;
  let gap = 0;
  for (let y = top; y < height; y++) {
    if (inked(y)) {
      bottom = y + 1;
      gap = 0;
    } else if (++gap >= gapRows) break;
  }
  return [top, bottom];
}

/** Deterministic PRNG (mulberry32) so a rebuild yields the same mark. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash of a lattice point to [0, 1). */
function latticeHash(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Trilinear value noise in [-1, 1], period-free; cheap enough for every sample. */
function valueNoise(x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fade = (t: number): number => t * t * (3 - 2 * t);
  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const tz = fade(z - z0);
  let result = 0;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const weight = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
        result += weight * latticeHash(x0 + dx, y0 + dy, z0 + dz);
      }
    }
  }
  return result * 2 - 1;
}

/** Growable struct-of-arrays sink for the generated Gaussians. */
class SplatWriter {
  private positions = new Float32Array(3 * 4096);
  private covariances = new Float32Array(6 * 4096);
  private colors = new Uint8Array(4 * 4096);
  count = 0;

  private grow(): void {
    const next = this.positions.length * 2;
    const positions = new Float32Array(next);
    positions.set(this.positions);
    this.positions = positions;
    const covariances = new Float32Array(next * 2);
    covariances.set(this.covariances);
    this.covariances = covariances;
    const colors = new Uint8Array((next / 3) * 4);
    colors.set(this.colors);
    this.colors = colors;
  }

  /**
   * Appends a Gaussian with σ = (`s1`, `s2`, `s3`) along the orthonormal frame
   * (`t1`, `t2`, `n`). Σ = Σᵢ sᵢ² · aᵢ aᵢᵀ is the covariance of that ellipsoid,
   * stored as the upper triangle `SplatData` expects.
   */
  push(
    x: number,
    y: number,
    z: number,
    t1: readonly [number, number, number],
    t2: readonly [number, number, number],
    n: readonly [number, number, number],
    s1: number,
    s2: number,
    s3: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    if ((this.count + 1) * 3 > this.positions.length) this.grow();
    const i = this.count++;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    const q1 = s1 * s1;
    const q2 = s2 * s2;
    const q3 = s3 * s3;
    const c = this.covariances;
    c[i * 6] = q1 * t1[0] * t1[0] + q2 * t2[0] * t2[0] + q3 * n[0] * n[0];
    c[i * 6 + 1] = q1 * t1[0] * t1[1] + q2 * t2[0] * t2[1] + q3 * n[0] * n[1];
    c[i * 6 + 2] = q1 * t1[0] * t1[2] + q2 * t2[0] * t2[2] + q3 * n[0] * n[2];
    c[i * 6 + 3] = q1 * t1[1] * t1[1] + q2 * t2[1] * t2[1] + q3 * n[1] * n[1];
    c[i * 6 + 4] = q1 * t1[1] * t1[2] + q2 * t2[1] * t2[2] + q3 * n[1] * n[2];
    c[i * 6 + 5] = q1 * t1[2] * t1[2] + q2 * t2[2] * t2[2] + q3 * n[2] * n[2];
    this.colors[i * 4] = Math.max(0, Math.min(255, Math.round(r)));
    this.colors[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(g)));
    this.colors[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(b)));
    this.colors[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
  }

  /** An isotropic Gaussian of radius σ. */
  pushPoint(
    x: number,
    y: number,
    z: number,
    sigma: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    this.push(x, y, z, X_AXIS, Y_AXIS, Z_AXIS, sigma, sigma, sigma, r, g, b, a);
  }

  /** A flat disc of radius σ facing `n` (thin axis `thinness`·σ). */
  pushDisc(
    x: number,
    y: number,
    z: number,
    n: readonly [number, number, number],
    sigma: number,
    thinness: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    // Any tangent pair works for a disc; pick the one farthest from the normal.
    const ref = Math.abs(n[1]) < 0.9 ? Y_AXIS : X_AXIS;
    const t1 = normalize(cross(ref, n));
    const t2 = cross(n, t1);
    this.push(x, y, z, t1, t2, n, sigma, sigma, sigma * thinness, r, g, b, a);
  }

  finish(): SplatData {
    return {
      count: this.count,
      positions: this.positions.slice(0, this.count * 3),
      covariances: this.covariances.slice(0, this.count * 6),
      colors: this.colors.slice(0, this.count * 4),
    };
  }
}

type Vec3 = readonly [number, number, number];
const X_AXIS: Vec3 = [1, 0, 0];
const Y_AXIS: Vec3 = [0, 1, 0];
const Z_AXIS: Vec3 = [0, 0, 1];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};

/**
 * One-dimensional squared Euclidean distance transform (Felzenszwalb &
 * Huttenlocher): lower envelope of the parabolas rooted at `f`.
 */
function edt1d(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  const at = (i: number): number => (f[i] as number) + i * i;
  for (let q = 1; q < n; q++) {
    let s = (at(q) - at(v[k] as number)) / (2 * q - 2 * (v[k] as number));
    while (s <= (z[k] as number)) {
      k--;
      s = (at(q) - at(v[k] as number)) / (2 * q - 2 * (v[k] as number));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while ((z[k + 1] as number) < q) k++;
    const root = v[k] as number;
    d[q] = (q - root) * (q - root) + (f[root] as number);
  }
}

/** Large finite "no root here" so parabola differences stay finite. */
const EDT_INF = 1e12;

/**
 * Squared distance from every cell to the nearest cell where `inside` is
 * false, in cells. Cells outside the grid count as outside.
 */
export function squaredDistanceToOutside(
  inside: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(width * height);
  const n = Math.max(width, height) + 2;
  const f = new Float32Array(n);
  const d = new Float32Array(n);
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);
  // Columns, with a virtual outside cell above and below.
  for (let x = 0; x < width; x++) {
    f[0] = 0;
    for (let y = 0; y < height; y++) f[y + 1] = inside[y * width + x] ? EDT_INF : 0;
    f[height + 1] = 0;
    edt1d(f, height + 2, d, v, z);
    for (let y = 0; y < height; y++) out[y * width + x] = d[y + 1] as number;
  }
  // Rows, likewise padded.
  for (let y = 0; y < height; y++) {
    f[0] = 0;
    for (let x = 0; x < width; x++) f[x + 1] = out[y * width + x] as number;
    f[width + 1] = 0;
    edt1d(f, width + 2, d, v, z);
    for (let x = 0; x < width; x++) out[y * width + x] = d[x + 1] as number;
  }
  return out;
}

/** The fine-grid ink field of one ink class, in bitmap-pixel units. */
interface InkField {
  /** Fine cells per bitmap pixel. */
  readonly detail: number;
  readonly width: number;
  readonly height: number;
  /** Bitmap rows covered: fine row 0 is bitmap row `top`. */
  readonly top: number;
  /** Bilinear ink coverage per fine cell, 0..1. */
  readonly ink: Float32Array;
  /** Inside distance to the silhouette per fine cell, in fine cells (0 outside). */
  readonly distance: Float32Array;
}

function buildInkField(
  bitmap: LogoBitmap,
  classify: InkClassifier,
  rows: readonly [number, number],
  detail: number,
): InkField {
  const { width: w, data } = bitmap;
  const [top, bottom] = rows;
  const h = bottom - top;
  const perPixel = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y + top) * w + x) * 4;
      perPixel[y * w + x] = classify(
        data[i] as number,
        data[i + 1] as number,
        data[i + 2] as number,
        data[i + 3] as number,
      );
    }
  }
  const width = w * detail;
  const height = h * detail;
  const ink = new Float32Array(width * height);
  const inside = new Uint8Array(width * height);
  for (let fy = 0; fy < height; fy++) {
    for (let fx = 0; fx < width; fx++) {
      const value = bilinear(perPixel, w, h, (fx + 0.5) / detail, (fy + 0.5) / detail);
      ink[fy * width + fx] = value;
      inside[fy * width + fx] = value >= 0.5 ? 1 : 0;
    }
  }
  const squared = squaredDistanceToOutside(inside, width, height);
  const distance = new Float32Array(width * height);
  for (let i = 0; i < distance.length; i++) {
    if (!inside[i]) continue;
    // The silhouette runs between the boundary cell and its outside neighbor;
    // the ink value says where within that cell it crosses 0.5.
    distance[i] = Math.max(0.05, Math.sqrt(squared[i] as number) - 1 + (ink[i] as number));
  }
  return { detail, width, height, top, ink, distance };
}

/** Bilinear read of a scalar image at continuous pixel coordinates (pixel centers at +0.5). */
function bilinear(image: Float32Array, w: number, h: number, x: number, y: number): number {
  const px = Math.min(Math.max(x - 0.5, 0), w - 1);
  const py = Math.min(Math.max(y - 0.5, 0), h - 1);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = px - x0;
  const ty = py - y0;
  const a = image[y0 * w + x0] as number;
  const b = image[y0 * w + x1] as number;
  const c = image[y1 * w + x0] as number;
  const d = image[y1 * w + x1] as number;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** Alpha-weighted bilinear RGB of the bitmap at continuous pixel coordinates. */
function bilinearColor(bitmap: LogoBitmap, x: number, y: number): [number, number, number] {
  const { width: w, height: h, data } = bitmap;
  const px = Math.min(Math.max(x - 0.5, 0), w - 1);
  const py = Math.min(Math.max(y - 0.5, 0), h - 1);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = px - x0;
  const ty = py - y0;
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  const tap = (xx: number, yy: number, wt: number): void => {
    const i = (yy * w + xx) * 4;
    const alpha = (wt * (data[i + 3] as number)) / 255;
    r += (data[i] as number) * alpha;
    g += (data[i + 1] as number) * alpha;
    b += (data[i + 2] as number) * alpha;
    weight += alpha;
  };
  tap(x0, y0, (1 - tx) * (1 - ty));
  tap(x1, y0, tx * (1 - ty));
  tap(x0, y1, (1 - tx) * ty);
  tap(x1, y1, tx * ty);
  if (weight <= 0) return [0, 0, 0];
  return [r / weight, g / weight, b / weight];
}

/** Box-blurs a scalar field `radius` cells each way (outside counts as 0). */
function blurField(
  field: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  const pass = (source: Float32Array, dx: number, dy: number): Float32Array => {
    const out = new Float32Array(width * height);
    const span = 2 * radius + 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = x + k * dx;
          const sy = y + k * dy;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
          sum += source[sy * width + sx] as number;
        }
        out[y * width + x] = sum / span;
      }
    }
    return out;
  };
  return pass(pass(field, 1, 0), 0, 1);
}

/** Unit gradient of a scalar field at a cell (central differences, outside = 0). */
function gradientOf(
  field: Float32Array,
  width: number,
  height: number,
  fx: number,
  fy: number,
): [number, number] {
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : (field[y * width + x] as number);
  const gx = (at(fx + 1, fy) - at(fx - 1, fy)) * 0.5;
  const gy = (at(fx, fy + 1) - at(fx, fy - 1)) * 0.5;
  const length = Math.hypot(gx, gy);
  return length > 1e-6 ? [gx / length, gy / length] : [0, 0];
}

/** Maps fine-grid cells and bitmap pixels into the mark's local metres. */
interface Frame {
  /** Metres per bitmap pixel. */
  readonly metresPerPixel: number;
  /** Metres per fine cell. */
  readonly cell: number;
  /** Bitmap x of the mark's center (local x = 0). */
  readonly centerX: number;
  /** Bitmap y (bottom edge of the mark rows) that maps to local y = 0. */
  readonly baseY: number;
}

/** Local (x, y) of a fine cell center. */
function toLocal(field: InkField, frame: Frame, fx: number, fy: number): [number, number] {
  const px = (fx + 0.5) / field.detail;
  const py = field.top + (fy + 0.5) / field.detail;
  return [(px - frame.centerX) * frame.metresPerPixel, (frame.baseY - py) * frame.metresPerPixel];
}

/**
 * Half depth of the rounded profile at inside distance `d` (metres): a
 * quarter ellipse `rounding` wide and `halfDepth` tall, then a flat plateau.
 * Returns the depth and its slope (d depth / d distance).
 */
function roundedProfile(d: number, rounding: number, halfDepth: number): [number, number] {
  if (d >= rounding) return [halfDepth, 0];
  const u = rounding - d;
  const root = Math.sqrt(Math.max(1e-6, rounding * rounding - u * u));
  const k = halfDepth / rounding;
  return [root * k, (u / root) * k];
}

/** Stroke slab half depth as a fraction of the stroke's widest half width. */
const STROKE_DEPTH = 0.3;
/** Stroke disc σ per lattice spacing: neighbours overlap into one opaque face. */
const STROKE_COVER = 0.65;
/** Coarsest stroke lattice, fine cells: the interior disc size. */
const STROKE_MAX_SPACING = 16;
/** Thin axis of a stroke disc relative to its radius. */
const STROKE_THINNESS = 0.12;
/** Stroke opacity: a solid surface, as a capture's converged Gaussians are. */
const STROKE_ALPHA = 0.95;

/** Which layers to generate and how big the mark is. */
export interface LogoSplatOptions {
  /** World height of the mark (its ink bounding box), metres. */
  readonly height: number;
  /** Fine samples per bitmap pixel per axis (default 4). */
  readonly detail?: number;
  /** Bitmap rows to use; defaults to {@link markRows}. */
  readonly rows?: readonly [number, number];
  /** Which parts to build; everything by default. */
  readonly parts?: {
    readonly stroke?: boolean;
    readonly flame?: boolean;
    readonly glow?: boolean;
    readonly embers?: boolean;
    readonly pool?: boolean;
  };
  /** Floor level below the mark's base (local y, metres); the light pool sits here. */
  readonly floorY?: number;
  readonly seed?: number;
}

/** A contiguous index range `[start, end)` in the generated `SplatData`. */
export interface LogoLayer {
  readonly start: number;
  readonly end: number;
}

/**
 * The stroke's silhouette as a closed polygon in local xy (x, y pairs,
 * counter-clockwise, evenly spaced along the perimeter) and the slab's half
 * depth: enough to build a solid prism of the same shape, for a relighting
 * proxy or a depth occluder. Ordered by angle around the centroid, which is
 * exact for the mark's convex stroke.
 */
export interface StrokeOutline {
  readonly points: Float32Array;
  readonly halfDepth: number;
}

/** The generated mark plus what the viewer's shader and lights need to know. */
export interface LogoSplats {
  readonly data: SplatData;
  readonly strokeOutline: StrokeOutline;
  readonly layers: {
    readonly stroke: LogoLayer;
    readonly flame: LogoLayer;
    readonly glow: LogoLayer;
    readonly embers: LogoLayer;
    readonly pool: LogoLayer;
  };
  /** Local-space flame centroid: where the mark's light comes from. */
  readonly flameCenter: readonly [number, number, number];
  /**
   * Random points inside the flame body (local xyz triples), denser toward
   * its base: seeds for a host that simulates its own fire in the mark's
   * flame shape instead of drawing the splat flame.
   */
  readonly flameSeeds: Float32Array;
  /** Local y of the flame's base and top: the animation ramps between them. */
  readonly flameBase: number;
  readonly flameTop: number;
  /** Local-space bounds of the stroke and flame bodies. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * Orders raw silhouette crossings (fine u, v pairs) into a closed polygon by
 * angle around their centroid, resampled to `count` points at even spacing
 * along the perimeter. Exact for a convex silhouette such as the stroke.
 */
function orderOutline(
  raw: number[],
  field: InkField,
  frame: Frame,
  halfDepth: number,
  count = 320,
): StrokeOutline {
  const n = raw.length / 2;
  if (n < 3) return { points: new Float32Array(0), halfDepth };
  const local: { x: number; y: number; angle: number }[] = [];
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = toLocal(
      field,
      frame,
      (raw[i * 2] as number) - 0.5,
      (raw[i * 2 + 1] as number) - 0.5,
    );
    cx += x;
    cy += y;
    local.push({ x, y, angle: 0 });
  }
  cx /= n;
  cy /= n;
  for (const point of local) point.angle = Math.atan2(point.y - cy, point.x - cx);
  local.sort((a, b) => a.angle - b.angle);
  const at = (i: number): { x: number; y: number } =>
    local[((i % n) + n) % n] as { x: number; y: number };
  const cumulative = [0];
  for (let i = 1; i <= n; i++) {
    cumulative.push(
      (cumulative[i - 1] as number) + Math.hypot(at(i).x - at(i - 1).x, at(i).y - at(i - 1).y),
    );
  }
  const perimeter = cumulative[n] as number;
  const points = new Float32Array(count * 2);
  let segment = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / count) * perimeter;
    while (segment < n - 1 && (cumulative[segment + 1] as number) < target) segment++;
    const a = at(segment);
    const b = at(segment + 1);
    const span = (cumulative[segment + 1] as number) - (cumulative[segment] as number);
    const t = span > 0 ? (target - (cumulative[segment] as number)) / span : 0;
    points[k * 2] = a.x + (b.x - a.x) * t;
    points[k * 2 + 1] = a.y + (b.y - a.y) * t;
  }
  return { points, halfDepth };
}

/** Builds the VLAM! mark as splats from its bitmap. Local frame: x right, y up, z toward the viewer; the mark's base is at y = 0, centered on x = 0. */
export function buildLogoSplats(bitmap: LogoBitmap, options: LogoSplatOptions): LogoSplats {
  const detail = Math.max(1, Math.round(options.detail ?? 4));
  const rows = options.rows ?? markRows(bitmap);
  const parts = {
    stroke: options.parts?.stroke ?? true,
    flame: options.parts?.flame ?? true,
    glow: options.parts?.glow ?? true,
    embers: options.parts?.embers ?? true,
    pool: options.parts?.pool ?? true,
  };
  const random = createRandom(options.seed ?? 7);
  const writer = new SplatWriter();

  const stroke = buildInkField(bitmap, whiteInk, rows, detail);
  const flame = buildInkField(bitmap, flameInk, rows, detail);
  // The mark's horizontal extent comes from both inks together.
  let inkLeft = Infinity;
  let inkRight = -Infinity;
  for (const field of [stroke, flame]) {
    for (let fy = 0; fy < field.height; fy++) {
      for (let fx = 0; fx < field.width; fx++) {
        if ((field.ink[fy * field.width + fx] as number) < 0.5) continue;
        const px = (fx + 0.5) / detail;
        if (px < inkLeft) inkLeft = px;
        if (px > inkRight) inkRight = px;
      }
    }
  }
  if (!Number.isFinite(inkLeft)) throw new Error('buildLogoSplats: the bitmap has no ink.');
  const metresPerPixel = options.height / (rows[1] - rows[0]);
  const frame: Frame = {
    metresPerPixel,
    cell: metresPerPixel / detail,
    centerX: (inkLeft + inkRight) / 2,
    baseY: rows[1],
  };
  const { cell } = frame;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const extend = (x: number, y: number, z: number): void => {
    if (x < (min[0] as number)) min[0] = x;
    if (y < (min[1] as number)) min[1] = y;
    if (z < (min[2] as number)) min[2] = z;
    if (x > (max[0] as number)) max[0] = x;
    if (y > (max[1] as number)) max[1] = y;
    if (z > (max[2] as number)) max[2] = z;
  };
  const jitter = (): number => (random() - 0.5) * 0.7 * cell;

  // --- stroke: extruded white cutout --------------------------------------
  // Built the way a trained capture of a flat cutout (the demo goose) is: two
  // flat faces, a straight side wall, hard 90° corners, opaque Gaussians that
  // are small along the silhouette and grow toward the interior where nothing
  // needs resolving. A rounded bevel reads as a cushion; this reads as a sign.
  let strokeHalfWidth = 0;
  for (let i = 0; i < stroke.distance.length; i++) {
    if ((stroke.distance[i] as number) > strokeHalfWidth)
      strokeHalfWidth = stroke.distance[i] as number;
  }
  strokeHalfWidth *= cell;
  const slabHalfDepth = strokeHalfWidth * STROKE_DEPTH;
  const strokeStart = writer.count;
  /** Every silhouette crossing the wall is built from: fine u, v pairs. */
  const outlineRaw: number[] = [];
  if (parts.stroke) {
    const { width: w, height: h, ink, distance } = stroke;
    const tintAt = (): number => 246 + random() * 9;
    // Face lattices of spacing S cells (1, 2, 4, …) with σ = STROKE_COVER·S.
    // The finest lattice draws the silhouette: its discs reach half alpha
    // (≈ 1.2σ out) right on it. Coarser discs keep 2.5σ clear of it, where
    // their tail has faded below 5%, so no large Gaussian haloes the edge. A
    // point is dropped where the next coarser lattice already covers it from
    // every side, so each band of the face is tiled by the coarsest discs that
    // fit and only the rim pays for fine ones.
    const reach = (spacing: number): number => (spacing === 1 ? 1.2 : 2.5) * STROKE_COVER * spacing;
    const covered = (spacing: number): number => reach(spacing) + 1.5 * spacing;
    for (let spacing = 1; spacing <= STROKE_MAX_SPACING; spacing *= 2) {
      const coarsest = spacing === STROKE_MAX_SPACING;
      const offset = Math.floor(spacing / 2);
      for (let fy = offset; fy < h; fy += spacing) {
        for (let fx = offset; fx < w; fx += spacing) {
          const d = distance[fy * w + fx] as number;
          if (d < reach(spacing)) continue;
          if (!coarsest && d >= covered(2 * spacing)) continue;
          // An even lattice's point sits on the corner its block of cells shares.
          const shift = spacing > 1 ? -0.5 : 0;
          const [x, y] = toLocal(stroke, frame, fx + shift, fy + shift);
          const tint = tintAt();
          for (const side of [1, -1]) {
            const pz = side * slabHalfDepth;
            writer.pushDisc(
              x,
              y,
              pz,
              [0, 0, side],
              cell * spacing * STROKE_COVER,
              STROKE_THINNESS,
              tint,
              tint,
              tint + 3,
              STROKE_ALPHA,
            );
            extend(x, y, pz);
          }
        }
      }
    }

    // Side wall: a strip of discs standing on the silhouette, facing outward.
    // Rows are fine at both corners and coarsen toward the middle of the depth
    // (the wall is flat there, like the faces' interior).
    const wallRows: { z: number; size: number }[] = [];
    {
      let from = 0;
      let size = cell;
      while (from < slabHalfDepth - 1e-6) {
        const step = Math.min(size, slabHalfDepth - from);
        wallRows.push({ z: slabHalfDepth - from - step / 2, size: step });
        from += step;
        size = Math.min(size * 2, cell * STROKE_MAX_SPACING);
      }
    }
    // Wall normals come from a blurred distance field so they turn smoothly
    // along a curve instead of stepping with the cell grid.
    const smooth = blurField(distance, w, h, 2);
    const inkAt = (x: number, y: number): number =>
      x < 0 || y < 0 || x >= w || y >= h ? 0 : (ink[y * w + x] as number);
    const emitWall = (u: number, v: number, gx: number, gy: number, spacing: number): void => {
      outlineRaw.push(u, v);
      // Silhouette point `(u, v)` in fine-grid units; outward normal in local
      // metres (local y runs against bitmap rows).
      const n: Vec3 = [-gx, gy, 0];
      const along: Vec3 = [-gy, -gx, 0];
      const [bx, by] = toLocal(stroke, frame, u - 0.5, v - 0.5);
      const sigmaAlong = STROKE_COVER * 1.2 * cell * spacing;
      for (const row of wallRows) {
        const sigmaZ = STROKE_COVER * row.size;
        for (const side of [1, -1]) {
          const pz = side * row.z;
          writer.push(
            bx,
            by,
            pz,
            along,
            Z_AXIS,
            n,
            sigmaAlong,
            sigmaZ,
            Math.min(sigmaAlong, sigmaZ) * STROKE_THINNESS,
            248,
            248,
            251,
            STROKE_ALPHA,
          );
          extend(bx, by, pz);
        }
      }
    };
    for (let fy = 0; fy < h; fy++) {
      for (let fx = 0; fx < w; fx++) {
        const here = inkAt(fx, fy);
        if (here < 0.5) continue;
        const [gx, gy] = gradientOf(smooth, w, h, fx, fy);
        if (gx * gx + gy * gy < 0.25) continue;
        // A near-vertical silhouette crosses one horizontal neighbour pair per
        // row, and a vertical pair only where it steps a column; keeping both
        // doubles the discs at every step, a periodic comb. Keep the type the
        // contour crosses once per cell row/column and size the discs to that
        // spacing (1 cell on an axis-aligned edge, √2 at 45°).
        const alongX = Math.abs(gx) >= Math.abs(gy);
        const spacing = 1 / Math.max(Math.abs(gx), Math.abs(gy));
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          if ((dx !== 0) !== alongX) continue;
          const there = inkAt(fx + dx, fy + dy);
          if (there >= 0.5) continue;
          // Linear interpolation of ink across the edge finds the 0.5 crossing.
          const t = (here - 0.5) / Math.max(1e-6, here - there);
          emitWall(fx + 0.5 + dx * t, fy + 0.5 + dy * t, gx, gy, spacing);
        }
      }
    }
  }
  const strokeEnd = writer.count;
  const strokeOutline = orderOutline(outlineRaw, stroke, frame, slabHalfDepth);

  // --- flame: volumetric body --------------------------------------------
  let flameHalfWidth = 0;
  for (let i = 0; i < flame.distance.length; i++) {
    if ((flame.distance[i] as number) > flameHalfWidth)
      flameHalfWidth = flame.distance[i] as number;
  }
  flameHalfWidth *= cell;
  const flameHalfDepth = flameHalfWidth * 0.8;
  const flameRounding = flameHalfWidth;
  /** Fine cells inside the flame, for the sprite layers to draw from. */
  const flameCells: number[] = [];
  let flameBase = Infinity;
  let flameTop = -Infinity;
  let sumX = 0;
  let sumY = 0;
  let sumWeight = 0;
  for (let fy = 0; fy < flame.height; fy++) {
    for (let fx = 0; fx < flame.width; fx++) {
      const d = flame.distance[fy * flame.width + fx] as number;
      if (d <= 0) continue;
      flameCells.push(fy * flame.width + fx);
      const [x, y] = toLocal(flame, frame, fx, fy);
      if (y < flameBase) flameBase = y;
      if (y > flameTop) flameTop = y;
      sumX += x * d;
      sumY += y * d;
      sumWeight += d;
    }
  }
  if (flameCells.length === 0) throw new Error('buildLogoSplats: no flame ink in the bitmap.');
  const flameCenter: [number, number, number] = [sumX / sumWeight, sumY / sumWeight, 0];
  const hot: Vec3 = [255, 236, 176];
  const flameStart = writer.count;
  if (parts.flame) {
    for (const index of flameCells) {
      const fx = index % flame.width;
      const fy = (index - fx) / flame.width;
      const d = flame.distance[index] as number;
      const [x, y] = toLocal(flame, frame, fx, fy);
      const [depth] = roundedProfile(d * cell, flameRounding, flameHalfDepth);
      const [r, g, b] = bilinearColor(bitmap, (fx + 0.5) / detail, flame.top + (fy + 0.5) / detail);
      // How far in from the silhouette, 0..1 over three source pixels.
      const edge = clamp01((d * cell) / (3 * frame.metresPerPixel));
      // Fill the depth at random rather than in slices: regular layers read as
      // a stack of sheets. A low-frequency warp pulls samples off the bitmap's
      // pixel lattice, and a soft, larger filler every few samples ties the
      // small ones together.
      const samples = Math.max(1, Math.min(5, Math.round((2 * depth) / (1.2 * cell))));
      const warp = options.height * 0.012;
      for (let k = 0; k < samples; k++) {
        const z = (random() * 2 - 1) * depth;
        const core = (1 - Math.abs(z) / Math.max(depth, 1e-4)) * edge;
        const mixHot = 0.65 * core;
        const nx = x * 9;
        const ny = y * 9;
        const nz = z * 9;
        const px = x + jitter() + warp * valueNoise(nx, ny, nz);
        const py = y + jitter() + warp * valueNoise(nx + 37, ny + 11, nz + 5);
        const pz = z + jitter() + warp * valueNoise(nx + 91, ny + 53, nz + 17);
        const filler = k === 0 && random() < 0.18;
        const sigma = filler ? cell * (2 + 1.5 * random()) : cell * (0.6 + 0.9 * random());
        const vary = 1 + 0.12 * valueNoise(nx * 2 + 7, ny * 2, nz * 2);
        writer.pushPoint(
          px,
          py,
          pz,
          sigma,
          (r + (hot[0] - r) * mixHot) * vary,
          (g + (hot[1] - g) * mixHot) * vary,
          (b + (hot[2] - b) * mixHot) * vary,
          filler ? 0.25 + 0.15 * random() : 0.5 + 0.4 * random(),
        );
        extend(px, py, pz);
      }
    }
  }
  const flameEnd = writer.count;

  // Seeds for a simulated fire: biased toward the base so a plume rises
  // through the shape rather than igniting everywhere at once.
  const flameSeeds = new Float32Array(4096 * 3);
  for (let i = 0; i < 4096; i++) {
    let x = 0;
    let y = Infinity;
    let z = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const index = flameCells[Math.floor(random() * flameCells.length)] as number;
      const fx = index % flame.width;
      const fy = (index - fx) / flame.width;
      const [cx, cy] = toLocal(flame, frame, fx, fy);
      if (cy >= y) continue;
      const [depth] = roundedProfile(
        (flame.distance[index] as number) * cell,
        flameRounding,
        flameHalfDepth,
      );
      x = cx;
      y = cy;
      z = (random() * 2 - 1) * depth;
    }
    flameSeeds[i * 3] = x;
    flameSeeds[i * 3 + 1] = y;
    flameSeeds[i * 3 + 2] = z;
  }

  const randomFlameCell = (): [number, number, number] => {
    const index = flameCells[Math.floor(random() * flameCells.length)] as number;
    const fx = index % flame.width;
    const fy = (index - fx) / flame.width;
    const [x, y] = toLocal(flame, frame, fx, fy);
    const [depth] = roundedProfile(
      (flame.distance[index] as number) * cell,
      flameRounding,
      flameHalfDepth,
    );
    return [x, y, (random() * 2 - 1) * depth];
  };

  // --- glow: wide, faint, warm haze around the flame ----------------------
  const glowStart = writer.count;
  if (parts.glow) {
    const count = 400;
    for (let i = 0; i < count; i++) {
      const [x, y, z] = randomFlameCell();
      const sigma = options.height * (0.015 + 0.035 * random());
      writer.pushPoint(x, y, z, sigma, 255, 120 + 60 * random(), 30, 0.025 + 0.035 * random());
    }
  }
  const glowEnd = writer.count;

  // --- embers: small bright particles the viewer sends upward --------------
  const embersStart = writer.count;
  if (parts.embers) {
    const count = 600;
    for (let i = 0; i < count; i++) {
      const [x, y, z] = randomFlameCell();
      const sigma = options.height * (0.0025 + 0.003 * random());
      writer.pushPoint(x, y, z, sigma, 255, 200 + 50 * random(), 90 + 60 * random(), 1);
    }
  }
  const embersEnd = writer.count;

  // --- pool: warm light on the floor under the flame -----------------------
  const poolStart = writer.count;
  if (parts.pool) {
    const floorY = options.floorY ?? -0.3;
    const radius = options.height * 0.55;
    const count = 500;
    for (let i = 0; i < count; i++) {
      // Area-uniform in the disc, then faded by a Gaussian so the edge is soft.
      const rr = radius * Math.sqrt(random());
      const angle = random() * Math.PI * 2;
      const x = flameCenter[0] * 0.5 + rr * Math.cos(angle);
      const z = rr * Math.sin(angle);
      const fade = Math.exp(-((rr / radius) ** 2) * 3);
      const sigma = options.height * (0.03 + 0.04 * random());
      writer.pushDisc(x, floorY, z, Y_AXIS, sigma, 0.08, 255, 150, 60, 0.22 * fade);
    }
  }
  const poolEnd = writer.count;

  return {
    data: writer.finish(),
    strokeOutline,
    layers: {
      stroke: { start: strokeStart, end: strokeEnd },
      flame: { start: flameStart, end: flameEnd },
      glow: { start: glowStart, end: glowEnd },
      embers: { start: embersStart, end: embersEnd },
      pool: { start: poolStart, end: poolEnd },
    },
    flameCenter,
    flameSeeds,
    flameBase,
    flameTop,
    min: [min[0] as number, min[1] as number, min[2] as number],
    max: [max[0] as number, max[1] as number, max[2] as number],
  };
}
