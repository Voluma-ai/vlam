/**
 * The demo viewer's `rigged` effect: the procedural goose (`goose-procedural.ts`)
 * standing in the scene, rigged (`goose-rig.ts`) and animated by its clips
 * (`goose-clips.ts`), with buttons that fire each gesture. `main.ts` reaches
 * this module only through a dynamic `import()`, like the `4dgs` effect, so the
 * goose builder stays out of the viewer's bundle until the effect is picked.
 *
 * The goose stands near where the `4dgs` dancers do (`scene-stage.ts`), facing
 * the camera. On WebGPU the scene and the goose draw through one
 * `UnifiedSplatMesh`, so the goose is depth-sorted with the scene's splats;
 * on WebGL2 it is layered over the scene.
 */
import * as THREE from 'three/webgpu';
import type { SplatMesh, SplatSortMetric } from '../lib/core';
import { UnifiedSplatMesh, supportsUnifiedSplatMesh } from '../lib/unified';
import { createProceduralGoose, type ProceduralGoose } from './goose-procedural';
import { createGooseRig } from './goose-rig';
import { GooseChoreography, GoosePuppet, type GooseClipName } from './goose-clips';
import { sceneStageCenter } from './scene-stage';

/** What the effect needs from the viewer. */
export interface GooseEffectHost {
  readonly scene: THREE.Scene;
  /** The mounted scene mesh; joins the unified draw while the effect runs. */
  readonly splats: SplatMesh;
  /** Scene file name, for the stage's placement. */
  readonly sceneTitle: string;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGPURenderer;
  readonly sortMetric: SplatSortMetric;
  /** False while another unified draw (the benchmark's) already owns the scene mesh. */
  readonly allowUnified: boolean;
  /** Re-checked once the goose is built; a stale mount builds nothing. */
  isCurrent(): boolean;
}

/** A mounted effect: the viewer calls these from its own loop and teardown. */
export interface GooseEffect {
  /** The scene + goose draw to update instead of the scene mesh, else null. */
  readonly unifiedDraw: UnifiedSplatMesh | null;
  /** The goose's clips and mixer (for the console and checks). */
  readonly choreography: GooseChoreography;
  /** Fires a gesture, as its button does. */
  play(name: Gesture): void;
  /** Advances the animation to wall-clock time; call once per frame before the scene update. */
  update(): void;
  /** Removes the goose and hands the scene mesh its own draw back. */
  dispose(): void;
}

type Gesture = Exclude<GooseClipName, 'look'>;

/** The buttons, in order: each fires its clip on top of the `look` loop. */
const GESTURES: readonly { readonly name: Gesture; readonly label: string }[] = [
  { name: 'flap', label: 'Flap' },
  { name: 'honk', label: 'Honk' },
  { name: 'wag', label: 'Wag' },
];

/** Where the goose stands in a known scene, the point it faces, and its size. */
interface GoosePlacement {
  readonly feet: readonly [number, number, number];
  readonly faces: readonly [number, number];
  /** Uniform scale; the goose is life-size (about 0.8 m tall) at 1. */
  readonly scale: number;
}

/**
 * Goose placements keyed by scene file name; elsewhere it takes the `4dgs`
 * stage at life size and faces the camera. Tempel: on the stone in the middle
 * of the courtyard's planted bed (the `4dgs` stage), twice life size so it
 * stands clear of the plants and reads from the courtyard entrance, facing the
 * demo's start pose there (the site's "Demo" link).
 */
const GOOSE_PLACEMENTS: Readonly<Record<string, GoosePlacement>> = {
  'Tempel.lcc2': { feet: [-0.42, 0, -23.3], faces: [-8.13, -38.34], scale: 2 },
};

/** The goose takes a moment to build; it is kept for a later switch back. */
let built: ProceduralGoose | null = null;

function buildGoose(): ProceduralGoose {
  // No ground patch: the goose stands on the scene's own floor.
  built ??= createProceduralGoose({ ground: false });
  return built;
}

/** The bar of gesture buttons, and how the effect shows which gestures are playing. */
interface GooseControls {
  readonly bar: HTMLElement;
  /** Lights a gesture's button while its clip plays (fired by a click or the schedule). */
  showPlaying(name: Gesture, playing: boolean): void;
}

