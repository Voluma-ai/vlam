/**
 * Test-only WGSL inspection for TSL graphs.
 *
 * Builds a compute pass's or a material's WGSL in Node (no GPU) and checks
 * that every `nodeVarN` a statement reads was assigned in a block that
 * encloses it.
 * three r186 can cache a reused temp's var name in the parent scope even
 * when the assignment was emitted inside an `If`, so code after the branch
 * reads a var that only that branch wrote. WGSL zero-initializes function
 * vars, so the shader compiles and silently computes with zeros.
 */
import * as THREE from 'three/webgpu';
import { context } from 'three/tsl';

/**
 * Just enough of a renderer for `WGSLNodeBuilder` on the graphs these tests
 * build (texture loads, storage buffers, an unlit node material); nothing
 * here reaches a GPU device.
 */
function rendererStub(): unknown {
  return {
    backend: {
      compatibilityMode: false,
      utils: { getTextureSampleData: () => ({ primarySamples: 1 }) },
    },
    contextNode: context(),
    currentColorSpace: THREE.SRGBColorSpace,
    currentToneMapping: THREE.NoToneMapping,
    debug: { diagnostics: { keywords: new Set() }, onNodeBuilderCreated: null },
    getColorBufferType: () => THREE.HalfFloatType,
    getMRT: () => null,
    getOutputRenderTarget: () => null,
    getRenderTarget: () => null,
    hasCompatibility: () => false,
    hasFeature: () => false,
    library: new THREE.StandardNodeLibrary(),
    lighting: new THREE.Lighting(),
    localClippingEnabled: false,
    nodes: { getCacheKey: () => 0 },
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: false },
    toneMapping: THREE.NoToneMapping,
  };
}

// three's typings omit the compute-only entry (a null object plus
// `compute`), the scene/camera/material fields and `build()`'s outputs.
type HeadlessBuilder = {
  compute: THREE.ComputeNode;
  scene: THREE.Scene;
  camera: THREE.Camera;
  material: THREE.Material;
  build(): void;
  computeShader: string;
  vertexShader: string;
  fragmentShader: string;
};
const Builder = THREE.WGSLNodeBuilder as unknown as new (
  object: THREE.Object3D | null,
  renderer: unknown,
) => HeadlessBuilder;

/** Generates the WGSL for `computeNode` with a minimal renderer stub. */
export function buildComputeWgsl(computeNode: THREE.ComputeNode): string {
  const builder = new Builder(null, rendererStub());
  builder.compute = computeNode;
  builder.build();
  return builder.computeShader;
}

/** Generates the vertex and fragment WGSL for drawing `mesh` with its material. */
export function buildMaterialWgsl(mesh: THREE.Mesh): { vertex: string; fragment: string } {
  const builder = new Builder(mesh, rendererStub());
  builder.scene = new THREE.Scene();
  builder.camera = new THREE.PerspectiveCamera();
  builder.material = mesh.material as THREE.Material;
  builder.build();
  return { vertex: builder.vertexShader, fragment: builder.fragmentShader };
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
