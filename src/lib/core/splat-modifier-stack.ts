/** Modifier-stack folding for the splat material graph. */
import * as THREE from 'three/webgpu';
import {
  bool,
  float,
  getCurrentStack,
  mat3,
  modelViewMatrix,
  modelWorldMatrix,
  vec3,
  vec4,
} from 'three/tsl';
import type { SplatContext, SplatModifier, SplatOutputs } from './splat-modifier';
import type { Vec3Uniform } from './splat-mesh-material';

function asNode<T extends string>(node: unknown): THREE.Node<T> {
  return node as THREE.Node<T>;
}

function toVar<T extends string>(node: THREE.Node<T>): THREE.Node<T> {
  return asNode<T>((node as unknown as THREE.Node<'float'>).toVar());
}

/**
 * Lazily built context fields, one `.toVar()` per TSL scope.
 *
 * three r186 builds every `If` body in a child node cache that falls back to
 * its parent's entries, and a reused temp keeps the var name of the block
 * that first emitted it. A field node shared by sibling branches is
 * therefore assigned in one branch and read, zero-initialized, in the next
 * (from the third sibling on: the first read inlines, the second names a
 * temp). So each scope that reads a field - the fold's own scope, an inline
 * `Fn`, or an `If` body - gets a freshly built node pinned to its own var.
 * `make` must build new nodes on every call, over inputs the caller pinned.
 *
 * Outside any `Fn` (no current stack) there is nowhere to put a var, and
 * the field is the bare node, built once.
 */
class ScopedFields {
  private readonly unscoped = new Map<string, THREE.Node>();
  private readonly scoped = new WeakMap<object, Map<string, THREE.Node>>();

  get<T extends string>(key: string, make: () => THREE.Node<T>): THREE.Node<T> {
    const stack = getCurrentStack();
    let fields = stack === null ? this.unscoped : this.scoped.get(stack);
    if (!fields) {
      fields = new Map();
      this.scoped.set(stack!, fields);
    }
    let node = fields.get(key);
    if (!node) {
      node = stack === null ? make() : toVar(make());
      fields.set(key, node);
    }
    return node as THREE.Node<T>;
  }
}

/**
 * Builds the per-splat {@link SplatContext}, folds the modifier stack
 * over it in order, and returns the graph fragments the renderer applies.
 * `null` fragments mean "untouched": with an empty stack every fragment
 * is null and the caller emits exactly the unhooked graph.
 *
 * Modifiers are called here, at material build time - they are graph
 * builders, not per-frame callbacks, and may be called more than once. Derived context fields
 * (worldCenter, viewCenter, localToView, normal, channels) are built lazily
 * so only the modifiers that read them add their nodes to the graph, and
 * once per TSL scope that reads them (see {@link ScopedFields}).
 *
 * Call it inside the `Fn` whose scope encloses every use of the results,
 * with `index`, `localCenter`, `sourceCenter`, `sourceToLocal` and `color`
 * already pinned with `.toVar()` there: anything shared between a modifier
 * branch and later code must be assigned ahead of the branch. The fold pins
 * the stack's color and, between modifiers, every running field a later
 * modifier can read.
 */
