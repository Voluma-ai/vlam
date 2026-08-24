import { describe, expect, it } from 'vitest';
import {
  computeTouchedChunks,
  frontierView,
  searchLimitWithinBudget,
  traverseFrontier,
} from '../formats/rad/rad-frontier';
import type { SplatData } from '../splat-data';

/** A node for the tree-traversal tests: LOD `size`, position, and child links. */
interface TreeNode {
  size: number;
  pos: [number, number, number];
  childCount: number;
  childStart: number;
}

/** Builds a `chunkMap` (file → SplatData with a radTree) from a flat node list,
 * split into chunks of `chunkSize`. Global index = file*chunkSize + local. */
function buildChunkMap(nodes: TreeNode[], chunkSize: number): Map<number, SplatData> {
  const map = new Map<number, SplatData>();
  const files = Math.ceil(nodes.length / chunkSize);
  for (let file = 0; file < files; file++) {
    const slice = nodes.slice(file * chunkSize, (file + 1) * chunkSize);
    const count = slice.length;
    const positions = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const childCount = new Uint16Array(count);
    const childStart = new Uint32Array(count);
    slice.forEach((n, i) => {
      positions.set(n.pos, i * 3);
      size[i] = n.size;
      childCount[i] = n.childCount;
      childStart[i] = n.childStart;
    });
    map.set(file, {
      count,
      positions,
      colors: new Uint8Array(count * 4),
      covariances: new Float32Array(count * 6),
      radTree: { childCount, childStart, size },
    });
  }
  return map;
}

/** A 7-node tree, chunkSize 4: root 0 (chunk 0) → 1,2 (chunk 0) → 4,5 / 6,7 (chunk 1). */
function sampleTree(): TreeNode[] {
  const p: [number, number, number] = [0, 0, 1]; // all at distance 1 from the origin
  return [
    { size: 8, pos: p, childCount: 2, childStart: 1 }, // 0 root → 1,2 (same chunk)
    { size: 4, pos: p, childCount: 2, childStart: 4 }, // 1 → 4,5 (chunk 1)
    { size: 4, pos: p, childCount: 2, childStart: 6 }, // 2 → 6,7 (chunk 1)
    { size: 4, pos: p, childCount: 0, childStart: 0 }, // 3 (padding leaf in chunk 0)
    { size: 1, pos: p, childCount: 0, childStart: 0 }, // 4 leaf
    { size: 1, pos: p, childCount: 0, childStart: 0 }, // 5 leaf
    { size: 1, pos: p, childCount: 0, childStart: 0 }, // 6 leaf
    { size: 1, pos: p, childCount: 0, childStart: 0 }, // 7 leaf
  ];
}

/** Isotropic covariance whose trace gives `own_size = 2·√(trace/3) = size`. */
function isoCov(size: number): [number, number, number, number, number, number] {
  const v = (size / 2) ** 2; // per-axis variance; trace = 3v ⇒ own = size
  return [v, 0, 0, v, 0, v];
}

