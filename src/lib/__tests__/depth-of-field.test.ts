import { describe, expect, it } from 'vitest';
import {
  MAX_DOF_VARIANCE,
  MAX_DOF_RADIUS_PX,
  apertureAngleFromSize,
  clampDepthOfFieldSettings,
  computeDofCocVariancePx2,
  computeDofOpacityFade,
} from '../depth-of-field';
import { SplatMesh } from '../splat-mesh';

describe('projected-2D depth of field', () => {
  it('returns zero CoC variance when aperture is disabled', () => {
    expect(
      computeDofCocVariancePx2({
        depth: 20,
        focusDistance: 10,
        aperture: 0,
        focalPx: 800,
      }),
    ).toBe(0);
  });

  // Pulling focus toward the camera must widen the aperture angle - that is how
  // authors soften a whole scene. A fixed reference distance decoupled the two
  // and made the focus slider a near-no-op at ModifyCamera's aperture sizes.
  it('maps aperture size to angle through the live focus plane', () => {
    const aNearFocus = apertureAngleFromSize(0.2, 0.5);
    const aFarFocus = apertureAngleFromSize(0.2, 50);
    expect(aNearFocus).toBeCloseTo(2 * Math.atan((0.5 * 0.2) / 0.5), 10);
    expect(aNearFocus).toBeGreaterThan(aFarFocus);
  });

  // The near side is the whole point of `/depth`: `/max(depth, focus)` capped
  // focusBlur at 1, so foreground CoC could never exceed a single apertureRadius
  // - sub-pixel at the aperture sizes ModifyCamera produces, which rendered
  // Spark-authored scenes flat.
  it('matches Spark /depth in front of the focus plane', () => {
    const aperture = 0.15;
    const focus = 100;
    const focalPx = 800;
    const depth = 20;
    const apertureRadius = focalPx * Math.tan(0.5 * apertureAngleFromSize(aperture, focus));

    const near = computeDofCocVariancePx2({ depth, focusDistance: focus, aperture, focalPx });
    const sparkBlur = Math.abs(depth - focus) / depth;
    expect(Math.sqrt(near)).toBeCloseTo(sparkBlur * apertureRadius, 6);

    // focusBlur is 4 here - 4 apertureRadii of CoC. The old bounded form clamped
    // it to 1 and lost exactly this foreground defocus.
    expect(sparkBlur).toBeGreaterThan(1);
    const boundedBlur = Math.abs(depth - focus) / Math.max(depth, focus);
    expect(Math.sqrt(near)).toBeGreaterThan(boundedBlur * apertureRadius);
  });

  it('grows CoC variance with defocus behind the focus plane', () => {
    const focus = 10;
    const aperture = 0.2;
    const focalPx = 800;
    const depth = 20;
    const apertureAngle = apertureAngleFromSize(aperture, focus);
    // Behind the focus plane the two forms coincide: max(depth, focus) === depth.
    const focusBlur = Math.abs(depth - focus) / depth;
    expect(focusBlur).toBe(Math.abs(depth - focus) / Math.max(depth, focus));
    const expected = (focusBlur * focalPx * Math.tan(0.5 * apertureAngle)) ** 2;
    expect(
      computeDofCocVariancePx2({ depth, focusDistance: focus, aperture, focalPx }),
    ).toBeCloseTo(expected, 6);
  });

  it('keeps far-field CoC at or below apertureRadius when zoomed out', () => {
    const focus = 5;
    const aperture = 0.2;
    const focalPx = 800;
    const depth = 500;
    const apertureAngle = apertureAngleFromSize(aperture, focus);
    const apertureRadius = focalPx * Math.tan(0.5 * apertureAngle);
    const focusBlur = Math.abs(depth - focus) / depth;
    const far = computeDofCocVariancePx2({
      depth,
      focusDistance: focus,
      aperture,
      focalPx,
    });
    // focusBlur → 1 as depth → ∞, so variance asymptotes to apertureRadius² (under the px cap).
    expect(far).toBeCloseTo((focusBlur * apertureRadius) ** 2, 6);
    expect(Math.sqrt(far)).toBeLessThan(apertureRadius);
    expect(Math.sqrt(far)).toBeLessThanOrEqual(MAX_DOF_RADIUS_PX);
  });

  it('caps CoC variance so extreme apertures cannot wash out or kill fill-rate', () => {
    const variance = computeDofCocVariancePx2({
      depth: 500,
      focusDistance: 5,
      aperture: 2,
      focalPx: 1200,
    });
    expect(variance).toBe(MAX_DOF_VARIANCE);
    expect(Math.sqrt(variance)).toBe(MAX_DOF_RADIUS_PX);
  });

  it('uses √(det) opacity fade, not 1/blur²', () => {
    const detRaw = 4 * 4;
    const detBlur = 16 * 16;
    const fade = computeDofOpacityFade(detRaw, detBlur);
    expect(fade).toBeCloseTo(Math.sqrt(detRaw / detBlur), 10);
    expect(fade).toBeCloseTo(0.25, 10);
  });

  it('clamps host DoF settings', () => {
    expect(clampDepthOfFieldSettings({ focusDistance: 0, aperture: -1 })).toEqual({
      focusDistance: 1e-4,
      aperture: 0,
    });
    expect(clampDepthOfFieldSettings({}, { focusDistance: 12, aperture: 0.4 })).toEqual({
      focusDistance: 12,
      aperture: 0.4,
    });
  });

  it('SplatMesh.setDepthOfField writes live uniforms without rebuilding modifiers', () => {
    const mesh = new SplatMesh({ capacity: 64 });
    expect(mesh.getDepthOfField()).toEqual({ focusDistance: 10, aperture: 0 });
    mesh.setDepthOfField({ focusDistance: 7.5, aperture: 0.12 });
    expect(mesh.getDepthOfField()).toEqual({ focusDistance: 7.5, aperture: 0.12 });
    mesh.setDepthOfField({ aperture: 0 });
    expect(mesh.getDepthOfField().aperture).toBe(0);
    expect(mesh.getDepthOfField().focusDistance).toBe(7.5);
    mesh.dispose();
  });
});
