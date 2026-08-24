import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { sampleTeleportTransition, type TeleportTransition } from './teleport-transition';

const transition: TeleportTransition = {
  startedAt: 1_000,
  duration: 500,
  from: {
    position: new THREE.Vector3(0, 0, 0),
    target: new THREE.Vector3(0, 0, -2),
  },
  to: {
    position: new THREE.Vector3(10, 4, -2),
    target: new THREE.Vector3(8, 4, -2),
  },
};

describe('sampleTeleportTransition', () => {
  it('eases both parts of the camera pose over 500 ms', () => {
    const position = new THREE.Vector3();
    const target = new THREE.Vector3();

    expect(sampleTeleportTransition(transition, 1_250, position, target)).toBe(false);
    expect(position.toArray()).toEqual([5, 2, -1]);
    expect(target.toArray()).toEqual([4, 2, -2]);
  });

  it('lands exactly at the destination and remains there after the duration', () => {
    const position = new THREE.Vector3();
    const target = new THREE.Vector3();

    expect(sampleTeleportTransition(transition, 1_500, position, target)).toBe(true);
    expect(position.equals(transition.to.position)).toBe(true);
    expect(target.equals(transition.to.target)).toBe(true);

    sampleTeleportTransition(transition, 2_000, position, target);
    expect(position.equals(transition.to.position)).toBe(true);
  });
});
