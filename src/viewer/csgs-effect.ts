/**
 * The demo viewer's `4dgs` effect: Faltwerk `.csgs` clips dancing in the
 * scene. `main.ts` reaches this module only through a dynamic `import()`, so
 * the clip decoder, frame evaluator and playback meshes stay out of the
 * viewer's bundle until the effect is first picked.
 *
 * The clips stand in a small circle on the floor of a known scene
 * ({@link CSGS_PLACEMENTS}), or at the center of an unknown one, each facing
 * outward, the first toward the camera. On WebGPU the scene and the clips
 * draw through one `UnifiedSplatMesh`, so the dancers are depth-sorted with
 * the scene's splats and each other; WebGL2 has no unified draw and layers
 * the clips over the scene.
 */
import * as THREE from 'three/webgpu';
import type { SplatMesh, SplatSortMetric } from '../lib/core';
import { UnifiedSplatMesh, supportsUnifiedSplatMesh } from '../lib/unified';
import { CSGS_DEMO_SCENE, CsgsPlaybackMesh, loadCsgsClip, type CsgsClip } from './csgs-playback';

/**
 * Where the circle's center stands in known scenes (the dancers' feet), keyed
 * by scene file name. Tempel: under the VLAM! mark's placement point, a little
 * above the courtyard floor (y ≈ -0.36) so the legs clear the planted bed in
 * the middle.
 */
const CSGS_PLACEMENTS: Readonly<Record<string, readonly [number, number, number]>> = {
  'Tempel.lcc2': [-0.42, 0, -23.3],
};

/** The four clips of the public Faltwerk demo, played by default. */
const DEMO_CLIPS = ['female', 'male_1', 'male_2', 'angry_j'].map(
  (name) => new URL(`scene_${name}.json`, CSGS_DEMO_SCENE).href,
);

/** Distance from the circle's center to each dancer's feet, in metres. */
const CIRCLE_RADIUS = 0.8;

/** What the effect needs from the viewer. */
export interface CsgsEffectHost {
  /** `?csgs=<scene_*.json>[,…]`, or null for the public demo clips. */
  readonly clipUrl: string | null;
  readonly scene: THREE.Scene;
  /** The mounted scene mesh; joins the unified draw while the effect runs. */
  readonly splats: SplatMesh;
  /** Scene file name, for {@link CSGS_PLACEMENTS}. */
  readonly sceneTitle: string;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGPURenderer;
  readonly sortMetric: SplatSortMetric;
  /** False while another unified draw (the benchmark's) already owns the scene mesh. */
  readonly allowUnified: boolean;
  /** Re-checked once the clips have loaded; a stale mount builds nothing. */
  isCurrent(): boolean;
}

/** A mounted effect: the viewer calls these from its own loop and teardown. */
export interface CsgsEffect {
  /** The scene + clips draw to update instead of the scene mesh (WebGPU), else null. */
  readonly unifiedDraw: UnifiedSplatMesh | null;
  /** Advances the clips to wall-clock time; call once per frame before the scene update. */
  update(): void;
  /** Removes the clips and hands the scene mesh its own draw back. */
  dispose(): void;
}

/** The public Faltwerk demo the default clips come from. */
const FALTWERK_DEMO_URL = 'https://jameskane05.github.io/faltwerk-demo';
/** Faltwerk itself: the `.csgs` format and the decoder VLAM ports. */
const FALTWERK_URL = 'https://github.com/edrethardo/Faltwerk';

/**
 * The effect's credit line at the top of the screen, under the drop hint.
 * Styled inline so the viewer's own page carries nothing for it.
 */
