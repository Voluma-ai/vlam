import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SH_BANDS, SplatMesh } from '../splat-mesh';
import { writeCovariance, type SplatData } from '../splat-data';

/**
 * A *static* mesh carries its spherical harmonics in the data, and for a long
 * time that was read blindly: `options.shBands` and the `smooth` performance
 * profile (the mobile default) were both ignored, so no caller and no device
 * could decline it.
 *
 * On a 1.4M-splat band-3 capture - a Postshot `.ply` with `f_rest_0…f_rest_44`
 * is exactly that - it costs four `RGBA32UI` pool textures (128 B/splat of GPU
 * plus CPU backing, ~180 MB) and four texture fetches plus a 15-coefficient
 * evaluation per splat *per frame*. The identical defect on `.rad` was 48% of
 * its pool; see `rad-sh-bands.test.ts`, which these mirror.
 */

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Makes the device profile read as a phone, so `smooth` is the default. */
function stubMobile(): void {
  vi.stubGlobal('navigator', { userAgent: IPHONE_UA, platform: '', maxTouchPoints: 5 });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('coarse') }));
}

const RANGE = { min: [-2, -4, -8] as const, max: [2, 4, 8] as const };

function baseData(count: number): SplatData {
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    colors[i * 4 + 3] = 255;
    writeCovariance(covariances, i, 0.05, 0.05, 0.05, 1, 0, 0, 0);
  }
  return { count, positions, colors, covariances };
}

/** Per-splat packed SH - what a `.ply`/LCC `Quality` capture delivers. */
function withPackedSh(count: number, bands: 1 | 2 | 3): SplatData {
  const coefficients = [0, 3, 8, 15][bands] as number;
  return {
    ...baseData(count),
    shPacked: {
      bands,
      packed: new Uint32Array(count * coefficients),
      range: { min: RANGE.min, max: RANGE.max },
    },
  };
}

/** Palette shN - what a SOG / `.lcc2` capture delivers. */
function withPaletteSh(count: number, bands: 1 | 2 | 3): SplatData {
  const coefficients = [0, 3, 8, 15][bands] as number;
  return {
    ...baseData(count),
    sh: {
      bands,
      labels: new Uint32Array(count),
      palette: new Float32Array(coefficients * 3 * 4),
      paletteWidth: coefficients,
      paletteHeight: 1,
    },
  };
}

/** The pool's packed-SH textures, one per group of four coefficients. */
function shTextureCount(mesh: SplatMesh): number {
  return (mesh as unknown as { backing: { shPacked: Uint32Array[] } }).backing.shPacked.length;
}

describe('static mesh spherical-harmonics resolution', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the bands the data carries on a quality profile', () => {
    const mesh = new SplatMesh(withPackedSh(8, 3), { performanceProfile: 'quality' });
    expect(mesh.shBands).toBe(3);
    expect(shTextureCount(mesh)).toBe(4); // ceil(15 / 4)
    mesh.dispose();
  });

  it('declines SH entirely when the caller asks for zero bands', () => {
    // The regression: the data has SH, the caller does not want it. Before the
    // fix this allocated the textures and rendered SH anyway.
    const mesh = new SplatMesh(withPackedSh(8, 3), { shBands: 0 });
    expect(mesh.shBands).toBe(0);
    expect(shTextureCount(mesh)).toBe(0);
    mesh.dispose();
  });

  it('declines SH on a smooth profile, which is the mobile default', () => {
    const mesh = new SplatMesh(withPackedSh(8, 3), { performanceProfile: 'smooth' });
    expect(mesh.shBands).toBe(0);
    expect(shTextureCount(mesh)).toBe(0);
    mesh.dispose();
  });

  it('declines SH on a phone with no explicit options at all', () => {
    // The case that matters in the product: a host that passes nothing still
    // gets the device-appropriate answer, exactly as the streamed path does.
    stubMobile();
    const mesh = new SplatMesh(withPackedSh(8, 3));
    expect(mesh.shBands).toBe(0);
    expect(shTextureCount(mesh)).toBe(0);
    mesh.dispose();
  });

  it('declines a palette shN too, not just packed bands', () => {
    // SOG / `.lcc2` deliver a shared palette rather than per-splat words. It
    // costs little memory but the same per-frame fetch and evaluation, so
    // leaving it ungated would make `shBands: 0` silently ineffective for
    // exactly the formats that use it.
    const mesh = new SplatMesh(withPaletteSh(8, 3), { shBands: 0 });
    expect(mesh.shBands).toBe(0);
    mesh.dispose();
  });

  it('keeps a palette shN on a quality profile', () => {
    const mesh = new SplatMesh(withPaletteSh(8, 3), { performanceProfile: 'quality' });
    expect(mesh.shBands).toBe(3);
    mesh.dispose();
  });

  it('treats a non-zero request as all-or-nothing rather than truncating', () => {
    // A partial cap cannot be honoured: `writePackedSh` copies packed words
    // only when the counts match exactly, so allocating for one band against
    // three-band data would fill the textures with *neutral* words - paying for
    // SH and rendering flat. Keeping the data's bands is the safe reading, and
    // this pins it so a future "clamp" cannot reintroduce that path.
    const mesh = new SplatMesh(withPackedSh(8, 3), { shBands: 1 });
    expect(mesh.shBands).toBe(3);
    mesh.dispose();
  });

  it('reports no bands for data without SH, whatever is requested', () => {
    const kept = new SplatMesh(baseData(8), { shBands: MAX_SH_BANDS });
    expect(kept.shBands).toBe(0);
    expect(shTextureCount(kept)).toBe(0);
    kept.dispose();
  });

  it('leaves a dynamic pool defaulting to no SH', () => {
    // The dynamic branch must keep `?? 0`: it has no data to read bands from,
    // so following the profile there would allocate SH textures for every mesh
    // that never asked for any.
    const dynamic = new SplatMesh({ capacity: 2048 }, { performanceProfile: 'quality' });
    expect(shTextureCount(dynamic)).toBe(0);
    dynamic.dispose();
  });
});
