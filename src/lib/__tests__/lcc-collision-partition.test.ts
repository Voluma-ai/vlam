import { describe, expect, it } from 'vitest';
import { partitionTriangleMesh } from '../formats/lcc/collision-partition';
import { createSelectionVolume } from '../selection-volume';
import type { TriangleMeshData } from '../formats/lcc/parse-mesh-ply';

/**
 * Triangle-mesh partition: the any-vertex-inside policy, compact reindexing,
 * and exact tiling of the two halves.
 */

/** A unit-quad strip along X: quads [0,1], [1,2], ... each of two triangles. */
function strip(quadCount: number): TriangleMeshData {
  const vertexCount = (quadCount + 1) * 2;
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i <= quadCount; i++) {
    positions.set([i, 0, 0], i * 2 * 3);
    positions.set([i, 0, 1], (i * 2 + 1) * 3);
  }
  const indices = new Uint32Array(quadCount * 6);
  for (let q = 0; q < quadCount; q++) {
    const a = q * 2;
    indices.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], q * 6);
  }
  return { vertexCount, triangleCount: quadCount * 2, positions, indices };
}

/** A triangle's vertex positions, sorted, for order-independent comparison. */
function triangleSet(mesh: TriangleMeshData): string[] {
  const out: string[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    const corners: string[] = [];
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k] as number;
      corners.push(Array.from(mesh.positions.subarray(v * 3, v * 3 + 3)).join(','));
    }
    out.push(corners.sort().join(';'));
  }
  return out.sort();
}

describe('partitionTriangleMesh', () => {
  it('assigns a triangle inside when any vertex is inside', () => {
    const mesh = strip(4); // spans x ∈ [0, 4]
    // Thin box around the x=0 edge catching exactly its two vertices: both
    // triangles of quad 0 have an x=0 vertex, nothing else does.
    const volume = createSelectionVolume({ kind: 'box', halfExtents: [0.5, 2, 2] });
    const { inside, outside } = partitionTriangleMesh(mesh, volume);
    expect(inside.triangleCount).toBe(2);
    expect(outside.triangleCount).toBe(6);
  });

  it('tiles the source exactly (no lost or duplicated triangles)', () => {
    const mesh = strip(6);
    const volume = createSelectionVolume({ kind: 'box', halfExtents: [2.5, 1, 2] });
    const { inside, outside } = partitionTriangleMesh(mesh, volume);
    expect(inside.triangleCount + outside.triangleCount).toBe(mesh.triangleCount);
    expect([...triangleSet(inside), ...triangleSet(outside)].sort()).toEqual(triangleSet(mesh));
  });

  it('compacts vertex buffers to only referenced vertices', () => {
    const mesh = strip(4);
    const volume = createSelectionVolume({ kind: 'box', halfExtents: [0.5, 2, 2] });
    const { inside, outside } = partitionTriangleMesh(mesh, volume);
    // Quad 0 references vertices at x ∈ {0, 1} only → 4 vertices.
    expect(inside.vertexCount).toBe(4);
    for (const i of inside.indices) expect(i).toBeLessThan(inside.vertexCount);
    // The outside keeps the shared x=1 vertices too (duplicated across halves).
    expect(outside.vertexCount).toBe(8);
    for (const i of outside.indices) expect(i).toBeLessThan(outside.vertexCount);
  });

  it('preserves winding within each triangle', () => {
    // triangleSet() sorts corners, so it cannot see a flip - compare the corner
    // sequence in order, rotated to a canonical start.
    const mesh = strip(3);
    const { inside, outside } = partitionTriangleMesh(mesh, { containsPoint: (x) => x < 1.5 });
    const cycles = (m: TriangleMeshData): string[] => {
      const out: string[] = [];
      for (let t = 0; t < m.triangleCount; t++) {
        const corners = [0, 1, 2].map((k) => {
          const v = m.indices[t * 3 + k] as number;
          return Array.from(m.positions.subarray(v * 3, v * 3 + 3)).join(',');
        });
        // Rotate so the lexicographically smallest corner leads; a reversal
        // (winding flip) survives this normalization and would fail below.
        const start = corners.indexOf([...corners].sort()[0] as string);
        out.push([corners[start], corners[(start + 1) % 3], corners[(start + 2) % 3]].join(';'));
      }
      return out.sort();
    };
    expect([...cycles(inside), ...cycles(outside)].sort()).toEqual(cycles(mesh));
  });

  it('keeps a triangle with two vertices inside, and drops orphan vertices', () => {
    const mesh = strip(2);
    // x < 1.5 catches the x=0 and x=1 vertices: quad 0 fully, quad 1 by two
    // vertices each. Nothing references the extra vertex added below.
    const withOrphan: TriangleMeshData = {
      ...mesh,
      vertexCount: mesh.vertexCount + 1,
      positions: Float32Array.from([...mesh.positions, 99, 99, 99]),
    };
    const { inside, outside } = partitionTriangleMesh(withOrphan, {
      containsPoint: (x) => x < 1.5,
    });
    expect(inside.triangleCount).toBe(4); // both quads touch an inside vertex
    expect(outside.triangleCount).toBe(0);
    // The orphan is referenced by no triangle, so it survives in neither half.
    expect(inside.vertexCount).toBe(6);
    expect(Array.from(inside.positions)).not.toContain(99);
  });

  it('throws on a mesh whose arrays disagree with its counts', () => {
    const mesh = strip(2);
    expect(() =>
      partitionTriangleMesh(
        { ...mesh, triangleCount: mesh.triangleCount + 5 },
        { containsPoint: () => true },
      ),
    ).toThrow(/too few for/);
    expect(() =>
      partitionTriangleMesh({ ...mesh, vertexCount: 1 }, { containsPoint: () => true }),
    ).toThrow(/out of range/);
  });

  it('handles empty and full selections', () => {
    const mesh = strip(2);
    const nothing = partitionTriangleMesh(mesh, { containsPoint: () => false });
    expect(nothing.inside.triangleCount).toBe(0);
    expect(nothing.inside.vertexCount).toBe(0);
    expect(nothing.outside.triangleCount).toBe(mesh.triangleCount);

    const everything = partitionTriangleMesh(mesh, { containsPoint: () => true });
    expect(everything.outside.triangleCount).toBe(0);
    expect(everything.inside.triangleCount).toBe(mesh.triangleCount);
    expect(triangleSet(everything.inside)).toEqual(triangleSet(mesh));
  });
});
