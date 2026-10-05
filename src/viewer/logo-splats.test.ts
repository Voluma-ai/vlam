import { describe, expect, it } from 'vitest';
import {
  buildLogoSplats,
  flameInk,
  markRows,
  squaredDistanceToOutside,
  whiteInk,
  type LogoBitmap,
} from './logo-splats';

/** A 40×60 bitmap: a white bar on the left, an orange blob on the right, a "wordmark" line below. */
function syntheticLogo(): LogoBitmap {
  const width = 40;
  const height = 60;
  const data = new Uint8ClampedArray(width * height * 4);
  const put = (x: number, y: number, r: number, g: number, b: number, a = 255): void => {
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  };
  for (let y = 4; y < 40; y++) for (let x = 6; x < 14; x++) put(x, y, 250, 250, 250);
  for (let y = 10; y < 40; y++) {
    for (let x = 20; x < 34; x++) {
      const dx = x - 27;
      const dy = y - 25;
      if ((dx * dx) / 49 + (dy * dy) / 225 <= 1) put(x, y, 255, 120 + (y % 3) * 20, 20);
    }
  }
  for (let x = 2; x < 38; x++) put(x, 52, 240, 240, 240);
  return { width, height, data };
}

describe('logo-splats', () => {
  it('classifies white and warm ink', () => {
    expect(whiteInk(250, 250, 250, 255)).toBeCloseTo(1);
    expect(whiteInk(250, 250, 250, 0)).toBe(0);
    expect(whiteInk(255, 140, 20, 255)).toBe(0);
    expect(flameInk(255, 140, 20, 255)).toBeCloseTo(1);
    expect(flameInk(250, 250, 250, 255)).toBe(0);
  });

  it('finds the mark rows and skips the wordmark below the gap', () => {
    expect(markRows(syntheticLogo())).toEqual([4, 40]);
  });

  it('measures inside distance to the silhouette', () => {
    const inside = new Uint8Array(7 * 7).fill(1);
    const squared = squaredDistanceToOutside(inside, 7, 7);
    // Center cell: three cells to the edge cell, four to the virtual outside.
    expect(squared[3 * 7 + 3]).toBe(16);
    expect(squared[0]).toBe(1);
  });

  it('builds contiguous layers with an extruded stroke and a flame volume', () => {
    const logo = buildLogoSplats(syntheticLogo(), { height: 3, detail: 2, seed: 1 });
    const { layers, data } = logo;
    expect(layers.stroke.start).toBe(0);
    expect(layers.stroke.end).toBe(layers.flame.start);
    expect(layers.pool.end).toBe(data.count);
    expect(layers.stroke.end).toBeGreaterThan(300);
    expect(layers.flame.end - layers.flame.start).toBeGreaterThan(500);
    // The mark spans 36 rows → 3 m; its base sits at y = 0.
    expect(logo.max[1]).toBeCloseTo(3, 0);
    expect(logo.min[1]).toBeGreaterThan(-0.1);
    // An extruded cutout: face discs are thin along z and sit on the two face
    // planes; wall discs are thin across the silhouette and span the depth.
    let face = 0;
    let wall = 0;
    let faceZ = 0;
    for (let i = layers.stroke.start; i < layers.stroke.end; i++) {
      const sxx = data.covariances[i * 6] as number;
      const szz = data.covariances[i * 6 + 5] as number;
      const z = Math.abs(data.positions[i * 3 + 2] as number);
      if (szz < sxx * 0.1) {
        face++;
        if (faceZ === 0) faceZ = z;
        expect(z).toBeCloseTo(faceZ, 6);
      } else if (sxx < szz * 0.5) wall++;
    }
    expect(face).toBeGreaterThan(0);
    expect(wall).toBeGreaterThan(0);
    // The interior is tiled by coarser discs than the rim: some face discs are
    // several cells wide (detail 2 → 0.5 px cells).
    const cellM = 3 / 36 / 2;
    let coarse = 0;
    for (let i = layers.stroke.start; i < layers.stroke.end; i++) {
      if (Math.sqrt(data.covariances[i * 6] as number) > 2 * cellM) coarse++;
    }
    expect(coarse).toBeGreaterThan(0);
    // Every stroke splat is white and opaque.
    for (let i = layers.stroke.start; i < layers.stroke.end; i += 97) {
      expect(data.colors[i * 4] as number).toBeGreaterThan(240);
      expect(data.colors[i * 4 + 3] as number).toBeGreaterThan(200);
    }
    // The flame centroid sits to the right of the stroke, inside the blob.
    expect(logo.flameCenter[0]).toBeGreaterThan(0);
    expect(logo.flameTop).toBeGreaterThan(logo.flameBase);
  });

  it('can build the stroke alone', () => {
    const logo = buildLogoSplats(syntheticLogo(), {
      height: 3,
      detail: 2,
      parts: { stroke: true, flame: false, glow: false, embers: false, pool: false },
    });
    expect(logo.layers.flame.end).toBe(logo.layers.flame.start);
    expect(logo.data.count).toBe(logo.layers.stroke.end);
  });
});