/** Top-center bar, where the `4dgs` credit sits: a title line and one button per gesture, plus the schedule toggle. */
function createControls(
  play: (name: Gesture) => void,
  setAuto: (auto: boolean) => void,
): GooseControls {
  const bar = document.createElement('div');
  bar.id = 'goose-controls';
  // A press on the bar is not a camera drag or a scene pick, as with the
  // viewer's other controls.
  bar.addEventListener('pointerdown', (event) => event.stopPropagation());
  Object.assign(bar.style, {
    position: 'fixed',
    top: '66px',
    left: '0',
    right: '0',
    margin: '0 auto',
    width: 'fit-content',
    maxWidth: 'min(92vw, 560px)',
    padding: '8px 14px',
    borderRadius: '12px',
    background: 'rgba(20, 20, 26, 0.55)',
    backdropFilter: 'blur(10px)',
    color: '#eee',
    font: '13px/1.4 system-ui, sans-serif',
    textAlign: 'center',
    zIndex: '10',
  });
  const title = document.createElement('strong');
  title.textContent = 'Rigged splats';
  const note = document.createElement('div');
  note.textContent =
    'A procedural goose made of Gaussian splats, skinned to a skeleton, played by AnimationMixer clips';
  note.style.opacity = '0.8';
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: '6px',
    marginTop: '6px',
  });
  const button = (text: string, onClick: (button: HTMLButtonElement) => void) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = text;
    Object.assign(element.style, {
      padding: '4px 12px',
      borderRadius: '8px',
      border: '1px solid rgba(255, 255, 255, 0.25)',
      background: 'rgba(255, 255, 255, 0.1)',
      color: '#eee',
      font: 'inherit',
      cursor: 'pointer',
      transition: 'background 120ms, color 120ms',
    });
    element.addEventListener('click', () => {
      onClick(element);
      // Keep keyboard input (Space, WASD under `fpv=1`) for the camera.
      element.blur();
    });
    row.append(element);
    return element;
  };
  const gestureButtons = new Map<Gesture, HTMLButtonElement>();
  for (const { name, label } of GESTURES) {
    const element = button(label, () => play(name));
    element.dataset.gesture = name;
    gestureButtons.set(name, element);
  }
  let auto = true;
  const autoButton = button('', () => {
    auto = !auto;
    setAuto(auto);
    syncAuto();
  });
  autoButton.dataset.gesture = 'auto';
  autoButton.title = 'Fire the gestures on a repeating 9-second schedule';
  const syncAuto = (): void => {
    autoButton.textContent = auto ? 'Auto: on' : 'Auto: off';
    autoButton.setAttribute('aria-pressed', String(auto));
    autoButton.style.borderColor = auto ? '#ffb84d' : 'rgba(255, 255, 255, 0.25)';
  };
  syncAuto();
  bar.append(title, note, row);
  return {
    bar,
    showPlaying(name, playing) {
      const element = gestureButtons.get(name);
      if (!element || (element.dataset.playing === 'true') === playing) return;
      element.dataset.playing = String(playing);
      element.style.background = playing ? '#ffb84d' : 'rgba(255, 255, 255, 0.1)';
      element.style.color = playing ? '#1a1a1f' : '#eee';
    },
  };
}

/**
 * Builds the goose (or reuses it) and stands it in the scene. Resolves null
 * when `host.isCurrent()` turned false meanwhile.
 */
export async function mountGooseEffect(host: GooseEffectHost): Promise<GooseEffect | null> {
  // Let the picker's change paint before the synchronous build.
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (!host.isCurrent()) return null;
  const goose = buildGoose();
  const { scene, splats, camera, renderer, sortMetric } = host;
  // Draw settings follow the scene's, which the unified draw requires of every source.
  const view = splats.getUnifiedSourceView();
  const rig = createGooseRig(goose, {
    sortMetric,
    srgbOutput: view.srgbOutput,
    maxStdDev: view.maxStdDev,
    minSplatSizePx: view.minSplatSizePx,
    minPixelSize: view.minPixelSize,
    minContribution: view.minContribution,
    projectedFilterProfile: view.projectedFilterProfile,
    antialias: view.antialias,
  });
  const { mesh } = rig;

  // Feet on the stage. A known scene names the point the goose faces: the
  // camera can still be at its pre-framing pose when the effect mounts on load.
  // The goose faces +X in its own frame, so a turn of θ about Y faces it
  // along (cos θ, -sin θ) in XZ.
  const preset = GOOSE_PLACEMENTS[host.sceneTitle];
  const center = preset
    ? new THREE.Vector3(...preset.feet)
    : sceneStageCenter(host.sceneTitle, splats);
  const [facesX, facesZ] = preset?.faces ?? [camera.position.x, camera.position.z];
  const group = new THREE.Group();
  group.position.copy(center);
  group.scale.setScalar(preset?.scale ?? 1);
  group.rotation.y = Math.atan2(facesX - center.x, facesZ - center.z) - Math.PI / 2;
  group.add(mesh);
  scene.add(group);
  group.updateMatrixWorld(true);

  const puppet = new GoosePuppet();
  const choreography = new GooseChoreography(puppet);
  rig.setPose(puppet);
  let auto = true;
  const play = (name: Gesture): void => {
    choreography.start(name);
    choreography.mixer.update(0);
  };

  let unifiedDraw: UnifiedSplatMesh | null = null;
  let disposed = false;
  const controls = createControls(play, (value) => {
    auto = value;
  });
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (unifiedDraw) {
      // Disposing hands the scene mesh its own draw back.
      scene.remove(unifiedDraw);
      unifiedDraw.dispose();
    }
    choreography.mixer.stopAllAction();
    scene.remove(group);
    mesh.dispose();
    controls.bar.remove();
  };
  try {
    if (host.allowUnified && supportsUnifiedSplatMesh(renderer)) {
      unifiedDraw = new UnifiedSplatMesh(renderer, splats.capacity + mesh.capacity, {
        performanceProfile: splats.performanceProfile,
        srgbOutput: view.srgbOutput,
        minPixelSize: view.minPixelSize,
        minContribution: view.minContribution,
        sortMetric,
      });
      unifiedDraw.addSource(splats, { visible: true });
      // Not cached: the skin and lighting change every frame, and the unified
      // draw re-sorts on the skin's sort-displacement revision.
      unifiedDraw.addSource(mesh, { visible: true });
      scene.add(unifiedDraw);
    } else {
      // A separate mesh does not sort against the scene: draw the goose after
      // it, so it is never hidden behind the floor it stands on.
      mesh.renderOrder = 1;
    }
  } catch (error) {
    dispose();
    throw error;
  }
  document.body.append(controls.bar);

  const timer = new THREE.Timer();
  return {
    unifiedDraw,
    choreography,
    play,
    update(): void {
      timer.update();
      const delta = timer.getDelta();
      // Auto plays the schedule; otherwise only the buttons fire gestures.
      if (auto) choreography.update(delta);
      else choreography.mixer.update(delta);
      rig.setPose(puppet);
      for (const { name } of GESTURES) {
        controls.showPlaying(name, choreography.actions[name].isRunning());
      }
      // The unified draw updates its sources itself.
      if (!unifiedDraw) mesh.update(camera, renderer);
    },
    dispose,
  };
}
