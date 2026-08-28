import * as THREE from 'three/webgpu';
import { SplatMesh, type SplatData, type SplatModifier } from '../lib/core';
import { StreamedSplatMesh } from '../lib/streaming';
import {
  createSelectionVolume,
  partitionSplatData,
  type SelectionVolumeKind,
  type SelectionVolumeOptions,
  type SplatPartition,
} from '../lib/selection';
import { sdfEffects } from '../lib/effects';
import { TransformGizmo, type GizmoMode } from '@voluma/three-transform-gizmo';
import { createSeparationState } from './separation-state';
import { clampVolumeScale, meshLocalSdfShape, unitVolumeDimensions } from './selection-transform';
import { createSelectionWave, type SelectionWave } from './selection-wave';

/**
 * Interactive splat separation demo (`?separate=1`).
 *
 * A placeable box/sphere/cylinder selection volume over the loaded static
 * scene, with a live in-shader highlight of the covered splats (the SDF tint
 * modifier doubles as the selection preview). "Separate" partitions the scene:
 * the selection becomes its own `SplatMesh`, posed independently of the rest -
 * the "animate" toggle bobs and spins it to prove the independence. "Restore"
 * rebuilds the original single mesh from the retained source data.
 *
 * The preview modifier is published through the host's `ModifierSlots` stack
 * rather than assigned to `mesh.modifiers`, so switching effects in the picker
 * neither drops the highlight nor is dropped by it.
 *
 * The volume and its GPU preview work for every scene. Cutting remains limited
 * to static scenes: a streamed mesh's resident set is not the ground truth, so
 * partitioning it would silently lose splats that were not resident.
 */
export interface SeparateTool {
  /**
   * Rebinds the tool to the scene now on screen (called from `applyScene`).
   * `origin` distinguishes the tool's own separate/restore swaps from a real
   * scene change - see `separation-state.ts` for why that matters.
   */
  onScene(
    mesh: SplatMesh,
    data: SplatData | null,
    origin: 'self' | 'external',
    selectionWorldMatrix?: THREE.Matrix4,
  ): void;
  /** Per-frame: animates the separated source; the host performs its shared sort. */
  update(elapsedSeconds: number): void;
  /** Re-evaluates button availability after a host-side effect change. */
  refresh(): void;
  /** Whether a globally sorted separated pair is currently mounted. */
  readonly hasSeparatedParts: boolean;
  /**
   * Enables and shows (or disables and hides) the placement gizmo. The host
   * turns it off while a WebXR session presents: the gizmo is a pointer-driven
   * screen-space overlay with no meaning in a headset.
   */
  setInteractive(enabled: boolean): void;
  /**
   * The object whose position, orientation and per-axis scale *are* the
   * selection volume's world placement, over a unit shape. Exposed so the
   * placement can be driven without pointer input - move it, then call
   * {@link syncVolume}.
   */
  readonly volumeAnchor: THREE.Object3D;
  /** Re-reads {@link volumeAnchor} into the tint preview. */
  syncVolume(): void;
  /**
   * Releases the gizmo, the panel, and every separated part. The demo page
   * never unmounts, so nothing calls this today - it exists so the tool is
   * correct for an embedder (and so tests can tear one down).
   */
  dispose(): void;
}

/** What the tool needs from the host page. */
export interface SeparateToolContext {
  readonly scene: THREE.Scene;
  /**
   * Camera the gizmo screen-scales against and raycasts its handles with. Must
   * be the camera the host renders `scene` with, or the handles will not be
   * where they look like they are.
   */
  readonly camera: THREE.Camera;
  /** Canvas the gizmo binds its own pointer listeners to. */
  readonly domElement: HTMLElement;
  /**
   * A gizmo drag started (`true`) or ended (`false`).
   *
   * Dispatched synchronously from the gizmo's own `pointerdown`/`pointerup`,
   * i.e. inside the same event dispatch as the host's canvas listeners. The
   * gizmo never calls `stopPropagation`, so a host that drives its camera from
   * raw pointer events has already armed a drag for this very press - it must
   * cancel it here. No `pointermove` can have arrived in between, so cancelling
   * costs exactly zero camera motion.
   */
  onGizmoDragChange(dragging: boolean): void;
  /**
   * Publishes (or clears, on `null`) the selection-preview modifier. The host
   * owns the modifier stack - it routes this into its `ModifierSlots` so the
   * preview and the picked effect compose instead of overwriting each other.
   */
  setPreviewModifier(modifier: SplatModifier | null): void;
  /** Paint masks are range-local and cannot survive the source merge. */
  canSeparate(): boolean;
  /**
   * Replaces the on-screen mesh with the outside half of a partition and
   * returns the freshly built source handle for the inside half. The host owns
   * the shared sorter so both halves continue to depth-interleave correctly.
   */
  commit(partition: SplatPartition): Promise<SeparatedPart>;
  /** Puts the given (original) data back on screen as one mesh. */
  restore(data: SplatData): Promise<void>;
}

