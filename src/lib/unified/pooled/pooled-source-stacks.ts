/**
 * Per-source modifier stacks for the pooled draw.
 *
 * `UnifiedSplatMesh` gathers each source through that source's own modifier
 * stack, in the source's local frame, so an SDF shape authored in mesh-local
 * coordinates, a main-splat tint, or a marker-only light lands exactly where
 * it does on a standalone mesh. The pooled draw has one vertex program for
 * every source, so it folds each distinct stack once and selects the result
 * by the instance's source id. Inside a stack the context is remapped to that
 * source's frame:
 *
 * - `localCenter` / `sourceCenter`: the pool-frame center (the source's local
 *   position; sources are never re-based in the pool),
 * - `worldCenter`, `viewCenter`: the placed position, as drawn,
 * - `cameraLocal`: the camera in the source frame (a per-source table row),
 * - `normal`: the drawn normal brought back to the source frame,
 * - `localToView`: view rotation composed with the source's linear placement.
 *
 * Outputs come back to the drawn (world) frame: offsets through the source's
 * linear placement, rotations by conjugation. Sources sharing an identical
 * stack share one fold.
 *
 * `ctx.channel(name)` reads the source's own channel (`SplatMesh.defineChannel`).
 * A tenant's channel texture spans the whole shared pool and is indexed by
 * pool row, exactly as the draw's instances are, so the stack reads it
 * unchanged. The material sees each source's channels under a per-source key
 * ({@link pooledChannelKey}); a group of several sources sums their reads
 * under float masks of the instance's source id.
 *
 * Each group runs in a real branch (`If` on the instance's source id), so a
 * splat pays for its own source's effects only, however many markers carry
 * stacks. Two TSL rules keep that correct:
 *
 * - Every input the folds share (incoming color, centers, camera, normal,
 *   placement) is materialized into a variable before the first branch.
 *   Three emits a node where it is first referenced; a shared node first
 *   emitted inside one group's branch would be read uninitialized by every
 *   other group (the symptom: every source but the last group vanished).
 * - The branches write one packed `mat4` result, and the returned `visible`
 *   always reads it, so the material emits the whole block at the top of its
 *   vertex stage before any of its own branches.
 */
import type * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  abs,
  bool,
  float,
  int,
  mat3,
  mat4,
  min,
  modelWorldMatrix,
  vec3,
  vec4,
} from 'three/tsl';
import { asNode } from '../../core/splat-material-types';
import type { SplatContext, SplatModifier, SplatOutputs } from '../../core/splat-modifier';
import { ROW_CAMERA_LOCAL, ROW_INVERSE_LINEAR, SOURCE_DATA_ROWS } from './pooled-source-tables';

type Node<T extends string> = THREE.Node<T>;

/** One group of sources drawing through the same stack. */
export interface PooledStackGroup {
  ids: readonly number[];
  modifiers: readonly SplatModifier[];
  /** Channel names each source in {@link ids} defines, in the same order. */
  channels: readonly ReadonlySet<string>[];
}

/** The material's channel key for source `id`'s channel `name`. */
export function pooledChannelKey(id: number, name: string): string {
  return `source${id}:${name}`;
}

/** Groups sources by stack contents (element-wise identity, order-sensitive). */
export function groupSourceStacks(
  sources: readonly {
    id: number;
    modifiers: readonly SplatModifier[];
    channels?: Iterable<string>;
  }[],
): PooledStackGroup[] {
  const groups: {
    ids: number[];
    modifiers: readonly SplatModifier[];
    channels: ReadonlySet<string>[];
  }[] = [];
  for (const { id, modifiers, channels } of sources) {
    if (modifiers.length === 0) continue;
    const names = new Set(channels ?? []);
    const match = groups.find(
      (group) =>
        group.modifiers.length === modifiers.length &&
        group.modifiers.every((modifier, i) => modifier === modifiers[i]),
    );
    if (match) {
      match.ids.push(id);
      match.channels.push(names);
    } else groups.push({ ids: [id], modifiers, channels: [names] });
  }
  return groups;
}

/**
 * Builds the one modifier that evaluates every group's stack in its sources'
 * frames. `null` when no source carries a stack.
 */
