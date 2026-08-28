/** Modifier-stack folding for the splat material graph. */
import * as THREE from 'three/webgpu';
import { bool, float, mat3, modelViewMatrix, modelWorldMatrix, vec3, vec4 } from 'three/tsl';
import type { SplatContext, SplatModifier, SplatOutputs } from './splat-modifier';
import type { Vec3Uniform } from './splat-mesh-material';

function asNode<T extends string>(node: unknown): THREE.Node<T> {
  return node as THREE.Node<T>;
}

/**
 * Builds the per-splat {@link SplatContext}, folds the modifier stack
 * over it in order, and returns the graph fragments the renderer applies.
 * `null` fragments mean "untouched": with an empty stack every fragment
 * is null and the caller emits exactly the unhooked graph.
 *
 * Modifiers are called once, here, at material build time - they are
 * graph builders, not per-frame callbacks. Derived context fields
 * (worldCenter, viewCenter, normal) are memoized lazily so only the
 * modifiers that read them add their nodes to the graph.
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
    makeNormal: () => THREE.Node<'vec3'>;
    makeChannel: (name: string) => THREE.Node<'float'>;
    /** Optional coordinate-space adapters for compute-time modifier folding. */
    makeWorldCenter?: () => THREE.Node<'vec3'>;
    makeViewCenter?: () => THREE.Node<'vec3'>;
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

  let worldCenter: THREE.Node<'vec3'> | null = null;
  let viewCenter: THREE.Node<'vec3'> | null = null;
  let normal: THREE.Node<'vec3'> | null = null;
  const channelNodes = new Map<string, THREE.Node<'float'>>();
  const context: SplatContext = {
    index: inputs.index,
    localCenter: inputs.localCenter,
    sourceCenter: inputs.sourceCenter ?? inputs.localCenter,
    sourceToLocal: inputs.sourceToLocal ?? state.rotation,
    cameraLocal,
    baseColor: inputs.color,
    get worldCenter() {
      return (worldCenter ??= asNode<'vec3'>(
        inputs.makeWorldCenter
          ? inputs.makeWorldCenter()
          : modelWorldMatrix.mul(vec4(inputs.localCenter, 1.0)).xyz,
      ));
    },
    get viewCenter() {
      return (viewCenter ??= asNode<'vec3'>(
        inputs.makeViewCenter
          ? inputs.makeViewCenter()
          : modelViewMatrix.mul(vec4(inputs.localCenter, 1.0)).xyz,
      ));
    },
    get normal() {
      return (normal ??= inputs.makeNormal());
    },
    channel(name: string) {
      let node = channelNodes.get(name);
      if (!node) {
        node = inputs.makeChannel(name);
        channelNodes.set(name, node);
      }
      return node;
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

  for (const modifier of modifierList) {
    const outputs: SplatOutputs = modifier(context);
    if (outputs.color) state.color = outputs.color;
    if (outputs.offset) {
      state.offset = outputs.offset;
      used.offset = true;
    }
    if (outputs.scale) {
      state.scale = outputs.scale;
      used.scale = true;
    }
    if (outputs.rotation) {
      state.rotation = outputs.rotation;
      used.rotation = true;
    }
    if (outputs.visible) {
      state.visible = outputs.visible;
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
    color: state.color,
    offset: used.offset ? state.offset : null,
    scaleSquared: used.scale ? asNode<'float'>(state.scale.mul(state.scale)) : null,
    rotation: used.rotation ? state.rotation : null,
    visible: used.visible ? state.visible : null,
    isotropicCovarianceMix,
    isotropicVarianceScale,
    isotropicScreenRadiusPx,
  };
}
