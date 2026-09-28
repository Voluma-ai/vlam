import { describe, expect, it } from 'vitest';
import { SplatMesh } from '../core/splat-mesh';
import type { SplatData } from '../core/splat-data';
import type { SplatRange } from '../core/splat-mesh-types';

class WritableMesh extends SplatMesh {
  overwrite(handle: SplatRange, data: SplatData, offset: number): void {
    this.overwriteRangeData(handle, data, offset);
  }
}

function points(values: number[]): SplatData {
  const count = values.length / 3;
  return {
    count,
    positions: Float32Array.from(values),
    colors: new Uint8Array(count * 4),
    covariances: new Float32Array(count * 6),
  };
}

describe('sparse overwrite bounds', () => {
  it('expands each axis and retains earlier extrema across partial writes', () => {
    const mesh = new WritableMesh({ capacity: 2048 });
    try {
      const range = mesh.appendRange(points([1, 2, 3, 4, 5, 6]));
      mesh.overwrite(range, points([-9, -8, -7]), 0);
      mesh.overwrite(range, points([20, 30, 40]), 1);
      expect(mesh.computeSplatBounds().min.toArray()).toEqual([-9, -8, -7]);
      expect(mesh.computeSplatBounds().max.toArray()).toEqual([20, 30, 40]);

      mesh.overwrite(range, points([-1, 0, 1, 2, 3, 4]), 0);
      expect(mesh.computeSplatBounds().min.toArray()).toEqual([-9, -8, -7]);
      expect(mesh.computeSplatBounds().max.toArray()).toEqual([20, 30, 40]);
    } finally {
      mesh.dispose();
    }
  });
});
