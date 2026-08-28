import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  createYUpTransform,
  yUpTransformForFormat,
  type OrientableFormat,
} from '../core/orientation';

describe('createYUpTransform', () => {
  it('is a 180° rotation about X: +Y→−Y, +Z→−Z, +X unchanged', () => {
    const m = createYUpTransform();
    expect(new THREE.Vector3(1, 0, 0).applyMatrix4(m).toArray()).toEqual([1, 0, 0]);
    const y = new THREE.Vector3(0, 1, 0).applyMatrix4(m);
    expect(y.y).toBeCloseTo(-1);
    const z = new THREE.Vector3(0, 0, 1).applyMatrix4(m);
    expect(z.z).toBeCloseTo(-1);
  });
});

describe('yUpTransformForFormat', () => {
  const flipped: OrientableFormat[] = ['ply', 'splat', 'ksplat', 'sog', 'rad', 'streamed-sog'];
  const untouched: OrientableFormat[] = ['spz', 'lcc', 'lcc2'];

  it.each(flipped)('flips the Y-down format %s 180° about X', (format) => {
    const m = yUpTransformForFormat(format);
    expect(m).not.toBeNull();
    for (let i = 0; i < 16; i++) {
      expect(m!.elements[i]).toBeCloseTo(createYUpTransform().elements[i] as number, 10);
    }
  });

  it.each(untouched)('leaves %s alone (already Y-up, or self-orienting)', (format) => {
    expect(yUpTransformForFormat(format)).toBeNull();
  });

  it('returns null for an unstamped scene', () => {
    expect(yUpTransformForFormat(undefined)).toBeNull();
  });
});