/** One independently transformable source in the host's globally sorted scene. */
export interface SeparatedPart {
  /** Initial source placement, used as the rest pose for the animation. */
  readonly transform: THREE.Matrix4;
  /** Applies a new source placement without rebuilding or re-uploading splats. */
  setTransform(transform: THREE.Matrix4): void;
}

/** Highlight color for splats covered by the volume. */
const PREVIEW_COLOR: readonly [number, number, number] = [1.0, 0.55, 0.1];

/** Scratch objects for the per-frame animation, reused like the render loop's. */
const BOB_AXIS = new THREE.Vector3(0, 1, 0);
const SPIN_AXIS = new THREE.Vector3(0, 1, 0);

export function createSeparateTool(context: SeparateToolContext): SeparateTool {
  const state = createSeparationState();
  let mesh: SplatMesh | null = null;
  let worldBounds = new THREE.Box3();
  let kind: SelectionVolumeKind = 'box';
  /** Frame the CPU selection volume tests in: the *data* frame of the active
   * `SplatData`, which is unplaced. Not the mesh's matrix once a scene is
   * separated - see `syncPreview` for the GPU-side counterpart. */
  const selectionWorldMatrix = new THREE.Matrix4();
  let busy = false;

  interface Part {
    readonly source: SeparatedPart;
    readonly basePosition: THREE.Vector3;
    readonly baseQuaternion: THREE.Quaternion;
    readonly baseScale: THREE.Vector3;
    readonly phase: number;
    /**
     * Bob amplitude, captured from the selection volume at commit time. The
     * volume is free to move - or to be reset by a whole new scene - while a
     * separated part is still animating, so reading it live would resize an
     * already-separated part's motion.
     */
    readonly bobAmplitude: number;
    readonly wave: SelectionWave;
  }
  const parts: Part[] = [];
  type AnimationMode = 'off' | 'bob' | 'wave';
  let animationMode: AnimationMode = 'bob';
  const animatedTransform = new THREE.Matrix4();
  const animatedPosition = new THREE.Vector3();
  const animatedQuaternion = new THREE.Quaternion();

  // --- Preview: SDF tint modifier + wireframe + placement gizmo -------------
  const sdf = sdfEffects([], { maxShapes: 1 });
  const wireMaterial = new THREE.LineBasicMaterial({ color: 0xffa500 });

  /**
   * The selection volume itself. Its position, orientation and per-axis scale
   * *are* the placement: children are authored as the *unit* shape, the CPU
   * volume takes this matrix as `transform` with unit dimensions, and the
   * wireframe is a child - so the three can never drift apart.
   *
   * It sits at the scene root because the transform gizmo writes its own world
   * transform every frame, and a transformed ancestor would misplace it.
   */
  const volumeAnchor = new THREE.Object3D();
  volumeAnchor.name = 'selection-volume';
  volumeAnchor.visible = false;
  context.scene.add(volumeAnchor);

  /**
   * Invisible unit-box proxy. `TransformGizmo` derives its extrude-scale anchor
   * (the "opposite face stays put" behaviour) by traversing the attached object
   * for `isMesh` children; a `LineSegments` wireframe is invisible to that walk
   * and it would fall back to half-extents of 0.5, putting the anchor at half
   * the right distance. Every unit shape here spans ±1, so one box covers all
   * three kinds and never needs rebuilding.
   */
  const boundsProxy = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
  boundsProxy.visible = false;
  volumeAnchor.add(boundsProxy);

  let wireframe: THREE.LineSegments | null = null;

  // Constructed eagerly, not on the first scene: the gizmo registers its own
  // canvas pointer listeners here, and the host's suppression relies on them
  // landing after its camera listener and before its paint one.
  const gizmo = new TransformGizmo(context.camera, context.domElement, {
    theme: {
      // Degrees while rotating, and Shift/Alt scale hints on the axes.
      showSectorLabel: true,
      showScaleModifiers: true,
      // Half the package default so rotate rings stay readable without
      // crowding the combined translate/scale handles.
      sizes: { ringTube: 0.006 },
    },
  });
  // Combined shows translate, rotate and scale handles together - the usual
  // placement workflow; dedicated modes stay available for precision edits.
  gizmo.setMode('combined');
  context.scene.add(gizmo);
  gizmo.addEventListener('dragging-changed', (event) => {
    context.onGizmoDragChange(event.value);
  });
  gizmo.addEventListener('objectChange', () => {
    // In transform mode the gizmo drives the separated part, not the selection
    // volume - the volume is gone by then, and re-running the selection preview
    // would scan the cloud against a shape nobody can see.
    if (transforming) {
      applyPartAnchor();
      return;
    }
    clampAnchorScale();
    syncPreview();
  });

  /**
   * Placement proxy for the separated part while `transform` is on. The gizmo
   * mutates this object; `applyPartAnchor` copies it into the part's base
   * pose, which `update` composes with the bob/spin every frame - so animation
   * and hand placement stack instead of fighting.
   */
  const partAnchor = new THREE.Object3D();
  partAnchor.visible = false; // the gizmo draws the handles; this is just a frame
  context.scene.add(partAnchor);
  /** True while the gizmo is attached to a separated part rather than the volume. */
  let transforming = false;

  const applyPartAnchor = (): void => {
    const part = parts[0];
    if (!part) return;
    part.basePosition.copy(partAnchor.position);
    part.baseQuaternion.copy(partAnchor.quaternion);
    part.baseScale.copy(partAnchor.scale);
  };

  /** Attaches (or releases) the gizmo on the separated part. */
  const setTransforming = (enabled: boolean): void => {
    const part = parts[0];
    transforming = enabled && part !== undefined;
    if (transforming && part) {
      partAnchor.position.copy(part.basePosition);
      partAnchor.quaternion.copy(part.baseQuaternion);
      partAnchor.scale.copy(part.baseScale);
      partAnchor.updateMatrixWorld(true);
      gizmo.attach(partAnchor);
      gizmo.enabled = true;
      gizmo.visible = true;
    } else {
      gizmo.detach();
    }
    renderButtons();
  };

  /**
   * The selection volume: the anchor's whole placement as `transform`, applied
   * to the *unit* shape.
   *
   * Baking the per-axis scale into the matrix rather than into the dimensions
   * is what lets a squashed sphere select a true ellipsoid - `containsPoint`
   * maps every point through `transform⁻¹` and costs the same either way. It
   * also makes the library's positive-dimension check unfailable here, since
   * the dimensions are now compile-time constants.
   */
  const volumeTransform = new THREE.Matrix4();
  const volumeOptions = (): SelectionVolumeOptions => {
    // The anchor is a direct child of the scene, which is never transformed, so
    // its local matrix is already its world matrix.
    volumeAnchor.updateMatrix();
    volumeTransform.copy(volumeAnchor.matrix);
    return { kind, transform: volumeTransform, ...unitVolumeDimensions(kind) };
  };

  /**
   * Keeps the anchor's scale strictly positive. A scale handle can be dragged
   * through zero, which makes the placement singular - and `createSelectionVolume`
   * rejects that by throwing, from inside a `requestAnimationFrame` callback
   * where the throw would be unhandled. Clamped in place rather than at compose
   * time so the wireframe, the gizmo and the CPU volume never disagree.
   */
  const clampAnchorScale = (): void => {
    const [x, y, z] = clampVolumeScale(
      [volumeAnchor.scale.x, volumeAnchor.scale.y, volumeAnchor.scale.z],
      Math.max(1e-6, sizeRange() * 1e-3),
    );
    volumeAnchor.scale.set(x, y, z);
  };

  const disposeWireframe = (): void => {
    if (!wireframe) return;
    volumeAnchor.remove(wireframe);
    wireframe.geometry.dispose();
    wireframe = null;
  };

  /**
   * Swaps in the unit wireframe for `kind`, keeping the current placement. Each
   * geometry spans ±1 so that, under the anchor's matrix, the wireframe traces
   * the selection boundary exactly - including under rotation and per-axis scale.
   */
  const rebuildWireframe = (): void => {
    disposeWireframe();
    const geometry =
      kind === 'box'
        ? new THREE.BoxGeometry(2, 2, 2)
        : kind === 'sphere'
          ? new THREE.SphereGeometry(1, 24, 12)
          : new THREE.CylinderGeometry(1, 1, 2, 24, 1);
    wireframe = new THREE.LineSegments(new THREE.WireframeGeometry(geometry), wireMaterial);
    geometry.dispose();
    volumeAnchor.add(wireframe);
    syncPreview();
  };

  /** Mirrors the world-placed selection volume into the mesh-local SDF preview. */
  const syncPreview = (): void => {
    if (!mesh) return;
    // The SDF modifier tests mesh-local centers, so map the world volume into
    // the mesh's frame. Note this is the *mesh's* matrix, not
    // `selectionWorldMatrix`: the two agree for a plain mesh, but a separated
    // `MergedSplatMesh` sits at identity while `selectionWorldMatrix` is the source
    // data frame's placement, and the material already places splats before
    // the modifier stack - mapping by the placement too would double-count it.
    // `selectionWorldMatrix` stays the CPU volume's frame (it maps
    // `SplatData.positions`, which are unplaced).
    //
    // `meshLocalSdfShape` documents where this preview is exact and where it
    // only approximates: a box is exact, while a squashed sphere or cylinder
    // selects an ellipsoid the SDF has no way to draw and falls back to a
    // volume-preserving radius. The selection itself is exact for every
    // placement - it uses the matrix directly.
    mesh.updateWorldMatrix(true, false);
    volumeAnchor.updateMatrix();
    const shape = meshLocalSdfShape(kind, volumeAnchor.matrix.elements, mesh.matrixWorld.elements);
    // A singular or non-finite mesh matrix has no mesh-local image at all. Skip
    // rather than hand `setShapes` values it throws on: this runs inside the
    // gizmo's pointermove, and a throw there would strand the drag.
    if (shape) {
      sdf.setShapes([{ ...shape, color: PREVIEW_COLOR, mode: 'tint', strength: 0.6 }]);
    }
  };

  // --- Panel ----------------------------------------------------------------
  const panel = document.createElement('nav');
  panel.id = 'separate';
  panel.hidden = true; // shown by onScene once any scene mounts

  const shapeButtons = new Map<SelectionVolumeKind, HTMLButtonElement>();
  for (const shape of ['box', 'sphere', 'cylinder'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = shape;
    button.title = `Select with a ${shape} volume`;
    button.addEventListener('click', () => {
      kind = shape;
      renderButtons();
      rebuildWireframe();
    });
    shapeButtons.set(shape, button);
    panel.appendChild(button);
  }

  const sizeRange = (): number => (worldBounds.getSize(new THREE.Vector3()).length() || 4) * 0.25;

  const modeLabel = document.createElement('span');
  modeLabel.className = 'label';
  modeLabel.textContent = '|';
  panel.appendChild(modeLabel);

  const availability = document.createElement('span');
  availability.className = 'label';
  availability.hidden = true;
  availability.textContent = 'preview only (streamed scene)';
  availability.title =
    'The selection volume works, but cutting requires a fully loaded .sog, .ply, .spz, .splat or .ksplat file.';
  panel.appendChild(availability);

  const modeButtons = new Map<GizmoMode, HTMLButtonElement>();
  for (const [mode, text, title] of [
    ['combined', 'all', 'Move, rotate and scale in one view'],
    ['translate', 'move', 'Move the selection volume'],
    ['rotate', 'rotate', 'Orient the selection volume'],
    ['scale', 'scale', 'Resize the selection volume, one axis at a time'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = title;
    button.addEventListener('click', () => {
      gizmo.setMode(mode);
      renderButtons();
    });
    modeButtons.set(mode, button);
    panel.appendChild(button);
  }

  const action = (text: string, title: string, onClick: () => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = title;
    button.addEventListener('click', onClick);
    panel.appendChild(button);
    return button;
  };

  const separateButton = action(
    '✂ separate',
    'Split the highlighted splats into their own independently animated object',
    () => void separate(),
  );
  const transformButton = action(
    'transform',
    'Place the separated part by hand with the gizmo',
    () => setTransforming(!transforming),
  );
  const animationLabel = document.createElement('label');
  animationLabel.className = 'label';
  animationLabel.textContent = 'anim ';
  const animationSelect = document.createElement('select');
  animationSelect.className = 'picker-select';
  for (const [value, text] of [
    ['off', 'off'],
    ['bob', 'bob / spin'],
    ['wave', 'wave'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    animationSelect.appendChild(option);
  }
  animationSelect.value = animationMode;
  animationSelect.title =
    'Animate the separated part with a rigid motion or a feathered wind ripple';
  animationSelect.addEventListener('change', () => {
    animationMode = animationSelect.value as AnimationMode;
    syncAnimationModifier();
    renderButtons();
  });
  animationSelect.addEventListener('pointerdown', (event) => event.stopPropagation());
  animationLabel.appendChild(animationSelect);
  panel.appendChild(animationLabel);
  const restoreButton = action('restore', 'Rebuild the original single mesh', () => void restore());

  const renderButtons = (): void => {
    const separated = parts.length > 0;
    const selectable = mesh !== null;
    // Once separated the selection volume is gone from the screen, so the
    // shape buttons have nothing to reshape until `restore` brings it back.
    // Leaving them live invites the reasonable conclusion that the tool broke.
    for (const [shape, button] of shapeButtons) {
      button.classList.toggle('active', shape === kind);
      button.disabled = busy || separated || !selectable;
    }
    // The gizmo modes, by contrast, drive whatever the gizmo currently holds:
    // the volume before separating, the separated part while `transform` is on.
    for (const [mode, button] of modeButtons) {
      button.classList.toggle('active', mode === gizmo.mode);
      button.disabled = busy || !selectable || (separated && !transforming);
    }
    transformButton.classList.toggle('active', transforming);
    transformButton.disabled = !separated || busy;
    animationSelect.value = animationMode;
    animationSelect.disabled = !separated || busy;
    restoreButton.disabled = parts.length === 0 || busy;
    availability.hidden = state.usable || !selectable;
    // A globally sorted scene is rebuilt from the static pair for this demo's
    // one separation gesture. Restore before choosing a different region.
    separateButton.disabled = busy || !state.usable || parts.length > 0 || !context.canSeparate();
  };

  const chrome = document.querySelector('#bottom-chrome');
  (chrome ?? document.body).appendChild(panel);

  // --- Actions --------------------------------------------------------------
  const syncAnimationModifier = (): void => {
    context.setPreviewModifier(animationMode === 'wave' ? (parts[0]?.wave.modifier ?? null) : null);
  };

  const separate = async (): Promise<void> => {
    const data = state.currentData;
    if (!mesh || !data || busy || !context.canSeparate()) return;
    const volume = createSelectionVolume(volumeOptions(), selectionWorldMatrix);
    const partition = partitionSplatData(data, volume);
    if (partition.inside.count === 0 || partition.outside.count === 0) return;
    busy = true;
    renderButtons();
    // Captured before the commit: the dimensions are unit, so the anchor's own
    // scale is the volume's world half-extent - the quantity the size slider
    // used to feed the animation.
    const bobAmplitude =
      ((volumeAnchor.scale.x + volumeAnchor.scale.y + volumeAnchor.scale.z) / 3) * 0.35;
    volumeAnchor.updateMatrix();
    const dataToVolume = volumeAnchor.matrix.clone().invert().multiply(selectionWorldMatrix);
    try {
      const source = await context.commit(partition);
      const basePosition = new THREE.Vector3();
      const baseQuaternion = new THREE.Quaternion();
      const baseScale = new THREE.Vector3();
      source.transform.decompose(basePosition, baseQuaternion, baseScale);
      state.onSeparated(partition.outside);
      parts.push({
        source,
        basePosition,
        baseQuaternion,
        baseScale,
        phase: parts.length * 1.3,
        bobAmplitude,
        wave: createSelectionWave(kind, dataToVolume, bobAmplitude * 0.45),
      });
      // The selected source is now an independently moving source in the same
      // global sorter. Do not leave the selection tint - or the placement
      // gizmo - attached to it. `commit` re-entered `onScene` and re-attached
      // both, so this has to run after the await, not before.
      syncAnimationModifier();
      gizmo.detach();
      volumeAnchor.visible = false;
    } finally {
      busy = false;
      renderButtons();
    }
  };

  const restore = async (): Promise<void> => {
    const data = state.restorePoint;
    if (!data || busy) return;
    busy = true;
    renderButtons();
    try {
      disposeParts();
      await context.restore(data);
      state.onRestored(data);
    } finally {
      busy = false;
      renderButtons();
    }
  };

  const disposeParts = (): void => {
    parts.length = 0;
    // Nothing left to place: release the gizmo before `restore` re-attaches it
    // to the selection volume, or it would hold a proxy for a part that is gone.
    setTransforming(false);
  };

  return {
    get hasSeparatedParts() {
      return parts.length > 0;
    },

    volumeAnchor,

    setInteractive(enabled): void {
      gizmo.enabled = enabled;
      gizmo.visible = enabled && gizmo.object !== null;
    },

    syncVolume(): void {
      clampAnchorScale();
      syncPreview();
    },

    onScene(nextMesh, data, origin, nextSelectionWorldMatrix = nextMesh.matrixWorld): void {
      const usableData = nextMesh instanceof StreamedSplatMesh ? null : data;
      // The state machine decides whether this is a genuinely new scene (drop
      // everything) or one of the tool's own swaps (keep the parts and the
      // restore point) - see separation-state.ts.
      const reset = state.onScene(usableData, origin);
      if (reset) disposeParts();

      // A streamed scene cannot be partitioned, but its mesh still evaluates
      // modifiers and exposes complete manifest bounds. Keep the volume,
      // gizmo, and tint useful instead of making the selected tool disappear;
      // only the destructive action is disabled below.
      panel.hidden = false;
      mesh = nextMesh;
      selectionWorldMatrix.copy(nextSelectionWorldMatrix);
      context.setPreviewModifier(sdf.modifier);
      worldBounds = usableData
        ? new THREE.Box3().setFromArray(usableData.positions).applyMatrix4(selectionWorldMatrix)
        : nextMesh.computeSplatBounds().applyMatrix4(nextMesh.matrixWorld);
      if (reset) {
        worldBounds.getCenter(volumeAnchor.position);
        volumeAnchor.quaternion.identity();
        volumeAnchor.scale.setScalar(sizeRange() * 0.25);
      }
      volumeAnchor.visible = true;
      // A new scene means a new selection: the gizmo goes back to the volume,
      // whatever it was holding for a part that no longer exists.
      transforming = false;
      gizmo.attach(volumeAnchor);
      rebuildWireframe();
      renderButtons();
    },

    update(elapsedSeconds): void {
      for (const part of parts) {
        animatedPosition.copy(part.basePosition);
        animatedQuaternion.copy(part.baseQuaternion);
        if (animationMode === 'bob') {
          const t = elapsedSeconds + part.phase;
          animatedPosition.addScaledVector(BOB_AXIS, Math.sin(t * 1.4) * part.bobAmplitude);
          animatedQuaternion
            .setFromAxisAngle(SPIN_AXIS, Math.sin(t * 0.8) * 0.5)
            .premultiply(part.baseQuaternion);
        }
        animatedTransform.compose(animatedPosition, animatedQuaternion, part.baseScale);
        part.source.setTransform(animatedTransform);
        if (animationMode === 'wave') part.wave.update(elapsedSeconds + part.phase);
      }
    },

    refresh(): void {
      renderButtons();
    },

    dispose(): void {
      disposeParts();
      disposeWireframe();
      gizmo.detach();
      gizmo.dispose(); // removes the gizmo's own canvas pointer listeners
      context.scene.remove(gizmo); // dispose() does not unparent itself
      context.scene.remove(volumeAnchor);
      boundsProxy.geometry.dispose();
      boundsProxy.material.dispose();
      wireMaterial.dispose();
      context.setPreviewModifier(null);
      panel.remove();
    },
  };
}
