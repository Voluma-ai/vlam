import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { selectBrushStrokeInData, type BrushStroke } from '../selection/brush-stroke';
import type { SplatData } from '../core/splat-data';

function data(points: readonly (readonly [number, number, number])[], variance = 0): SplatData {
  const positions = new Float32Array(points.length * 3);
  const covariances = new Float32Array(points.length * 6);
  points.forEach(([x, y, z], index) => {
    positions.set([x, y, z], index * 3);
    covariances.set([variance, 0, 0, variance, 0, variance], index * 6);
  });
  return {
    count: points.length,
    positions,
    covariances,
    colors: new Uint8Array(points.length * 4),
  };
}

function stroke(
  samples: readonly (readonly [number, number, number, number])[],
  viewMatrix?: THREE.Matrix4,
): BrushStroke {
  return {
    paths: [
      samples.map(([x, y, z, radius]) => ({
        point: new THREE.Vector3(x, y, z),
        radius,
        viewDepth: -z,
      })),
    ],
    ...(viewMatrix ? { viewMatrix } : {}),
  };
}

describe('selectBrushStrokeInData', () => {
  it('selects a gap-free tapered capsule, including the larger-radius side', () => {
    const source = data([
      [5, 3.1, 0],
      [5, 5.1, 0],
      [-1.1, 0, 0],
    ]);
    const selected = selectBrushStrokeInData(
      source,
      stroke([
        [0, 0, 0, 1],
        [10, 0, 0, 5],
      ]),
      { depth: 'through' },
    );
    expect(Array.from(selected)).toEqual([0]);
  });

  it('keeps paths separated across a depth discontinuity', () => {
    const source = data([
      [0, 0, -2],
      [5, 0, -6],
      [10, 0, -10],
    ]);
    const split: BrushStroke = {
      paths: [
        [{ point: new THREE.Vector3(0, 0, -2), radius: 1, viewDepth: 2 }],
        [{ point: new THREE.Vector3(10, 0, -10), radius: 1, viewDepth: 10 }],
      ],
    };
    expect(Array.from(selectBrushStrokeInData(source, split, { depth: 'through' }))).toEqual([
      0, 2,
    ]);
  });

  it('selects an ellipsoid whose center misses but ±3σ footprint grazes', () => {
    const source = data([[1.25, 0, 0]], 0.01);
    const brush = stroke([[0, 0, 0, 1]]);
    expect(selectBrushStrokeInData(source, brush, { depth: 'through' }).length).toBe(0);
    expect(
      Array.from(
        selectBrushStrokeInData(source, brush, {
          depth: 'through',
          footprint: 'footprint',
        }),
      ),
    ).toEqual([0]);
  });

  it('maps centers and covariance through a non-uniform world transform', () => {
    const source = data([[1, 0, 0]], 0.01);
    const brush = stroke([[2.5, 0, 0, 0.05]]);
    const world = new THREE.Matrix4().makeScale(2, 1, 1);
    expect(
      Array.from(
        selectBrushStrokeInData(source, brush, { depth: 'through', footprint: 'footprint' }, world),
      ),
    ).toEqual([0]);
  });

  it('makes surface and through depth modes independent from footprint mode', () => {
    const source = data(
      [
        [0, 0, -5.2],
        [0, 0, -5.6],
      ],
      0.01,
    );
    const brush = stroke([[0, 0, -5, 1]], new THREE.Matrix4());
    expect(Array.from(selectBrushStrokeInData(source, brush, { depth: 'surface' }))).toEqual([0]);
    expect(
      Array.from(
        selectBrushStrokeInData(source, brush, {
          depth: 'surface',
          footprint: 'footprint',
        }),
      ),
    ).toEqual([0, 1]);
    expect(Array.from(selectBrushStrokeInData(source, brush, { depth: 'through' }))).toEqual([
      0, 1,
    ]);
  });

  it('requires the captured view matrix for the default surface mode', () => {
    expect(() => selectBrushStrokeInData(data([[0, 0, 0]]), stroke([[0, 0, 0, 1]]))).toThrow(
      /surface mode requires stroke\.viewMatrix/,
    );
  });
});
