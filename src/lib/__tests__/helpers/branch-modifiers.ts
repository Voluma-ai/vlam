/**
 * Test-only modifiers that read one context field only inside sibling `If`
 * branches, in the shapes hosts write for per-light shading loops.
 */
import type * as THREE from 'three/webgpu';
import { Fn, If, float, int, uniform, vec3, vec4 } from 'three/tsl';
import type { SplatContext, SplatModifier } from '../../core/splat-modifier';

/**
 * Sibling branches per modifier. three r186 inlines a shared node on its
 * first branch read and names a temp on the second, so the third sibling is
 * the first to read a var it never assigned.
 */
export const BRANCHES = 3;

/** A context field and how a branch turns it into a color contribution. */
export interface ContextRead {
  readonly field: (ctx: SplatContext) => THREE.Node;
  readonly toVec3: (value: THREE.Node) => THREE.Node<'vec3'>;
}

const asVec3 = (value: THREE.Node) => value as THREE.Node<'vec3'>;

/**
 * One entry per context field. Run each after {@link tint}, so `color` is an
 * earlier modifier's output rather than the pass's own pinned input.
 */
export const contextReads: Record<string, ContextRead> = {
  color: { field: (ctx) => ctx.color, toVec3: (v) => (v as THREE.Node<'vec4'>).rgb },
  normal: { field: (ctx) => ctx.normal, toVec3: asVec3 },
  localCenter: { field: (ctx) => ctx.localCenter, toVec3: asVec3 },
  sourceCenter: { field: (ctx) => ctx.sourceCenter, toVec3: asVec3 },
  baseColor: { field: (ctx) => ctx.baseColor, toVec3: (v) => (v as THREE.Node<'vec4'>).rgb },
  worldCenter: { field: (ctx) => ctx.worldCenter, toVec3: asVec3 },
  viewCenter: { field: (ctx) => ctx.viewCenter, toVec3: asVec3 },
  localToView: {
    field: (ctx) => ctx.localToView!,
    toVec3: (v) => (v as THREE.Node<'mat3'>).mul(vec3(1, 0, 0)),
  },
  channel: { field: (ctx) => ctx.channel('mask'), toVec3: (v) => vec3(v as THREE.Node<'float'>) },
  index: { field: (ctx) => ctx.index, toVec3: (v) => vec3(float(v as THREE.Node<'int'>)) },
};

/** A plain color modifier to run ahead of a branch modifier. */
export const tint: SplatModifier = (ctx) => ({
  color: vec4(ctx.color.rgb.mul(0.5), ctx.color.a),
});

/**
 * Every context read happens only inside an `If` that skips out-of-range
 * lights: either on a field passed into an inline `Fn`, or read afresh in
 * each branch inside one. The output builds the branches before it reads
 * `ctx.color`, so nothing a branch reads was emitted ahead of it.
 */
export const branchShapes: Record<string, (read: ContextRead) => SplatModifier> = {
  'Fn argument': ({ field, toVec3 }) => {
    const count = uniform(0, 'int');
    const accumulate = Fn(([value]: [THREE.Node]) => {
      const sum = vec3(0, 0, 0).toVar();
      for (let k = 0; k < BRANCHES; k++) {
        If(int(k).lessThan(count), () => {
          sum.addAssign(toVec3(value).mul(float(k + 1)));
        });
      }
      return sum;
    });
    return (ctx) => {
      const sum = accumulate(field(ctx)) as THREE.Node<'vec3'>;
      return { color: vec4(sum.add(ctx.color.rgb), ctx.color.a) };
    };
  },
  'read per branch': ({ field, toVec3 }) => {
    const count = uniform(0, 'int');
    return (ctx) => {
      const sum = Fn(() => {
        const sum = vec3(0, 0, 0).toVar();
        for (let k = 0; k < BRANCHES; k++) {
          If(int(k).lessThan(count), () => {
            sum.addAssign(toVec3(field(ctx)).mul(float(k + 1)));
          });
        }
        return sum;
      })() as THREE.Node<'vec3'>;
      return { color: vec4(sum.add(ctx.color.rgb), ctx.color.a) };
    };
  },
};
