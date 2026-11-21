/**
 * The demo viewer's `4dgs` effect: 4D clips dancing in the scene (Faltwerk
 * `.csgs` by default, any format `loadSplatClip` reads through `?clips=`), played by `SplatClipMesh` (`@voluma/vlam/dynamic`), each driven by
 * its own `AnimationMixer`. `main.ts` reaches this module only through a
 * dynamic `import()`, so the clip decoder and playback stay out of the
 * viewer's bundle until the effect is first picked.
 *
 * The clips stand in a small circle on the floor of a known scene
 * ({@link CSGS_PLACEMENTS}), or at the center of an unknown one, each facing
 * outward, the first toward the camera. On WebGPU the scene and the clips
 * draw through one `UnifiedSplatMesh`, so the dancers are depth-sorted with
 * the scene's splats and each other. On WebGL2, when the scene was loaded
 * into a pool with room for the clips ({@link CsgsEffectHost.pool}), the
 * clips join that pool and everything draws through one CPU-sorted
 * `PooledUnifiedSplatMesh`; otherwise the clips are layered over the scene.
 */
import * as THREE from 'three/webgpu';
import type { SplatMesh, SplatPool, SplatSortMetric } from '../lib/core';
import { UnifiedSplatMesh, supportsUnifiedSplatMesh } from '../lib/unified';
import { PooledUnifiedSplatMesh } from '../lib/unified/pooled';
import {
  SplatClipMesh,
  SplatClipStagingBudget,
  loadSplatClip,
  splatFrameBounds,
  type SplatClip,
} from '../lib/dynamic';
import { CSGS_DEMO_SCENE } from './csgs-demo';
import { createClipSound, type ClipSound } from './clip-sound';

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
  /** `?clips=` / `?csgs=` (clip URLs, comma-separated), or null for the public demo clips. */
  readonly clipUrl: string | null;
  readonly scene: THREE.Scene;
  /** The mounted scene mesh; joins the unified draw while the effect runs. */
  readonly splats: SplatMesh;
  /** Scene file name, for {@link CSGS_PLACEMENTS}. */
  readonly sceneTitle: string;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGPURenderer;
  readonly sortMetric: SplatSortMetric;
  /**
   * The pool the scene mesh draws from when the viewer sized it for the
   * clips too (WebGL2 with `?clips=`), else null: the clips then join it and
   * one pooled draw sorts them with the scene.
   */
  readonly pool: SplatPool | null;
  /** False while another unified draw (the benchmark's) already owns the scene mesh. */
  readonly allowUnified: boolean;
  /** Re-checked once the clips have loaded; a stale mount builds nothing. */
  isCurrent(): boolean;
}

/** A mounted effect: the viewer calls these from its own loop and teardown. */
export interface CsgsEffect {
  /** The scene + clips draw to update instead of the scene mesh, else null. */
  readonly unifiedDraw: UnifiedSplatMesh | PooledUnifiedSplatMesh | null;
  /** Advances the clips to wall-clock time; call once per frame before the scene update. */
  update(): void;
  /** Removes the clips and hands the scene mesh its own draw back. */
  dispose(): void;
}

/** The public Faltwerk demo the default clips come from. */
const FALTWERK_DEMO_URL = 'https://jameskane05.github.io/faltwerk-demo';
/** The `.asog` format and the reference decoder VLAM ports. */
const ANIMATED_SOG_URL = 'https://github.com/arrival-space/animated-sog';
/** Faltwerk itself: the `.csgs` format and the decoder VLAM ports. */
const FALTWERK_URL = 'https://github.com/edrethardo/Faltwerk';

/**
 * The effect's credit line at the top of the screen, under the drop hint.
 * Styled inline so the viewer's own page carries nothing for it.
 */
function createCreditBanner(demoClips: boolean, faltwerk: boolean, asog: boolean): HTMLElement {
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
  if (faltwerk) {
    banner.append(
      'format and decoder: ',
      link('Faltwerk', FALTWERK_URL),
      ' by edrethardo (MIT), ported to VLAM',
    );
  }
  if (faltwerk && asog) banner.append(' · ');
  if (asog) {
    banner.append(
      link('Animated SOG', ANIMATED_SOG_URL),
      ' by Arrival.Space (MIT), ported to VLAM',
    );
  }
  return banner;
}

/**
 * Decoded clips by URL, kept across effect switches (decoding takes ~1 s
 * each). `.asog` clips are released with the effect instead (see
 * {@link releaseAsogClips}).
 */
