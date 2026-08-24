import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  classifyOrbitFraming,
  heightSamplesFromStreamedMesh,
  overviewPositionsFromStreamedMesh,
} from './orbit-framing';

function boundsFromPoints(points: Float32Array): THREE.Box3 {
  return new THREE.Box3().setFromArray(points);
}

function fillDisk(count: number, radius: number, y: number, jitterY: number): Float32Array {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt((i + 0.5) / count) * radius;
    const a = i * 2.399963;
    positions[i * 3] = Math.cos(a) * r;
    positions[i * 3 + 1] = y + ((i % 7) - 3) * jitterY;
    positions[i * 3 + 2] = Math.sin(a) * r;
  }
  return positions;
}

function fillEllipsoid(
  count: number,
  rx: number,
  ry: number,
  rz: number,
  cx = 0,
  cy = 0,
  cz = 0,
): Float32Array {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = (i + 0.5) / count;
    const theta = Math.acos(2 * u - 1);
    const phi = i * 2.399963;
    const r = 0.35 + (0.65 * ((i * 17) % 10)) / 9;
    positions[i * 3] = cx + rx * r * Math.sin(theta) * Math.cos(phi);
    positions[i * 3 + 1] = cy + ry * r * Math.cos(theta);
    positions[i * 3 + 2] = cz + rz * r * Math.sin(theta) * Math.sin(phi);
  }
  return positions;
}

function fillDome(count: number, radius: number): Float32Array {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = (i + 0.5) / count;
    const theta = Math.acos(1 - u) * 0.98;
    const phi = i * 2.399963;
    positions[i * 3] = radius * Math.sin(theta) * Math.cos(phi);
    positions[i * 3 + 1] = radius * Math.cos(theta);
    positions[i * 3 + 2] = radius * Math.sin(theta) * Math.sin(phi);
  }
  return positions;
}

function concat(parts: Float32Array[]): Float32Array {
  let n = 0;
  for (const part of parts) n += part.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

function isotropicCovariances(count: number, variance: number): Float32Array {
  const out = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    out[i * 6] = variance;
    out[i * 6 + 3] = variance;
    out[i * 6 + 5] = variance;
  }
  return out;
}