export function foldSplatModifierStack(
  modifierList: readonly SplatModifier[],
  localCameraPosition: Vec3Uniform,
  inputs: {
    index: THREE.Node<'int'>;
    localCenter: THREE.Node<'vec3'>;
    /** Pre-placement pool position; defaults to {@link localCenter}. */
    sourceCenter?: THREE.Node<'vec3'>;
    /** Source-data-frame → mesh-local linear transform; defaults to identity. */
    sourceToLocal?: THREE.Node<'mat3'>;
    color: THREE.Node<'vec4'>;
    /** Builders for the lazy fields; each call must return new nodes. */
    makeNormal: () => THREE.Node<'vec3'>;
    makeChannel: (name: string) => THREE.Node<'float'>;
    /** Optional coordinate-space adapters for compute-time modifier folding. */
    makeWorldCenter?: () => THREE.Node<'vec3'>;
    makeViewCenter?: () => THREE.Node<'vec3'>;
    makeLocalToView?: () => THREE.Node<'mat3'>;
  },
): {
  color: THREE.Node<'vec4'>;
  offset: THREE.Node<'vec3'> | null;
  scaleSquared: THREE.Node<'float'> | null;
  rotation: THREE.Node<'mat3'> | null;
  visible: THREE.Node<'bool'> | null;
  isotropicCovarianceMix: THREE.Node<'float'> | null;
  isotropicVarianceScale: THREE.Node<'float'> | null;
  isotropicScreenRadiusPx: THREE.Node<'float'> | null;
} {
  if (modifierList.length === 0) {
    return {
      color: inputs.color,
      offset: null,
      scaleSquared: null,
      rotation: null,
      visible: null,
      isotropicCovarianceMix: null,
      isotropicVarianceScale: null,
      isotropicScreenRadiusPx: null,
    };
  }

  const cameraLocal = asNode<'vec3'>(localCameraPosition);
  const state = {
    color: inputs.color,
    offset: asNode<'vec3'>(vec3(0.0, 0.0, 0.0)),
    scale: asNode<'float'>(float(1.0)),
    rotation: asNode<'mat3'>(mat3(vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1))),
    visible: asNode<'bool'>(bool(true)),
  };
  const used = { offset: false, scale: false, rotation: false, visible: false };
  let isotropicCovarianceMix: THREE.Node<'float'> | null = null;
  let isotropicVarianceScale: THREE.Node<'float'> | null = null;
  let isotropicScreenRadiusPx: THREE.Node<'float'> | null = null;

  const fields = new ScopedFields();
  const context: SplatContext = {
    index: inputs.index,
    localCenter: inputs.localCenter,
    sourceCenter: inputs.sourceCenter ?? inputs.localCenter,
    sourceToLocal: inputs.sourceToLocal ?? state.rotation,
    cameraLocal,
    baseColor: inputs.color,
    get worldCenter() {
      return fields.get('worldCenter', () =>
        asNode<'vec3'>(
          inputs.makeWorldCenter
            ? inputs.makeWorldCenter()
            : modelWorldMatrix.mul(vec4(inputs.localCenter, 1.0)).xyz,
        ),
      );
    },
    get viewCenter() {
      return fields.get('viewCenter', () =>
        asNode<'vec3'>(
          inputs.makeViewCenter
            ? inputs.makeViewCenter()
            : modelViewMatrix.mul(vec4(inputs.localCenter, 1.0)).xyz,
        ),
      );
    },
    get localToView() {
      return fields.get('localToView', () =>
        inputs.makeLocalToView
          ? inputs.makeLocalToView()
          : asNode<'mat3'>(modelViewMatrix.toMat3()),
      );
    },
    get normal() {
      return fields.get('normal', inputs.makeNormal);
    },
    channel(name: string) {
      return fields.get(`channel:${name}`, () => inputs.makeChannel(name));
    },
    get color() {
      return state.color;
    },
    get offset() {
      return state.offset;
    },
    get scale() {
      return state.scale;
    },
    get rotation() {
      return state.rotation;
    },
    get visible() {
      return state.visible;
    },
  };

  // A running field a later modifier reads inside its branches is shared
  // between those branches, so it is pinned where the fold runs. The final
  // color is pinned as well: the render paths read it in several places.
  const pin = <T extends string>(node: THREE.Node<T>, enabled: boolean): THREE.Node<T> =>
    enabled && getCurrentStack() !== null ? toVar(node) : node;
  for (const [i, modifier] of modifierList.entries()) {
    const followed = i < modifierList.length - 1;
    const outputs: SplatOutputs = modifier(context);
    if (outputs.color) state.color = pin(outputs.color, followed);
    if (outputs.offset) {
      state.offset = pin(outputs.offset, followed);
      used.offset = true;
    }
    if (outputs.scale) {
      state.scale = pin(outputs.scale, followed);
      used.scale = true;
    }
    if (outputs.rotation) {
      state.rotation = pin(outputs.rotation, followed);
      used.rotation = true;
    }
    if (outputs.visible) {
      state.visible = pin(outputs.visible, followed);
      used.visible = true;
    }
    if (outputs.isotropicCovarianceMix !== undefined) {
      isotropicCovarianceMix = outputs.isotropicCovarianceMix;
    }
    if (outputs.isotropicVarianceScale !== undefined) {
      isotropicVarianceScale = outputs.isotropicVarianceScale;
    }
    if (outputs.isotropicScreenRadiusPx !== undefined) {
      isotropicScreenRadiusPx = outputs.isotropicScreenRadiusPx;
    }
  }

  return {
    color: state.color === inputs.color ? state.color : pin(state.color, true),
    offset: used.offset ? state.offset : null,
    scaleSquared: used.scale ? asNode<'float'>(state.scale.mul(state.scale)) : null,
    rotation: used.rotation ? state.rotation : null,
    visible: used.visible ? state.visible : null,
    isotropicCovarianceMix,
    isotropicVarianceScale,
    isotropicScreenRadiusPx,
  };
}