describe('traverseFrontier', () => {
  // Origin, unfoveated (no `forward`): every node sits at distance 1 and keeps
  // its full `size / distance`, so the cases below read as plain LOD cuts.
  const cam = frontierView({ x: 0, y: 0, z: 0 }, undefined);

  it('stops at the coarsest level when the root is small enough', () => {
    const map = buildChunkMap(sampleTree(), 4);
    // root size 8 / dist 1 = 8 ≤ limit 10 → output root only.
    const { selection, count } = traverseFrontier(map, [0], 4, cam, 10);
    expect(count).toBe(1);
    expect(Array.from(selection.get(0) ?? [])).toEqual([0]);
  });

  it('descends to the mid level', () => {
    const map = buildChunkMap(sampleTree(), 4);
    // root 8 > 5 → descend to 1,2 (size 4 ≤ 5) → output both.
    const { selection, count } = traverseFrontier(map, [0], 4, cam, 5);
    expect(count).toBe(2);
    expect(Array.from(selection.get(0) ?? []).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('descends to the leaves when the limit is fine', () => {
    const map = buildChunkMap(sampleTree(), 4);
    const { selection, count } = traverseFrontier(map, [0], 4, cam, 2);
    expect(count).toBe(4);
    // Chunk 1 holds globals 4–7 = locals 0–3; the selection stores local indices.
    expect(Array.from(selection.get(1) ?? []).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('outputs coarse stand-ins and records touched chunks when children are absent', () => {
    const full = buildChunkMap(sampleTree(), 4);
    const partial = new Map([[0, full.get(0)!]]); // chunk 1 (the leaves) not cached
    const { selection, count, touched } = traverseFrontier(partial, [0], 4, cam, 2);
    // root descends to 1,2 (same chunk); each wants chunk 1 (not cached) → coarse.
    expect(count).toBe(2);
    expect(Array.from(selection.get(0) ?? []).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(touched.has(1)).toBe(true); // chunk 1 is the detail to fetch next
  });

  it('stops descending once the budget is reached, and still covers the scene', () => {
    const map = buildChunkMap(sampleTree(), 4);
    // A leaf-level cut wants 4 splats. Under a budget of 3 the traversal spends
    // it biggest-first: node 1 refines into leaves 4,5 and node 2 stays a coarse
    // stand-in for leaves 6,7. Every leaf is still represented exactly once -
    // the budget costs detail, never coverage.
    const { selection, count } = traverseFrontier(map, [0], 4, cam, 2, 3);
    expect(count).toBe(3);
    expect(Array.from(selection.get(0) ?? [])).toEqual([2]); // node 2, coarse
    expect(Array.from(selection.get(1) ?? []).sort((a, b) => a - b)).toEqual([0, 1]); // leaves 4,5
  });

  it('never exceeds the budget, at any cut', () => {
    const map = buildChunkMap(sampleTree(), 4);
    for (const budget of [1, 2, 3, 4, 5]) {
      for (const limit of [0.5, 1, 2, 5, 10]) {
        expect(traverseFrontier(map, [0], 4, cam, limit, budget).count).toBeLessThanOrEqual(budget);
      }
    }
  });
});

describe('traverseFrontier - foveation keeps off-cone content covered', () => {
  /** Two nodes 10 units out on ±x, each with two children; camera looks at +x. */
  function splitScene(): { nodes: TreeNode[]; roots: number[] } {
    const front: [number, number, number] = [10, 0, 0];
    const behind: [number, number, number] = [-10, 0, 0];
    return {
      nodes: [
        { size: 8, pos: front, childCount: 2, childStart: 2 }, // 0 root (ahead)
        { size: 8, pos: behind, childCount: 2, childStart: 4 }, // 1 root (behind)
        { size: 2, pos: front, childCount: 0, childStart: 0 },
        { size: 2, pos: front, childCount: 0, childStart: 0 },
        { size: 2, pos: behind, childCount: 0, childStart: 0 },
        { size: 2, pos: behind, childCount: 0, childStart: 0 },
      ],
      roots: [0, 1],
    };
  }

  const eye = { x: 0, y: 0, z: 0 };
  const lookAtPlusX = { x: 1, y: 0, z: 0 };

  it('emits the behind-camera subtree - coarser, never absent', () => {
    const { nodes, roots } = splitScene();
    const map = buildChunkMap(nodes, 8);
    // limit 0.5: ahead, 8/10 = 0.8 > 0.5 → descend to the leaves (2/10 = 0.2).
    // Behind, the 0.2 weight makes it 0.16 ≤ 0.5 → the root stands in, coarse.
    const view = frontierView(eye, lookAtPlusX);
    const { selection } = traverseFrontier(map, roots, 8, view, 0.5);
    const locals = Array.from(selection.get(0) ?? []).sort((a, b) => a - b);
    expect(locals).toContain(1); // the behind root is present…
    expect(locals).not.toContain(0); // …while the front root refined away
    expect(locals).toEqual([1, 2, 3]);
  });

  it('covers every root whatever the view direction (no cull can empty it)', () => {
    const { nodes, roots } = splitScene();
    const map = buildChunkMap(nodes, 8);
    for (const dir of [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: -1 },
    ]) {
      const { count } = traverseFrontier(map, roots, 8, frontierView(eye, dir), 0.5);
      // Two disjoint subtrees, so a complete cover is at least two nodes.
      expect(count).toBeGreaterThanOrEqual(2);
    }
  });

  it('a narrower cone coarsens the periphery without dropping it', () => {
    const { nodes, roots } = splitScene();
    const map = buildChunkMap(nodes, 8);
    const wide = frontierView(eye, lookAtPlusX, {
      coneFov0: 360,
      coneFov: 360,
      coneFoveate: 1,
      behindFoveate: 1,
    });
    const narrow = frontierView(eye, lookAtPlusX);
    const wideCut = traverseFrontier(map, roots, 8, wide, 0.5);
    const narrowCut = traverseFrontier(map, roots, 8, narrow, 0.5);
    // Unfoveated both subtrees refine; foveated the behind one stays coarse.
    expect(wideCut.count).toBe(4);
    expect(narrowCut.count).toBe(3);
  });
});

/** Deterministic PRNG (mulberry32) for the property tests. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds a random Spark-shaped LOD forest: nodes are appended breadth-first
 * (children contiguous, always after their parent - the encoder's invariants),
 * sizes strictly shrink with depth, positions are random. Returns the flat node
 * list plus each node's parent (−1 for a root).
 */
function randomForest(
  rand: () => number,
  maxNodes: number,
): { nodes: TreeNode[]; parents: number[] } {
  const rootCount = 1 + Math.floor(rand() * 3);
  const nodes: TreeNode[] = [];
  const parents: number[] = [];
  const depth: number[] = [];
  for (let r = 0; r < rootCount; r++) {
    nodes.push({
      size: 16,
      pos: [rand() * 4 - 2, rand() * 4 - 2, 1 + rand() * 4],
      childCount: 0,
      childStart: 0,
    });
    parents.push(-1);
    depth.push(0);
  }
  for (let i = 0; i < nodes.length && nodes.length < maxNodes; i++) {
    const kids = rand() < 0.55 ? 2 + Math.floor(rand() * 3) : 0;
    if (kids === 0 || nodes.length + kids > maxNodes) continue;
    const node = nodes[i]!;
    node.childCount = kids;
    node.childStart = nodes.length;
    for (let c = 0; c < kids; c++) {
      nodes.push({
        size: node.size / 2 + rand() * (node.size / 4),
        pos: [node.pos[0] + rand() - 0.5, node.pos[1] + rand() - 0.5, node.pos[2] + rand() - 0.5],
        childCount: 0,
        childStart: 0,
      });
      parents.push(i);
      depth.push(depth[i]! + 1);
    }
  }
  return { nodes, parents };
}

/** How many of `{leaf, ancestors…}` are in the selection (global index test). */
function coveringCount(leaf: number, parents: number[], selectedGlobals: Set<number>): number {
  let covered = 0;
  for (let n: number = leaf; n !== -1; n = parents[n]!) {
    if (selectedGlobals.has(n)) covered++;
  }
  return covered;
}

function selectionGlobals(selection: Map<number, Uint32Array>, chunkSize: number): Set<number> {
  const set = new Set<number>();
  for (const [file, locals] of selection) {
    for (const l of locals) set.add(file * chunkSize + l);
  }
  return set;
}

describe('traverseFrontier - selected-index coverage (E7)', () => {
  it('property: with a full cache the cut covers every leaf exactly once', () => {
    // No leaf may be unrepresented (a hole) or represented by both an ancestor
    // and a descendant (double-draw) - for any tree shape and any limit.
    const rand = rng(0xc0ffee);
    for (let trial = 0; trial < 40; trial++) {
      const { nodes, parents } = randomForest(rand, 120);
      const chunkSize = 8; // small, so child ranges straddle chunk boundaries
      const map = buildChunkMap(nodes, chunkSize);
      const roots = parents.flatMap((p, i) => (p === -1 ? [i] : []));
      const limit = 0.05 * Math.pow(4, rand() * 5); // spans coarse → leaf cuts
      const { selection, count } = traverseFrontier(
        map,
        roots,
        chunkSize,
        frontierView({ x: 0, y: 0, z: 0 }, undefined),
        limit,
      );
      const selected = selectionGlobals(selection, chunkSize);
      expect(selected.size).toBe(count);
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i]!.childCount !== 0) continue;
        expect(coveringCount(i, parents, selected)).toBe(1);
      }
    }
  });

  it('property: with a partial cache every leaf under a cached root is still covered exactly once', () => {
    // Missing chunks must degrade to coarse stand-ins, never to holes or
    // double-representation.
    const rand = rng(0xbadcafe);
    for (let trial = 0; trial < 40; trial++) {
      const { nodes, parents } = randomForest(rand, 120);
      const chunkSize = 8;
      const full = buildChunkMap(nodes, chunkSize);
      const map = new Map(full);
      for (const file of full.keys()) {
        if (file !== 0 && rand() < 0.4) map.delete(file); // chunk 0 (roots) stays
      }
      const roots = parents.flatMap((p, i) => (p === -1 ? [i] : []));
      const { selection } = traverseFrontier(
        map,
        roots,
        chunkSize,
        frontierView({ x: 0, y: 0, z: 0 }, undefined),
        0.2,
      );
      const selected = selectionGlobals(selection, chunkSize);
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i]!.childCount !== 0) continue;
        expect(coveringCount(i, parents, selected)).toBe(1);
      }
    }
  });

  it('keeps the coarse stand-in when a child range straddles into an uncached chunk', () => {
    // chunkSize 4: parent (global 1) has 3 children at globals 3,4,5 - spanning
    // chunks 0 and 1. With chunk 1 absent, descending would drop children 4,5
    // (a coverage hole); the parent must stay selected and chunk 1 be touched.
    const p: [number, number, number] = [0, 0, 1];
    const nodes: TreeNode[] = [
      { size: 8, pos: p, childCount: 2, childStart: 1 }, // 0 root → 1,2
      { size: 4, pos: p, childCount: 3, childStart: 3 }, // 1 → 3,4,5 (straddles)
      { size: 4, pos: p, childCount: 0, childStart: 0 }, // 2 leaf
      { size: 1, pos: p, childCount: 0, childStart: 0 }, // 3 leaf (chunk 0)
      { size: 1, pos: p, childCount: 0, childStart: 0 }, // 4 leaf (chunk 1)
      { size: 1, pos: p, childCount: 0, childStart: 0 }, // 5 leaf (chunk 1)
    ];
    const full = buildChunkMap(nodes, 4);
    const partial = new Map([[0, full.get(0)!]]);
    const eye = frontierView({ x: 0, y: 0, z: 0 }, undefined);
    const { selection, touched } = traverseFrontier(partial, [0], 4, eye, 2);
    // Node 1 must NOT descend (children 4,5 uncached) - it stands in coarse.
    expect(Array.from(selection.get(0) ?? []).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(touched.has(1)).toBe(true);
    // Fully cached, the same cut descends through the straddle cleanly.
    const fullCut = traverseFrontier(full, [0], 4, eye, 2);
    expect(fullCut.count).toBe(4); // leaves 2,3,4,5
  });
});

describe('computeTouchedChunks', () => {
  it('records every chunk a straddling child range spans', () => {
    // One coarse internal node whose children span chunks 1 and 2.
    const count = 1;
    const positions = new Float32Array([0, 0, 1]);
    const covariances = new Float32Array(count * 6);
    covariances.set(isoCov(4), 0); // own 4 / dist 1 = 4 > limit → wants children
    const data = {
      count,
      positions,
      colors: new Uint8Array(count * 4),
      covariances,
      radTree: {
        childCount: Uint16Array.from([4]),
        childStart: Uint32Array.from([6]), // chunkSize 4 → children 6..9 span chunks 1,2
        size: new Float32Array([4]),
      },
    } as SplatData;
    const touched = computeTouchedChunks([{ file: 0, data }], { x: 0, y: 0, z: 0 }, 1, 4);
    expect(touched.has(1)).toBe(true);
    expect(touched.has(2)).toBe(true);
  });
});

describe('searchLimitWithinBudget - draw-budget feedback (E7)', () => {
  /** A synthetic cut: count(limit) = number of thresholds strictly above limit. */
  const evaluator = (thresholds: number[]) => (limit: number) => ({
    count: thresholds.filter((t) => t > limit).length,
  });

  it('never refines into an over-budget cut (the old loop could end a frame over budget)', () => {
    // All-or-nothing cut: 200 splats share one threshold (0.3). Any target in
    // (0, 200) has no exact fit; the search must settle on the under-budget
    // side, not oscillate onto the 200-splat side.
    const thresholds = Array.from({ length: 200 }, () => 0.3);
    const { result, limit } = searchLimitWithinBudget(evaluator(thresholds), 0.05, 0.01, 50, 6);
    expect(result.count).toBeLessThanOrEqual(50);
    expect(limit).toBeGreaterThan(0.3);
  });

  it('reaches a fixed point: re-running from the returned limit changes nothing (static camera)', () => {
    const rand = rng(0x5eed);
    for (let trial = 0; trial < 30; trial++) {
      const thresholds = Array.from({ length: 300 }, () => 0.02 * Math.pow(50, rand()));
      const target = 20 + Math.floor(rand() * 200);
      const evalFn = evaluator(thresholds);
      let limit = 0.05;
      // Converge over "frames" (each carries the returned limit forward).
      for (let frame = 0; frame < 10; frame++)
        limit = searchLimitWithinBudget(evalFn, limit, 0.001, target, 6).limit;
      const a = searchLimitWithinBudget(evalFn, limit, 0.001, target, 6);
      const b = searchLimitWithinBudget(evalFn, a.limit, 0.001, target, 6);
      expect(b.limit).toBe(a.limit);
      expect(b.result.count).toBe(a.result.count);
      expect(a.result.count).toBeLessThanOrEqual(target);
    }
  });

  it('re-converges after a budget change in both directions', () => {
    const rand = rng(0xb1d6e7);
    const thresholds = Array.from({ length: 400 }, () => 0.02 * Math.pow(50, rand()));
    const evalFn = evaluator(thresholds);
    let limit = 0.05;
    for (let frame = 0; frame < 10; frame++)
      limit = searchLimitWithinBudget(evalFn, limit, 0.001, 300, 6).limit;
    expect(searchLimitWithinBudget(evalFn, limit, 0.001, 300, 6).result.count).toBeLessThanOrEqual(
      300,
    );
    // Budget drops to 60: carrying the limit forward must coarsen back under it.
    for (let frame = 0; frame < 10; frame++)
      limit = searchLimitWithinBudget(evalFn, limit, 0.001, 60, 6).limit;
    const low = searchLimitWithinBudget(evalFn, limit, 0.001, 60, 6);
    expect(low.result.count).toBeLessThanOrEqual(60);
    // Budget rises again: the search refines and recovers detail.
    for (let frame = 0; frame < 10; frame++)
      limit = searchLimitWithinBudget(evalFn, limit, 0.001, 300, 6).limit;
    const high = searchLimitWithinBudget(evalFn, limit, 0.001, 300, 6);
    expect(high.result.count).toBeGreaterThan(low.result.count);
    expect(high.result.count).toBeLessThanOrEqual(300);
  });
});
