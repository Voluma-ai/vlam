/**
 * Test-only WGSL inspection for TSL compute graphs.
 *
 * Builds a compute node's WGSL in Node (no GPU) and checks that every
 * `nodeVarN` a statement reads was assigned in a block that encloses it.
 * three r186 can cache a reused temp's var name in the parent scope even
 * when the assignment was emitted inside an `If`, so code after the branch
 * reads a var that only that branch wrote. WGSL zero-initializes function
 * vars, so the shader compiles and silently computes with zeros.
 */
import * as THREE from 'three/webgpu';
import { context } from 'three/tsl';

/** Generates the WGSL for `computeNode` with a minimal renderer stub. */
export function buildComputeWgsl(computeNode: THREE.ComputeNode): string {
  // Just enough of a renderer for `WGSLNodeBuilder` on a compute node that
  // only does `textureLoad`s; nothing here reaches a GPU device.
  const renderer = {
    backend: {
      compatibilityMode: false,
      utils: { getTextureSampleData: () => ({ primarySamples: 1 }) },
    },
    contextNode: context(),
    debug: { diagnostics: { keywords: new Set() }, onNodeBuilderCreated: null },
    hasCompatibility: () => false,
    hasFeature: () => false,
  };
  // three's typings omit the compute-only entry (a null object plus
  // `compute`) and `build()`/`computeShader`, which the backend uses.
  const Builder = THREE.WGSLNodeBuilder as unknown as new (
    object: null,
    renderer: unknown,
  ) => { compute: THREE.ComputeNode; build(): void; computeShader: string };
  const builder = new Builder(null, renderer);
  builder.compute = computeNode;
  builder.build();
  return builder.computeShader;
}

/** A `nodeVarN` read with no assignment in any enclosing block. */
export interface OutOfScopeRead {
  readonly variable: string;
  readonly line: string;
}

/**
 * Lists reads of TSL temps (`nodeVarN`) that no enclosing block assigned.
 *
 * Understands the flat shape three emits for the entry point: one statement
 * per line, `if (…) {` / `} else {` / `}` on their own lines. A var assigned
 * in both arms of an if/else counts as assigned after it.
 */
export function findOutOfScopeReads(wgsl: string): OutOfScopeRead[] {
  const body = wgsl.slice(wgsl.indexOf('// flow'));
  const frames: { assigned: Set<string>; ifArm: Set<string> | null }[] = [
    { assigned: new Set(), ifArm: null },
  ];
  const violations: OutOfScopeRead[] = [];
  const checkReads = (code: string, line: string) => {
    for (const [variable] of code.matchAll(/\bnodeVar\d+\b/g)) {
      if (!frames.some((frame) => frame.assigned.has(variable))) {
        violations.push({ variable, line: line.trim() });
      }
    }
  };
  for (const line of body.split('\n')) {
    const statement = line.trim();
    if (statement === '' || statement.startsWith('//')) continue;
    if (statement === '} else {') {
      const arm = frames.pop()!;
      frames.push({ assigned: new Set(), ifArm: arm.assigned });
      continue;
    }
    if (statement === '}') {
      const frame = frames.pop()!;
      if (frame.ifArm) {
        const parent = frames[frames.length - 1]!;
        for (const variable of frame.assigned) {
          if (frame.ifArm.has(variable)) parent.assigned.add(variable);
        }
      }
      continue;
    }
    if (statement.endsWith('{')) {
      checkReads(statement, line);
      frames.push({ assigned: new Set(), ifArm: null });
      continue;
    }
    const assignment = /^(nodeVar\d+) = (.*);$/.exec(statement);
    if (assignment) {
      checkReads(assignment[2]!, line);
      frames[frames.length - 1]!.assigned.add(assignment[1]!);
      continue;
    }
    checkReads(statement, line);
  }
  return violations;
}
