import { describe, expect, it } from 'vitest';
import { shCoefficientCount } from '../core/sh-pack';
import type { SplatData } from '../core/splat-data';
import { buildStaticLod } from '../static-lod/static-lod';
import { handleStaticLodWorkerRequest } from '../static-lod/static-lod-worker-handler';
import type { StaticLodWorkerResponse } from '../static-lod/static-lod-worker-protocol';

const packedPlyFixture = (): SplatData => {
  const count = 8;
  const stride = shCoefficientCount(3);
  return {
    count,
    positions: Float32Array.from(Array.from({ length: count }, (_, index) => [index, 0, 0]).flat()),
    colors: Uint8Array.from(Array.from({ length: count }, () => [20, 40, 60, 255]).flat()),
    covariances: Float32Array.from(Array.from({ length: count }, () => [1, 0, 0, 1, 0, 1]).flat()),
    format: 'ply',
    shPacked: {
      bands: 3,
      packed: Uint32Array.from(
        Array.from({ length: count }, (_, splat) =>
          Array.from({ length: stride }, (_, coefficient) => splat * 100 + coefficient),
        ).flat(),
      ),
      range: { min: [0, 0, 0], max: [1, 1, 1] },
    },
  };
};

const responseOf = <Type extends StaticLodWorkerResponse['type']>(
  responses: readonly StaticLodWorkerResponse[],
  type: Type,
): Extract<StaticLodWorkerResponse, { type: Type }> => {
  const response = responses.find(
    (candidate): candidate is Extract<StaticLodWorkerResponse, { type: Type }> =>
      candidate.type === type,
  );
  if (!response) throw new Error(`Expected ${type} response.`);
  return response;
};

describe('static LOD worker packed SH transfer', () => {
  it('retains packed compressed-PLY SH through build and index-only selection', () => {
    const source = packedPlyFixture();
    const stride = shCoefficientCount(source.shPacked?.bands ?? 0);
    const hierarchy = buildStaticLod(source, 3);
    expect(hierarchy.finestSplatCount).toBe(3);
    expect(hierarchy.data.count).toBe(6);
    expect(hierarchy.data.shPacked?.packed.length).toBe(hierarchy.data.count * stride);

    const responses: StaticLodWorkerResponse[] = [];
    expect(() => {
      handleStaticLodWorkerRequest({ type: 'build', source, maxBudget: 3 }, (response) => {
        responses.push(response);
      });
    }).not.toThrow();
    expect(responses.some((response) => response.type === 'error')).toBe(false);

    const built = responseOf(responses, 'built');
    expect(built.finestSplatCount).toBe(3);
    expect(built.data.count).toBe(hierarchy.data.count);
    expect(built.data.radTree).toBeUndefined();
    expect(built.data.positions.length).toBe(built.data.count * 3);
    expect(built.data.colors.length).toBe(built.data.count * 4);
    expect(built.data.covariances.length).toBe(built.data.count * 6);
    expect(built.data.shPacked?.packed.length).toBe(built.data.count * stride);
    const sourceSh = Array.from({ length: source.count }, (_, index) => [
      ...(source.shPacked?.packed.subarray(index * stride, (index + 1) * stride) ?? []),
    ]);
    for (let index = 0; index < built.finestSplatCount; index++) {
      expect(sourceSh).toContainEqual([
        ...(built.data.shPacked?.packed.subarray(index * stride, (index + 1) * stride) ?? []),
      ]);
    }

    handleStaticLodWorkerRequest(
      {
        type: 'select',
        sequence: 1,
        budget: 1,
        cameraLocal: [0, 0, 10],
        cameraForward: [0, 0, -1],
      },
      (response) => responses.push(response),
    );
    const selection = responseOf(responses, 'selection');
    expect(selection.indices).toHaveLength(1);
    const index = selection.indices[0] as number;
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(built.data.count);
    expect(sourceSh).toContainEqual([
      ...(built.data.shPacked?.packed.subarray(index * stride, (index + 1) * stride) ?? []),
    ]);
  });

  it('reports inconsistent worker input structurally before copying packed SH', () => {
    const source = packedPlyFixture();
    const malformed: SplatData = {
      ...source,
      shPacked: { ...source.shPacked!, packed: source.shPacked!.packed.slice(1) },
    };
    const responses: StaticLodWorkerResponse[] = [];
    handleStaticLodWorkerRequest({ type: 'build', source: malformed, maxBudget: 3 }, (response) => {
      responses.push(response);
    });
    const error = responseOf(responses, 'error');
    expect(error.message).toMatch(/structurally inconsistent: shPacked\.packed/);
  });
});