describe('classifyOrbitFraming', () => {
  it('treats a compact elongated blob as an object even when the AABB is a bit flat', () => {
    const positions = fillEllipsoid(1200, 1.2, 0.55, 0.4, 0, 0.55, 0);
    const result = classifyOrbitFraming(boundsFromPoints(positions), { positions });
    expect(result.framing).toBe('object');
  });

  it('treats a wide ground disk as a landscape from the AABB alone', () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-50, 0, -40), new THREE.Vector3(50, 3, 40));
    const result = classifyOrbitFraming(bounds);
    expect(result.framing).toBe('landscape');
    expect(result.distance).toBeLessThan(50 * 0.5);
    expect(result.center.y).toBeLessThan(bounds.min.y + 2);
  });

  it('treats a hemispherical AABB as a landscape even without splat samples', () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-50, 0, -50), new THREE.Vector3(50, 50, 50));
    expect(classifyOrbitFraming(bounds).framing).toBe('landscape');
  });

  it('detects a ground disk under a sky dome from occupancy, not just aspect', () => {
    const ground = fillDisk(4000, 50, 0.4, 0.08);
    const clouds = fillDome(800, 50);
    // Lift the dome so clouds sit well above the ground and the AABB is tall.
    for (let i = 0; i < 800; i++) {
      clouds[i * 3 + 1] = (clouds[i * 3 + 1] as number) + 30;
    }
    const positions = concat([ground, clouds]);
    const result = classifyOrbitFraming(boundsFromPoints(positions), { positions });
    expect(result.framing).toBe('landscape');
    expect(result.center.y).toBeLessThan(8);
    expect(result.distance).toBeLessThan(40);
  });

  it('keeps a tall statue as an object', () => {
    const positions = fillEllipsoid(800, 0.6, 2.4, 0.6, 0, 2.4, 0);
    const result = classifyOrbitFraming(boundsFromPoints(positions), { positions });
    expect(result.framing).toBe('object');
  });

  it('focuses a detailed subject inside a vague environment sphere', () => {
    const subject = fillEllipsoid(3200, 1.5, 2.4, 1.2, 3, 1, -2);
    const shell = fillEllipsoid(800, 45, 45, 45);
    const positions = concat([subject, shell]);
    const covariances = concat([isotropicCovariances(3200, 0.0025), isotropicCovariances(800, 2)]);
    const result = classifyOrbitFraming(boundsFromPoints(positions), {
      positions,
      covariances,
    });

    expect(result.framing).toBe('object');
    expect(result.focusBounds).not.toBeNull();
    expect(result.center.x).toBeCloseTo(3, 0);
    expect(result.center.z).toBeCloseTo(-2, 0);
    expect(result.distance).toBeLessThan(10);
  });

  it('does not crop an ordinary object with gradual covariance variation', () => {
    const positions = fillEllipsoid(1200, 2, 3, 1.5);
    const covariances = new Float32Array(1200 * 6);
    for (let i = 0; i < 1200; i++) {
      const variance = 0.01 + (i % 10) * 0.001;
      covariances.set([variance, 0, 0, variance, 0, variance], i * 6);
    }
    const result = classifyOrbitFraming(boundsFromPoints(positions), {
      positions,
      covariances,
    });
    expect(result.focusBounds).toBeNull();
  });

  it('transforms sampled centers through worldMatrix', () => {
    const local = fillDisk(600, 20, 0, 0.05);
    const worldMatrix = new THREE.Matrix4().makeTranslation(100, 5, -40);
    const bounds = boundsFromPoints(local).applyMatrix4(worldMatrix);
    const result = classifyOrbitFraming(bounds, { positions: local, worldMatrix });
    expect(result.framing).toBe('landscape');
    expect(result.center.x).toBeCloseTo(100, 0);
    expect(result.center.z).toBeCloseTo(-40, 0);
  });

  it('places a streamed landscape on the terrain band, not AABB min', () => {
    // Sandwijck-shaped: wide disk, sky/outliers stretch the AABB far below and
    // above the ground. Leaf centers sit around y = 14.
    const bounds = new THREE.Box3(
      new THREE.Vector3(-164, -64, -163),
      new THREE.Vector3(161, 55, 163),
    );
    const heightSamples = new Float32Array(800);
    for (let i = 0; i < 800; i++) {
      const band = i < 40 ? -20 + (i % 8) : 10 + ((i * 7) % 12);
      heightSamples[i] = band;
    }
    const withoutSamples = classifyOrbitFraming(bounds);
    expect(withoutSamples.framing).toBe('landscape');
    expect(withoutSamples.center.y).toBeLessThan(0);

    const result = classifyOrbitFraming(bounds, { heightSamples });
    expect(result.framing).toBe('landscape');
    expect(result.spanHeights).toBe(false);
    expect(result.center.y).toBeGreaterThan(8);
    expect(result.center.y).toBeLessThan(22);
  });

  it('reads streamed leaf centers through the Y-up correction', () => {
    const leaves = [
      { bounds: new THREE.Box3(new THREE.Vector3(-2, -20, -2), new THREE.Vector3(2, -16, 2)) },
      { bounds: new THREE.Box3(new THREE.Vector3(4, -19, 4), new THREE.Vector3(8, -15, 8)) },
    ];
    // Pad to the occupancy floor.
    while (leaves.length < 24) {
      const y = -18 - (leaves.length % 3);
      leaves.push({
        bounds: new THREE.Box3(new THREE.Vector3(0, y - 1, 0), new THREE.Vector3(1, y + 1, 1)),
      });
    }
    const mesh = { scene: { source: { leaves } }, matrixWorld: new THREE.Matrix4() };
    const yUp = new THREE.Matrix4().makeRotationX(Math.PI);
    const samples = heightSamplesFromStreamedMesh(mesh, yUp);
    expect(samples).not.toBeNull();
    expect(samples!.length).toBe(leaves.length);
    // Source Y ≈ -18 becomes world Y ≈ +18 after the 180°-X flip.
    const mean = [...samples!].reduce((a, b) => a + b, 0) / samples!.length;
    expect(mean).toBeGreaterThan(14);
    expect(mean).toBeLessThan(22);
  });

  it('places a .rad landscape on the overview terrain, not AABB min', () => {
    // Andre-shaped: wide capture, AABB min well below the dense splat band.
    const bounds = new THREE.Box3(
      new THREE.Vector3(-121, -23, -49),
      new THREE.Vector3(79, 6.2, 144),
    );
    const positions = new Float32Array(800 * 3);
    for (let i = 0; i < 800; i++) {
      const y = i < 40 ? -22 + (i % 4) * 0.3 : -12.7 + ((i * 7) % 60) / 10;
      positions[i * 3] = ((i % 50) - 25) * 3;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = ((i % 40) - 20) * 4;
    }
    const withoutSamples = classifyOrbitFraming(bounds);
    expect(withoutSamples.framing).toBe('landscape');
    expect(withoutSamples.center.y).toBeLessThan(-18);

    const result = classifyOrbitFraming(bounds, { positions });
    expect(result.framing).toBe('landscape');
    expect(result.spanHeights).toBe(true);
    expect(result.center.y).toBeGreaterThan(-14);
    expect(result.center.y).toBeLessThan(-8);
  });

  it('reads .rad overview centers through the Y-up correction', () => {
    const overviewPositions = new Float32Array(24 * 3);
    for (let i = 0; i < 24; i++) {
      overviewPositions[i * 3] = i;
      overviewPositions[i * 3 + 1] = 10;
      overviewPositions[i * 3 + 2] = 0;
    }
    const mesh = { scene: { overviewPositions } };
    const yUp = new THREE.Matrix4().makeRotationX(Math.PI);
    expect(overviewPositionsFromStreamedMesh(mesh)?.length).toBe(72);
    const samples = heightSamplesFromStreamedMesh(mesh, yUp);
    expect(samples).not.toBeNull();
    expect(samples![0]).toBeCloseTo(-10, 5);
  });
});