const clips = new Map<string, Promise<SplatClip>>();

/**
 * Drops the `.asog` clips among `loaded` from the cache and disposes them: each
 * holds its decode workers with a decoded copy of the file (about 75 MB per
 * 400k splats), too much to keep for a later switch back.
 */
function releaseAsogClips(loaded: readonly { clip: SplatClip; href: string }[]): void {
  for (const { clip, href } of loaded) {
    if (clip.format !== 'asog') continue;
    clips.delete(href);
    clip.dispose();
  }
}

function loadClip(url: URL): Promise<SplatClip> {
  let clip = clips.get(url.href);
  if (!clip) {
    clip = loadSplatClip(url).catch((error: unknown) => {
      clips.delete(url.href);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}. The clip is read from ${url.origin}; pass ?clips=<url> to use another copy.`,
      );
    });
    clips.set(url.href, clip);
  }
  return clip;
}

/**
 * The 2nd to 98th percentile box of `count` y-down centres, taken after the
 * 180°-X turn that stands them up (y and z negated): the subject, without
 * the stray splats captures carry far out.
 */
function subjectBounds(positions: Float32Array, count: number): THREE.Box3 {
  const box = new THREE.Box3();
  if (count === 0) return box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3());
  const stride = Math.max(1, Math.floor(count / 50000));
  for (let c = 0; c < 3; c++) {
    const sign = c === 0 ? 1 : -1;
    const axis: number[] = [];
    for (let i = 0; i < count; i += stride) axis.push(sign * positions[i * 3 + c]!);
    axis.sort((a, b) => a - b);
    box.min.setComponent(c, axis[Math.floor(0.02 * (axis.length - 1))]!);
    box.max.setComponent(c, axis[Math.ceil(0.98 * (axis.length - 1))]!);
  }
  return box;
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
  // Each clip decodes in its own worker, so they load in parallel. The first
  // frame's bounds set where each dancer's feet are.
  const loaded = await Promise.all(
    urls.map(async (url) => {
      const { href } = new URL(url, location.href);
      const clip = await loadClip(new URL(href));
      // .asog is y down: the mesh turns 180° about X, so its first frame's
      // bounds are taken in that turned frame (y and z negated).
      const yDown = clip.format === 'asog';
      const first = await clip.frame(0);
      const bounds = yDown ? subjectBounds(first.positions, first.count) : splatFrameBounds(first);
      return { clip, href, yDown, bounds };
    }),
  );
  if (!host.isCurrent()) {
    releaseAsogClips(loaded);
    return null;
  }
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

  // On WebGPU every clip the GPU path can hold evaluates its curves there and
  // joins the scene in one unified draw; otherwise (WebGL2) the clips' workers
  // evaluate frames and the meshes swap them in, layered over the scene.
  const unified = host.allowUnified && supportsUnifiedSplatMesh(renderer);
  // WebGL2: one pooled draw, when the scene already draws from a pool the
  // viewer sized for the clips too.
  const pool =
    !unified &&
    host.allowUnified &&
    host.pool &&
    sceneView.centersTexture === host.pool.centersTexture
      ? host.pool
      : null;
  // The clips share one staging budget: their sections end together.
  const staging = new SplatClipStagingBudget();
  const meshes: SplatClipMesh[] = [];
  const mixers: THREE.AnimationMixer[] = [];
  const groups: THREE.Group[] = [];
  let unifiedDraw: UnifiedSplatMesh | PooledUnifiedSplatMesh | null = null;
  const sounds: ClipSound[] = [];
  let disposed = false;
  const banner = createCreditBanner(
    host.clipUrl === null,
    loaded.some(({ clip }) => clip.format === 'csgs'),
    loaded.some(({ clip }) => clip.format === 'asog'),
  );
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (unifiedDraw) {
      // Disposing hands the scene mesh its own draw back.
      scene.remove(unifiedDraw);
      unifiedDraw.dispose();
    }
    for (const mixer of mixers) mixer.stopAllAction();
    for (const sound of sounds) sound.dispose();
    for (const group of groups) scene.remove(group);
    for (const mesh of meshes) mesh.dispose();
    releaseAsogClips(loaded);
    banner.remove();
  };
  try {
    loaded.forEach(({ clip, yDown, bounds: clipBounds }, index) => {
      const mesh = new SplatClipMesh(clip, {
        renderer,
        staging,
        sortMetric,
        srgbOutput: sceneView.srgbOutput,
        maxStdDev: sceneView.maxStdDev,
        minSplatSizePx: sceneView.minSplatSizePx,
        minPixelSize: sceneView.minPixelSize,
        minContribution: sceneView.minContribution,
        projectedFilterProfile: sceneView.projectedFilterProfile,
        antialias: sceneView.antialias,
        ...(pool ? { pool } : {}),
      });
      meshes.push(mesh);
      mesh.addEventListener('error', ({ error }) => console.error('4DGS playback failed', error));
      // Feet on the group's origin: the clip's lowest splats (outliers aside)
      // at its height, the clip's horizontal center over it.
      const clipCenter = clipBounds.getCenter(new THREE.Vector3());
      mesh.position.set(-clipCenter.x, -clipBounds.min.y, -clipCenter.z);
      if (yDown) mesh.rotation.x = Math.PI;
      // Around the circle, facing outward; the first dancer faces the camera.
      // The orbit's `front` points from the subject to its front camera.
      const facing = towardAngle + (index * 2 * Math.PI) / loaded.length;
      const orbit = (clip as { scene?: { orbit?: { front?: number[] } } }).scene?.orbit;
      const [frontX = 0, , frontZ = 1] = orbit?.front ?? [];
      const group = new THREE.Group();
      group.position.set(
        center.x + radius * Math.sin(facing),
        center.y,
        center.z + radius * Math.cos(facing),
      );
      group.rotation.y = facing - Math.atan2(frontX, frontZ);
      group.add(mesh);
      groups.push(group);
      scene.add(group);
      group.updateMatrixWorld(true);
      // Same transport as a glTF animation: one mixer per clip, looping.
      const mixer = new THREE.AnimationMixer(mesh);
      mixer.clipAction(mesh.animation).play();
      mixers.push(mixer);
    });

    if (pool) {
      const pooled = new PooledUnifiedSplatMesh(renderer, pool, {
        srgbOutput: sceneView.srgbOutput,
        sortMetric,
      });
      unifiedDraw = pooled;
      pooled.addSource(splats, { visible: true });
      // Clips rewrite fixed slots every frame: upload them as they are written,
      // and let the shared sort trail behind (it is ~0.25 s over a large scene).
      for (const mesh of meshes) pooled.addSource(mesh, { visible: true, liveContent: true });
      scene.add(pooled);
    } else if (unified) {
      const capacity = meshes.reduce((sum, mesh) => sum + mesh.capacity, splats.capacity);
      unifiedDraw = new UnifiedSplatMesh(renderer, capacity, {
        performanceProfile: splats.performanceProfile,
        srgbOutput: sceneView.srgbOutput,
        minPixelSize: sceneView.minPixelSize,
        minContribution: sceneView.minContribution,
        sortMetric,
      });
      unifiedDraw.addSource(splats, { visible: true });
      // Not cached: the unified draw re-gathers the clips every frame and
      // re-sorts on their sort-displacement revision, so the host calls nothing.
      for (const mesh of meshes) unifiedDraw.addSource(mesh, { visible: true });
      scene.add(unifiedDraw);
    } else {
      // Separate meshes do not sort against each other: draw the dancers after
      // the scene, so they are never hidden behind the floor behind them.
      for (const mesh of meshes) mesh.renderOrder = 1;
    }
  } catch (error) {
    dispose();
    throw error;
  }

  // Soundtracks (`.asog` files may carry one), heard from where each clip
  // stands once the page has had a click or key press.
  loaded.forEach(({ clip }, index) => {
    void createClipSound(clip, meshes[index]!, camera).then(
      (sound) => {
        if (!sound) return;
        if (disposed || !host.isCurrent()) sound.dispose();
        else sounds.push(sound);
      },
      (error: unknown) => {
        if (!disposed) console.warn('4DGS clip soundtrack could not be decoded', error);
      },
    );
  });

  document.body.append(banner);

  const timer = new THREE.Timer();
  return {
    unifiedDraw,
    update(): void {
      timer.update();
      const delta = timer.getDelta();
      for (const mixer of mixers) mixer.update(delta);
      for (const sound of sounds) sound.update();
      // The unified draw updates its sources itself.
      if (!unifiedDraw) for (const mesh of meshes) mesh.update(camera, renderer);
    },
    dispose,
  };
}
