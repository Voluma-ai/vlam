import { describe, expect, it } from 'vitest';
import { MAX_DOF_RADIUS_PX, computeDofCocVariancePx2 } from '../lib/core';
import { POST_DOF_TAPS, postDofCocPx, preBlurAperture, vogelDisc } from './post-dof';

describe('postDofCocPx', () => {
  const lens = { focusDistance: 4, aperture: 0.2, focalPx: 900 };

  it('is sharp on the focus plane and off with a closed aperture', () => {
    expect(postDofCocPx({ ...lens, depth: 4 })).toBe(0);
    expect(postDofCocPx({ ...lens, depth: 1, aperture: 0 })).toBe(0);
    expect(postDofCocPx({ ...lens, depth: 1, focalPx: 0 })).toBe(0);
  });

  it('is signed: negative in front of focus, positive behind', () => {
    expect(postDofCocPx({ ...lens, depth: 2 })).toBeLessThan(0);
    expect(postDofCocPx({ ...lens, depth: 8 })).toBeGreaterThan(0);
  });

  it("matches the core per-splat path's CoC (variance = radius²)", () => {
    for (const depth of [1.5, 3, 5, 12]) {
      const radius = postDofCocPx({ ...lens, depth, maxRadiusPx: 1e9 });
      const variance = computeDofCocVariancePx2({ ...lens, depth, maxVariance: 1e18 });
      expect(radius * radius).toBeCloseTo(variance, 6);
    }
  });

  it('caps at the shared radius limit, and treats no hit as the far background', () => {
    expect(postDofCocPx({ ...lens, depth: 0.05 })).toBe(-MAX_DOF_RADIUS_PX);
    expect(postDofCocPx({ ...lens, depth: 1e6, aperture: 4 })).toBe(MAX_DOF_RADIUS_PX);
    const apertureRadius = (lens.focalPx * 0.5 * lens.aperture) / lens.focusDistance;
    expect(postDofCocPx({ ...lens, depth: Infinity })).toBeCloseTo(
      Math.min(MAX_DOF_RADIUS_PX, apertureRadius),
      6,
    );
  });
});

describe('preBlurAperture', () => {
  it('yields an aperture whose CoC at infinity is the requested radius', () => {
    const aperture = preBlurAperture({
      radiusPx: 1.5,
      focusDistance: 8,
      focalPx: 834,
      aperture: 0.25,
    });
    expect(postDofCocPx({ depth: Infinity, focusDistance: 8, focalPx: 834, aperture })).toBeCloseTo(
      1.5,
      6,
    );
  });

  it('never exceeds the live aperture, and is off when the effect is', () => {
    expect(preBlurAperture({ radiusPx: 1.5, focusDistance: 8, focalPx: 10, aperture: 0.25 })).toBe(
      0.25,
    );
    expect(preBlurAperture({ radiusPx: 1.5, focusDistance: 8, focalPx: 834, aperture: 0 })).toBe(0);
  });
});

describe('vogelDisc', () => {
  it('covers the unit disc evenly, growing outward', () => {
    const points = vogelDisc(POST_DOF_TAPS);
    expect(points).toHaveLength(POST_DOF_TAPS);
    let previous = 0;
    for (const point of points) {
      const r = point.length();
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThanOrEqual(1);
      expect(r).toBeGreaterThan(previous);
      previous = r;
    }
    // Roughly a quarter of the taps inside half the radius (area ∝ r²).
    const inner = points.filter((p) => p.length() < 0.5).length;
    expect(inner).toBeGreaterThanOrEqual(POST_DOF_TAPS / 4 - 2);
    expect(inner).toBeLessThanOrEqual(POST_DOF_TAPS / 4 + 2);
  });
});