export function createSourceStacksModifier(options: {
  groups: readonly PooledStackGroup[];
  sourceId: Node<'int'>;
  columns: { element(index: Node<'int'> | number): unknown };
  data: { element(index: Node<'int'> | number): unknown };
}): SplatModifier | null {
  const { groups, sourceId, columns, data } = options;
  if (groups.length === 0) return null;
  return (ctx: SplatContext): SplatOutputs => {
    // Shared inputs, each declared before the branches (see module notes).
    const shared: { toStack(): unknown }[] = [];
    const materialize = <T extends string>(node: unknown): Node<T> => {
      const variable = (node as { toVar(): unknown }).toVar();
      shared.push(variable as { toStack(): unknown });
      return asNode<T>(variable);
    };
    const columnBase = sourceId.mul(int(4));
    const column = (c: number) => asNode<'vec4'>(columns.element(columnBase.add(int(c))));
    const dataBase = sourceId.mul(int(SOURCE_DATA_ROWS));
    const dataRow = (r: number) => asNode<'vec4'>(data.element(dataBase.add(int(r))));
    const frame: SourceFrame = {
      color: materialize<'vec4'>(vec4(ctx.color)),
      sourceCenter: materialize<'vec3'>(vec3(ctx.sourceCenter)),
      cameraLocal: materialize<'vec3'>(dataRow(ROW_CAMERA_LOCAL).xyz),
      linear: materialize<'mat3'>(mat3(column(0).xyz, column(1).xyz, column(2).xyz)),
      inverseLinear: materialize<'mat3'>(
        mat3(
          dataRow(ROW_INVERSE_LINEAR).xyz,
          dataRow(ROW_INVERSE_LINEAR + 1).xyz,
          dataRow(ROW_INVERSE_LINEAR + 2).xyz,
        ),
      ),
      lazy: new Map(),
      materialize,
      ctx,
    };

    const folds = groups.map((group) => ({
      gate: groupGate(sourceId, group.ids),
      out: foldInSourceFrame(group, frame, sourceId),
      group,
    }));
    const needs = {
      offset: folds.some(({ out }) => out.offset !== null),
      scale: folds.some(({ out }) => out.scale !== null),
      rotation: folds.some(({ out }) => out.rotation !== null),
      isotropicCovarianceMix: folds.some(({ out }) => out.isotropicCovarianceMix !== undefined),
      isotropicVarianceScale: folds.some(({ out }) => out.isotropicVarianceScale !== undefined),
      isotropicScreenRadiusPx: folds.some(({ out }) => out.isotropicScreenRadiusPx !== undefined),
    };
    // Rotation does not fit the packed result. The groups that rotate fold a
    // second time (fresh nodes: the first fold's live in the other branches),
    // only read inside the material's own visible-splat branch.
    const rotationFolds = needs.rotation
      ? folds
          .filter(({ out }) => out.rotation !== null)
          .map(({ gate, group }) => ({ gate, out: foldInSourceFrame(group, frame, sourceId) }))
      : [];

    // col0 color; col1 drawn offset + scale; col2 isotropic mix, variance
    // scale, screen radius, visibility.
    const defaults = asNode<'mat4'>(
      mat4(
        frame.color,
        vec4(0, 0, 0, 1),
        vec4(0, DEFAULT_ISOTROPIC_VARIANCE_SCALE, 0, 1),
        vec4(0, 0, 0, 0),
      ),
    );
    const packed = asNode<'mat4'>(
      Fn(() => {
        for (const variable of shared) variable.toStack();
        const result = defaults.toVar();
        for (const { gate, out } of folds) {
          If(gate, () => {
            const offset = out.offset ? frame.linear.mul(out.offset) : vec3(0, 0, 0);
            result.assign(
              mat4(
                out.color,
                vec4(offset, out.scale ?? float(1)),
                vec4(
                  out.isotropicCovarianceMix ?? float(0),
                  out.isotropicVarianceScale ?? float(DEFAULT_ISOTROPIC_VARIANCE_SCALE),
                  out.isotropicScreenRadiusPx ?? float(0),
                  out.visible ? out.visible.select(float(1), float(0)) : float(1),
                ),
                vec4(0, 0, 0, 0),
              ),
            );
          });
        }
        return result;
      })(),
    );
    const packedColumn = (c: number) =>
      asNode<'vec4'>((packed as unknown as { element(i: unknown): unknown }).element(int(c)));
    const color = packedColumn(0);
    const transform = packedColumn(1);
    const isotropic = packedColumn(2);

    const outputs: SplatOutputs = {
      color,
      // Always present: it is what pins the packed block to the vertex top.
      visible: asNode<'bool'>(ctx.visible.and(isotropic.w.greaterThan(0.5))),
    };
    if (needs.offset) outputs.offset = asNode<'vec3'>(ctx.offset.add(transform.xyz));
    if (needs.scale) outputs.scale = asNode<'float'>(ctx.scale.mul(transform.w));
    if (needs.isotropicCovarianceMix) outputs.isotropicCovarianceMix = asNode<'float'>(isotropic.x);
    if (needs.isotropicVarianceScale) outputs.isotropicVarianceScale = asNode<'float'>(isotropic.y);
    if (needs.isotropicScreenRadiusPx)
      outputs.isotropicScreenRadiusPx = asNode<'float'>(isotropic.z);
    if (needs.rotation) {
      const identity = mat3(vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1));
      const rotation = asNode<'mat3'>(
        Fn(() => {
          const result = asNode<'mat3'>(identity).toVar();
          for (const { gate, out } of rotationFolds) {
            // A source-frame rotation R becomes L·R·L⁻¹ in the drawn frame.
            If(gate, () => {
              result.assign(
                frame.linear.mul(out.rotation as Node<'mat3'>).mul(frame.inverseLinear),
              );
            });
          }
          return result;
        })(),
      );
      outputs.rotation = asNode<'mat3'>(rotation.mul(ctx.rotation));
    }
    return outputs;
  };
}

