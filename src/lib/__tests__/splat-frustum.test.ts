import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { updateSplatFrustumMargin } from '../core/splat-frustum';

describe('conservative splat center bounds', () => {
  it.each([
    [800, 600],
    [320, 640],
    [1, 1],
  ])('contains rotated capped quads at every screen edge in a %ix%i viewport', (width, height) => {
    const viewport = new THREE.Vector2(width, height);
    const margin = updateSplatFrustumMargin(viewport, new THREE.Vector2());
    // Independent geometric oracle: sum the four corners of two rotated
    // 512px axes, then put each corner just on the visible screen edge.
    for (let angle = 0; angle < Math.PI * 2; angle += 0.1) {
      const major = new THREE.Vector2(Math.cos(angle), Math.sin(angle)).multiplyScalar(512);
      const minor = new THREE.Vector2(-Math.sin(angle), Math.cos(angle)).multiplyScalar(512);
      for (const xSign of [-1, 1]) {
        for (const ySign of [-1, 1]) {
          const corner = major.clone().multiplyScalar(xSign).addScaledVector(minor, ySign);
          expect(1 + (2 * Math.abs(corner.x)) / width).toBeLessThanOrEqual(margin.x);
          expect(1 + (2 * Math.abs(corner.y)) / height).toBeLessThanOrEqual(margin.y);
        }
      }
    }
  });

  it('reuses its output and grows with a pixel floor exceeding the normal cap', () => {
    const viewport = new THREE.Vector2(800, 600);
    const margin = new THREE.Vector2();
    expect(updateSplatFrustumMargin(viewport, margin)).toBe(margin);
    const ordinary = margin.clone();
    updateSplatFrustumMargin(viewport, margin, 1024);
    expect(margin.x).toBeGreaterThan(ordinary.x);
    expect(margin.y).toBeGreaterThan(ordinary.y);
  });

  it('widens when drawing-buffer resolution falls without changing aspect', () => {
    const full = updateSplatFrustumMargin(new THREE.Vector2(800, 600), new THREE.Vector2());
    const half = updateSplatFrustumMargin(new THREE.Vector2(400, 300), new THREE.Vector2());
    expect(half.x).toBeGreaterThan(full.x);
    expect(half.y).toBeGreaterThan(full.y);
    expect(
      updateSplatFrustumMargin(new THREE.Vector2(), new THREE.Vector2())
        .toArray()
        .every(Number.isFinite),
    ).toBe(true);
  });
});
