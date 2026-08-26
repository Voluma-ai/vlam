import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  XrSortCadence,
  applyXrDepthMode,
  resolveXrFoveation,
  resolveXrStabilityOptions,
  restoreXrDepthMode,
} from './xr-stability';

describe('resolveXrFoveation', () => {
  it('defaults an absent or malformed override to maximum foveation', () => {
    expect(resolveXrFoveation(null)).toBe(1);
    expect(resolveXrFoveation('bad')).toBe(1);
  });

  it('preserves explicit zero and intermediate overrides', () => {
    expect(resolveXrFoveation('0')).toBe(0);
    expect(resolveXrFoveation('0.4')).toBe(0.4);
  });
});

describe('resolveXrStabilityOptions', () => {
  it('enables conservative Quest defaults only for recognized headsets', () => {
    const quest = resolveXrStabilityOptions(new URLSearchParams(), {
      isHeadset: true,
      backend: 'WebGL2',
      recommendedFramebufferScale: 0.8,
    });
    expect(quest).toMatchObject({ enabled: true, framebufferScale: 0.7, sortHz: 30 });
    expect(quest.depthAlphaThreshold).toBeNull();

    const desktop = resolveXrStabilityOptions(new URLSearchParams(), {
      isHeadset: false,
      backend: 'WebGL2',
      recommendedFramebufferScale: 1,
    });
    expect(desktop).toMatchObject({ enabled: false, framebufferScale: 1, sortHz: null });
  });

  it('validates all A/B overrides and keeps depth experimental', () => {
    const params = new URLSearchParams(
      'xrStability=0&xrScale=0.8&xrSortHz=72&xrDepth=0.15&xrDiagnostics=1',
    );
    expect(
      resolveXrStabilityOptions(params, {
        isHeadset: true,
        backend: 'WebGL2',
        recommendedFramebufferScale: 0.8,
      }),
    ).toEqual({
      enabled: false,
      framebufferScale: 0.8,
      sortHz: 72,
      depthAlphaThreshold: 0.15,
      diagnostics: true,
    });
  });

  it('does not apply the WebGL scale or cadence defaults to WebGPU XR', () => {
    expect(
      resolveXrStabilityOptions(new URLSearchParams(), {
        isHeadset: true,
        backend: 'WebGPU',
        recommendedFramebufferScale: 0.8,
      }),
    ).toMatchObject({ framebufferScale: 0.8, sortHz: null });
  });

  it('ignores malformed or unsafe numeric overrides', () => {
    const params = new URLSearchParams('xrScale=4&xrSortHz=-2&xrDepth=NaN');
    expect(
      resolveXrStabilityOptions(params, {
        isHeadset: true,
        backend: 'WebGL2',
        recommendedFramebufferScale: 0.8,
      }),
    ).toMatchObject({ framebufferScale: 0.7, sortHz: 30, depthAlphaThreshold: null });
  });
});

describe('XrSortCadence', () => {
  it('attempts immediately and then at the configured rate', () => {
    const cadence = new XrSortCadence(30);
    expect(cadence.shouldAttempt(100)).toBe(true);
    expect(cadence.shouldAttempt(120)).toBe(false);
    expect(cadence.shouldAttempt(134)).toBe(true);
    cadence.reset();
    expect(cadence.shouldAttempt(135)).toBe(true);
  });

  it('leaves unrestricted sorting untouched', () => {
    const cadence = new XrSortCadence(null);
    expect(cadence.shouldAttempt(10)).toBe(true);
    expect(cadence.shouldAttempt(10)).toBe(true);
  });
});

describe('XR depth mode', () => {
  it('restores material state exactly after the session', () => {
    const material = new THREE.MeshBasicMaterial({ alphaTest: 0.03, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    const state = applyXrDepthMode(mesh, 0.15);
    expect(material.depthWrite).toBe(true);
    expect(material.alphaTest).toBe(0.15);

    restoreXrDepthMode(state);
    expect(material.depthWrite).toBe(false);
    expect(material.alphaTest).toBe(0.03);
  });
});
