import type { Node } from 'three/webgpu';

/**
 * Per-splat context a {@link SplatModifier} reads, evaluated in the vertex
 * stage. All fields are TSL nodes; see `docs/guide/effects-and-modifiers.md`.
 */
export interface SplatContext {
  // --- read-only inputs ---
  /** Pool splat index (stable identity for per-splat channels). */
  readonly index: Node<'int'>;
  /**
   * Splat center in mesh-local space (pre-displacement).
   *
   * Inside a `MergedSplatMesh` this is the splat's **placed** position
   * (`sourceMatrix · poolCenter`) - the placement is applied before the stack
   * runs, so effects stay anchored to the scene rather than travelling with a
   * moved source. Use {@link sourceCenter} for the pre-placement position.
   */
  readonly localCenter: Node<'vec3'>;
  /**
   * The splat's position in its own source's data frame. Identical to
   * {@link localCenter} on a plain mesh; inside a `MergedSplatMesh` it is the
   * **pre-placement** position, for effects that should travel *with* a moved
   * source instead of staying put in the scene.
   */
  readonly sourceCenter: Node<'vec3'>;
  /**
   * Linear transform from the source data frame to mesh-local space. This is
   * identity on a plain mesh; inside a {@link MergedSplatMesh} it is the linear part
   * of the source placement. Apply it to source-frame displacement vectors.
   * To express a source-frame rotation `R` as a mesh-local `rotation` output,
   * conjugate it: `sourceToLocal · R · sourceToLocal.inverse()`.
   */
  readonly sourceToLocal: Node<'mat3'>;
  /** `modelMatrix · localCenter` (world space). */
  readonly worldCenter: Node<'vec3'>;
  /** `modelViewMatrix · localCenter` (view space). */
  readonly viewCenter: Node<'vec3'>;
  /** Linear mesh-local → view transform, supplied lazily by the render path. */
  readonly localToView?: Node<'mat3'>;
  /** Camera position in mesh-local space. */
  readonly cameraLocal: Node<'vec3'>;
  /** Color + opacity after SH - the stack's input color. */
  readonly baseColor: Node<'vec4'>;
  /** Approximate surface normal (least-variance axis of the splat's
   * covariance), mesh-local, oriented toward the camera. Built lazily -
   * only modifiers that read it pay for the eigen approximation, once per
   * TSL scope (`Fn` body or `If` branch) that reads it. */
  readonly normal: Node<'vec3'>;
  /**
   * Reads a per-splat channel by name (see `SplatMesh.defineChannel` /
   * `writeChannel`). Float channels return their stored value; byte channels
   * return the value normalized to `[0, 1]`. Reading an undefined channel is
   * a build-time error (a missing mask is a bug, not a silent zero). The read
   * is memoized per name within a TSL scope, so referencing the same channel
   * twice in one scope costs one texture fetch.
   */
  channel(name: string): Node<'float'>;

  // --- running transform (threaded through the fold) ---
  /** rgb + opacity. */
  readonly color: Node<'vec4'>;
  /** Local-space center displacement. */
  readonly offset: Node<'vec3'>;
  /** Uniform scale multiplier. */
  readonly scale: Node<'float'>;
  /** Mesh-local linear orientation transform (including view-space conjugation). */
  readonly rotation: Node<'mat3'>;
  /** Visibility. */
  readonly visible: Node<'bool'>;
}

/** The transform fields a modifier changes; omitted fields pass through. */
export interface SplatOutputs {
  color?: Node<'vec4'>;
  offset?: Node<'vec3'>;
  scale?: Node<'float'>;
  rotation?: Node<'mat3'>;
  visible?: Node<'bool'>;
  /** Blend `Σ` toward σ²·I (0 = keep, 1 = full collapse). Screen λ equalized when > 0. */
  isotropicCovarianceMix?: Node<'float'>;
  /** Multiplier on max(n·Σ·n, ε); defaults to 0.35² when omitted. */
  isotropicVarianceScale?: Node<'float'>;
  /**
   * Optional isotropic screen-space σ radius in pixels. When set (> 0), caps
   * projected λ for zoom-stable dots. Omit for Spark-style world-space points
   * (size grows mildly on zoom-in).
   */
  isotropicScreenRadiusPx?: Node<'float'>;
}

/**
 * A splat effect hook. Reads the per-splat {@link SplatContext} and returns
 * the transform fields it wants to change. Pure TSL, so it compiles to WGSL
 * and GLSL and runs on both backends. Modifiers compose by folding over
 * `SplatMesh.modifiers` in order - each sees the running result of the ones
 * before it. Adding/removing/reordering modifiers recompiles the material;
 * changing a modifier's own uniforms or storage buffers never does.
 *
 * Constraints (see `docs/guide/effects-and-modifiers.md`): covariance is pre-baked,
 * so `scale` is uniform-only. Express view-space rotations in local coordinates
 * with `localToView.inverse() · Rview · localToView`; under nonuniform scale
 * this conjugation need not itself be orthogonal. Displaced splats
 * keep their pre-displacement depth-sort order.
 */
export type SplatModifier = (context: SplatContext) => SplatOutputs;

/** Options for {@link ModifierSlots}. */
export interface ModifierSlotsOptions {
  /**
   * Called after a {@link ModifierSlots.set} changes **which** slots are
   * occupied (a slot going from empty to filled, or back). Replacing an
   * occupant with a different function is a structural change for the
   * material but leaves occupancy alone, so it does not call this.
   *
   * Hosts driving a unified draw use it to call
   * `UnifiedSplatMesh.invalidateSource`, since whether a source's gathered
   * output can be cached depends on which slots are occupied.
   */
  onOccupancyChange?: (slots: ModifierSlots) => void;
}