/** Matches the material's default when no modifier sets it. */
const DEFAULT_ISOTROPIC_VARIANCE_SCALE = 0.35 * 0.35;

interface SourceFrame {
  color: Node<'vec4'>;
  sourceCenter: Node<'vec3'>;
  cameraLocal: Node<'vec3'>;
  linear: Node<'mat3'>;
  inverseLinear: Node<'mat3'>;
  /** Lazily materialized derived inputs, shared by every group. */
  lazy: Map<string, unknown>;
  materialize: <T extends string>(node: unknown) => Node<T>;
  ctx: SplatContext;
}

/**
 * A group's read of channel `name`: its one source's texture, or for several
 * sources the sum of each one's read under its id mask (arithmetic, not a
 * `select`, which drops splats inside a modifier; the instance belongs to
 * exactly one of them).
 */
function groupChannel(
  group: PooledStackGroup,
  name: string,
  ctx: SplatContext,
  sourceId: Node<'int'>,
): Node<'float'> {
  const owners = group.ids.filter((_, i) => group.channels[i]?.has(name));
  if (owners.length !== group.ids.length) {
    throw new Error(
      `PooledUnifiedSplatMesh: a source modifier reads channel "${name}", which ` +
        `${owners.length === 0 ? 'its source does not define' : 'not every source sharing the stack defines'}. ` +
        `Call defineChannel("${name}") on the source before assigning the modifier.`,
    );
  }
  if (owners.length === 1) return ctx.channel(pooledChannelKey(owners[0] as number, name));
  let sum: Node<'float'> = asNode<'float'>(float(0));
  for (const id of owners) {
    // 1 for this id, 0 for any other (ids are integers).
    const mask = asNode<'float'>(float(1).sub(min(abs(float(sourceId.sub(int(id)))), float(1))));
    sum = asNode<'float'>(sum.add(ctx.channel(pooledChannelKey(id, name)).mul(mask)));
  }
  return sum;
}

function groupGate(sourceId: Node<'int'>, ids: readonly number[]): Node<'bool'> {
  let gate = asNode<'bool'>(sourceId.equal(int(ids[0] as number)));
  for (const id of ids.slice(1)) gate = asNode<'bool'>(gate.or(sourceId.equal(int(id))));
  return gate;
}