function createCreditBanner(demoClips: boolean): HTMLElement {
  const banner = document.createElement('div');
  banner.id = 'csgs-credit';
  Object.assign(banner.style, {
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
  const link = (text: string, href: string): HTMLAnchorElement => {
    const anchor = document.createElement('a');
    anchor.textContent = text;
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    anchor.style.color = '#ffb84d';
    return anchor;
  };
  const title = document.createElement('strong');
  title.textContent = '4D Gaussian splatting playback';
  banner.append(title, document.createElement('br'));
  if (demoClips) {
    banner.append(
      'Clips from the ',
      link('Faltwerk demo', FALTWERK_DEMO_URL),
      ' by jameskane05 · ',
    );
  }
  banner.append(
    'format and decoder: ',
    link('Faltwerk', FALTWERK_URL),
    ' by edrethardo (MIT), ported to VLAM',
  );
  return banner;
}

/** Decoded clips by URL, kept across effect switches (decoding takes ~1 s each). */
const clips = new Map<string, Promise<CsgsClip>>();

function loadClip(url: URL): Promise<CsgsClip> {
  let clip = clips.get(url.href);
  if (!clip) {
    clip = loadCsgsClip(url).catch((error: unknown) => {
      clips.delete(url.href);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}. The clip is read from ${url.origin}; pass ?csgs=<scene_*.json> to use another copy.`,
      );
    });
    clips.set(url.href, clip);
  }
  return clip;
}

/**
 * Loads the clips (or reuses them) and stands them in the scene. Resolves
 * null when `host.isCurrent()` turned false while the clips loaded.
 */
export async function mountCsgsEffect(host: CsgsEffectHost): Promise<CsgsEffect | null> {
  const urls = host.clipUrl
    ? host.clipUrl
        .split(',')
        .map((url) => url.trim())
        .filter((url) => url.length > 0)
    : DEMO_CLIPS;
  // Each clip decodes in its own worker, so they load in parallel.
  const loaded = await Promise.all(urls.map((url) => loadClip(new URL(url, location.href))));
  if (!host.isCurrent()) return null;
  const { scene, splats, camera, renderer, sortMetric } = host;
  // The clips are already Y-up; draw settings follow the scene's, which the
  // unified draw requires of every source anyway.
  const sceneView = splats.getUnifiedSourceView();

  let center: THREE.Vector3;
  const preset = CSGS_PLACEMENTS[host.sceneTitle];
  if (preset) {
    center = new THREE.Vector3(...preset);
  } else {
    const bounds = splats.computeSplatBounds().clone().applyMatrix4(splats.matrixWorld);
    const middle = bounds.getCenter(new THREE.Vector3());
    center = new THREE.Vector3(middle.x, bounds.min.y, middle.z);
  }
  const toward = camera.position.clone().sub(center);
  const towardAngle = Math.atan2(toward.x, toward.z);
  const radius = loaded.length > 1 ? CIRCLE_RADIUS : 0;

  const meshes: CsgsPlaybackMesh[] = [];
  const groups: THREE.Group[] = [];
  loaded.forEach((clip, index) => {
    const mesh = new CsgsPlaybackMesh(clip, {
      orientation: 'source',
      // A dynamic-capacity pool allocates no SH unless asked.
      shBands: 3,
      sortMetric,
      srgbOutput: sceneView.srgbOutput,
      maxStdDev: sceneView.maxStdDev,
      minSplatSizePx: sceneView.minSplatSizePx,
      minPixelSize: sceneView.minPixelSize,
      minContribution: sceneView.minContribution,
      projectedFilterProfile: sceneView.projectedFilterProfile,
      antialias: sceneView.antialias,
    });
    // Feet on the group's origin: the clip's lowest splats (outliers aside)
    // at its height, the clip's horizontal center over it.
    const clipBounds = mesh.frameBounds(0);
    const clipCenter = clipBounds.getCenter(new THREE.Vector3());
    mesh.position.set(-clipCenter.x, -clipBounds.min.y, -clipCenter.z);
    // Around the circle, facing outward; the first dancer faces the camera.
    // The orbit's `front` points from the subject to its front camera.
    const facing = towardAngle + (index * 2 * Math.PI) / loaded.length;
    const [frontX = 0, , frontZ = 1] = clip.scene.orbit.front;
    const group = new THREE.Group();
    group.position.set(
      center.x + radius * Math.sin(facing),
      center.y,
      center.z + radius * Math.cos(facing),
    );
    group.rotation.y = facing - Math.atan2(frontX, frontZ);
    group.add(mesh);
    scene.add(group);
    group.updateMatrixWorld(true);
    meshes.push(mesh);
    groups.push(group);
  });

  let unifiedDraw: UnifiedSplatMesh | null = null;
  if (host.allowUnified && supportsUnifiedSplatMesh(renderer)) {
    const capacity = meshes.reduce((sum, mesh) => sum + mesh.capacity, splats.capacity);
    unifiedDraw = new UnifiedSplatMesh(renderer, capacity, {
      performanceProfile: splats.performanceProfile,
      srgbOutput: sceneView.srgbOutput,
      minPixelSize: sceneView.minPixelSize,
      minContribution: sceneView.minContribution,
      sortMetric,
    });
    unifiedDraw.addSource(splats, { visible: true });
    for (const mesh of meshes) unifiedDraw.addSource(mesh, { visible: true });
    scene.add(unifiedDraw);
  } else {
    // Separate meshes do not sort against each other: draw the dancers after
    // the scene, so they are never hidden behind the floor behind them.
    for (const mesh of meshes) mesh.renderOrder = 1;
  }

  const banner = createCreditBanner(host.clipUrl === null);
  document.body.append(banner);

  const startedAt = performance.now();
  /** Round-robin start, so every clip gets its turn to swap. */
  let next = 0;
  return {
    unifiedDraw,
    update(): void {
      const seconds = (performance.now() - startedAt) / 1000;
      // A swap evaluates a whole frame on the CPU (~20 ms for 60k splats), so
      // at most one clip swaps per rendered frame, the others keep theirs.
      for (let step = 0; step < meshes.length; step++) {
        const index = (next + step) % meshes.length;
        const mesh = meshes[index]!;
        const { fps } = mesh.clip.scene;
        const frame = Math.floor((seconds * fps) % mesh.clip.totalFrames);
        if (frame === mesh.shownFrame) continue;
        // A standalone swap waits while its last sort runs (see CsgsPlaybackMesh).
        if (mesh.showFrame(frame)) {
          next = index + 1;
          break;
        }
      }
      // The unified draw updates the meshes itself.
      if (!unifiedDraw) for (const mesh of meshes) mesh.update(camera, renderer);
    },
    dispose(): void {
      if (unifiedDraw) {
        // Disposing hands the scene mesh its own draw back.
        scene.remove(unifiedDraw);
        unifiedDraw.dispose();
      }
      for (const group of groups) scene.remove(group);
      for (const mesh of meshes) mesh.dispose();
      banner.remove();
    },
  };
}