/** Anything with a `modifiers` list - {@link ModifierSlots.apply} target. */
export interface ModifierStackTarget {
  modifiers: readonly SplatModifier[];
}

/**
 * Named, ordered modifier slots for hosts that stack several effects (reveal,
 * SDF, lighting, fog, opacity, …) on one mesh. The slot **order is fixed at
 * construction** - it defines the fold order of the compiled stack - while
 * each slot's occupant can change at runtime.
 *
 * The rebuild vs uniform-update contract (see
 * `docs/guide/effects-and-modifiers.md`, "Multi-slot stacks"):
 *
 *  - An **empty slot costs nothing**: it is omitted from the compacted list
 *    entirely, never compiled as a passthrough. All slots empty ⇒ the mesh
 *    gets an empty list ⇒ the unhooked graph (and the unified renderer's
 *    zero-modifier gather fast path stays eligible - except for a `MergedSplatMesh`,
 *    which `UnifiedSplatMesh` does not accept as a source at all).
 *  - {@link apply} hands the mesh a **compacted array whose reference is
 *    stable** while the occupancy is unchanged, so re-applying after
 *    uniform-only changes is a guaranteed no-op on the mesh's identity diff -
 *    no material rebuild, no `graphRevision` bump.
 *  - Filling, clearing, or replacing a slot with a *different* function is a
 *    structural change: the next {@link apply} rebuilds the material once.
 *    Setting a slot to the function it already holds is a no-op.
 */
export class ModifierSlots {
  private readonly order: readonly string[];
  private readonly occupants = new Map<string, SplatModifier>();
  /** Compacted stack in slot order; rebuilt only on structural change so the
   * array reference itself is stable across uniform-only frames. */
  private compacted: readonly SplatModifier[] = [];
  /** Occupied slot names in slot order; replaced only when occupancy changes. */
  private occupied: readonly string[] = [];
  private readonly onOccupancyChange: ((slots: ModifierSlots) => void) | undefined;

  /**
   * @param order Slot names, in fold order. Must be non-empty and unique.
   * @param options See {@link ModifierSlotsOptions}.
   */
  constructor(order: readonly string[], options: ModifierSlotsOptions = {}) {
    if (order.length === 0) {
      throw new Error('ModifierSlots: the slot order must name at least one slot.');
    }
    if (new Set(order).size !== order.length) {
      throw new Error(`ModifierSlots: duplicate slot name in order [${order.join(', ')}].`);
    }
    this.order = [...order];
    this.onOccupancyChange = options.onOccupancyChange;
  }

  /** The declared slot names, in fold order. */
  get slotNames(): readonly string[] {
    return this.order;
  }

  /**
   * Fills or clears a slot (`null` clears). Returns `true` when the change is
   * structural - i.e. the next {@link apply} will trigger a material rebuild -
   * and `false` when it was a no-op (same function, or clearing an already
   * empty slot). Unknown slot names throw: a typo must not silently drop an
   * effect.
   */
  set(name: string, modifier: SplatModifier | null): boolean {
    if (!this.order.includes(name)) {
      throw new Error(
        `ModifierSlots: unknown slot "${name}" (declared: ${this.order.join(', ')}).`,
      );
    }
    const current = this.occupants.get(name) ?? null;
    if (current === modifier) return false;
    if (modifier === null) this.occupants.delete(name);
    else this.occupants.set(name, modifier);
    const next: SplatModifier[] = [];
    for (const slot of this.order) {
      const occupant = this.occupants.get(slot);
      if (occupant) next.push(occupant);
    }
    this.compacted = next;
    // Filling or emptying a slot changes occupancy; swapping an occupant does not.
    if ((current === null) !== (modifier === null)) {
      this.occupied = this.order.filter((slot) => this.occupants.has(slot));
      this.onOccupancyChange?.(this);
    }
    return true;
  }

  /** The slot's current occupant, or `null` when empty. */
  get(name: string): SplatModifier | null {
    return this.occupants.get(name) ?? null;
  }

  /** Sugar for `set(name, null)`; returns whether the slot was occupied. */
  clear(name: string): boolean {
    return this.set(name, null);
  }

  /**
   * The compacted stack: occupied slots only, in slot order. The reference is
   * stable while occupancy is unchanged, so it is safe to assign every frame.
   */
  get modifiers(): readonly SplatModifier[] {
    return this.compacted;
  }

  /**
   * Names of the occupied slots, in slot order. The reference is stable while
   * occupancy is unchanged.
   */
  get occupiedSlots(): readonly string[] {
    return this.occupied;
  }

  /**
   * The compacted stack without the named slots, in slot order. For a host
   * that provides some effects through the draw owner instead - for example
   * leaving out a per-mesh opacity modifier because the unified mesh's
   * `setSourceOpacity` covers it. Returns a new array; its elements are the
   * occupants themselves, so it compares element-wise equal while the
   * occupants are unchanged. Unknown names throw, as in {@link set}.
   */
  modifiersExcluding(names: readonly string[]): readonly SplatModifier[] {
    for (const name of names) {
      if (!this.order.includes(name)) {
        throw new Error(
          `ModifierSlots: unknown slot "${name}" (declared: ${this.order.join(', ')}).`,
        );
      }
    }
    const result: SplatModifier[] = [];
    for (const slot of this.order) {
      if (names.includes(slot)) continue;
      const occupant = this.occupants.get(slot);
      if (occupant) result.push(occupant);
    }
    return result;
  }

  /**
   * Assigns the compacted stack to `target.modifiers` (a `SplatMesh` or
   * anything with the same setter). The mesh's identity diff makes this free
   * when nothing structural changed, so calling it after every `set` - or
   * even every frame - is fine.
   */
  apply(target: ModifierStackTarget): void {
    target.modifiers = this.compacted;
  }
}