function lazyInput<T extends string>(
  frame: SourceFrame,
  key: string,
  build: () => unknown,
): Node<T> {
  let node = frame.lazy.get(key) as Node<T> | undefined;
  if (!node) {
    node = frame.materialize<T>(build());
    frame.lazy.set(key, node);
  }
  return node;
}

interface FoldResult {
  color: Node<'vec4'>;
  offset: Node<'vec3'> | null;
  scale: Node<'float'> | null;
  rotation: Node<'mat3'> | null;
  visible: Node<'bool'> | null;
  isotropicCovarianceMix?: Node<'float'>;
  isotropicVarianceScale?: Node<'float'>;
  isotropicScreenRadiusPx?: Node<'float'>;
}

/**
 * Folds one stack over a source-frame view of the context. Mirrors
 * `foldSplatModifierStack`'s running-state semantics, starting from an
 * untouched transform (the per-source block runs first in the pooled stack).
 */
function foldInSourceFrame(
  group: PooledStackGroup,
  frame: SourceFrame,
  sourceId: Node<'int'>,
): FoldResult {
  const { ctx } = frame;
  const { modifiers } = group;
  const identity = asNode<'mat3'>(mat3(vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)));
  const state = {
    color: frame.color,
    offset: asNode<'vec3'>(vec3(0, 0, 0)),
    scale: asNode<'float'>(float(1)),
    rotation: identity,
    visible: asNode<'bool'>(bool(true)),
  };
  const used = { offset: false, scale: false, rotation: false, visible: false };
  const result: FoldResult = {
    color: frame.color,
    offset: null,
    scale: null,
    rotation: null,
    visible: null,
  };
  const sourceCtx: SplatContext = {
    index: ctx.index,
    localCenter: frame.sourceCenter,
    sourceCenter: frame.sourceCenter,
    sourceToLocal: identity,
    cameraLocal: frame.cameraLocal,
    baseColor: frame.color,
    get worldCenter() {
      return lazyInput<'vec3'>(frame, 'worldCenter', () => vec3(ctx.worldCenter));
    },
    get viewCenter() {
      return lazyInput<'vec3'>(frame, 'viewCenter', () => vec3(ctx.viewCenter));
    },
    get cameraWorld() {
      // World space does not depend on the source's placement.
      return lazyInput<'vec3'>(frame, 'cameraWorld', () =>
        vec3(ctx.cameraWorld ?? modelWorldMatrix.mul(vec4(ctx.cameraLocal, 1.0)).xyz),
      );
    },
    get localToView() {
      // Drawn-frame (world) → view, after the source's linear placement.
      return lazyInput<'mat3'>(frame, 'localToView', () =>
        asNode<'mat3'>(ctx.localToView ?? identity).mul(frame.linear),
      );
    },
    get normal() {
      // A covector: bring it back with the placement's transpose.
      return lazyInput<'vec3'>(frame, 'normal', () =>
        frame.linear.transpose().mul(ctx.normal).normalize(),
      );
    },
    channel: (name: string) => groupChannel(group, name, ctx, sourceId),
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
  for (const modifier of modifiers) {
    const out = modifier(sourceCtx);
    if (out.color) state.color = out.color;
    if (out.offset) {
      state.offset = out.offset;
      used.offset = true;
    }
    if (out.scale) {
      state.scale = out.scale;
      used.scale = true;
    }
    if (out.rotation) {
      state.rotation = out.rotation;
      used.rotation = true;
    }
    if (out.visible) {
      state.visible = out.visible;
      used.visible = true;
    }
    if (out.isotropicCovarianceMix !== undefined) {
      result.isotropicCovarianceMix = out.isotropicCovarianceMix;
    }
    if (out.isotropicVarianceScale !== undefined) {
      result.isotropicVarianceScale = out.isotropicVarianceScale;
    }
    if (out.isotropicScreenRadiusPx !== undefined) {
      result.isotropicScreenRadiusPx = out.isotropicScreenRadiusPx;
    }
  }
  result.color = state.color;
  if (used.offset) result.offset = state.offset;
  if (used.scale) result.scale = state.scale;
  if (used.rotation) result.rotation = state.rotation;
  if (used.visible) result.visible = state.visible;
  return result;
}
