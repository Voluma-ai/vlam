/**
 * `.csgs` (Faltwerk 4DGS) playback harness: a proof of concept that plays a
 * scene of `.csgs` sections through a dynamic-capacity `SplatMesh`.
 *
 * Every section is decoded once in a worker; each displayed frame is then
 * evaluated on the CPU and swapped into the pool whole (remove + append), so
 * nothing in the renderer knows about time. That is the simplest correct
 * path (depth sorting sees the true positions) and the upload cost is what a
 * modifier-based GPU evaluation would remove later.
 * Loading and the sort-gated swap live in `csgs-playback.ts`, shared with
 * the demo viewer's `4dgs` effect.
 *
 * Query parameters:
 *  - `scene=<url>`: a Faltwerk `scene_*.json` (default {@link CSGS_DEMO_SCENE}, linked)
 *  - `backend=webgpu|webgl2`
 *  - `cam=<name>`: pin the view to one of the scene's test cameras (`c00`…)
 *  - `frame=<n>`: show one frame instead of playing; writes metrics to `#result`
 *  - `scale=<f>`: canvas size relative to the test camera's resolution (default 0.5)
 *  - `sh=0`: DC color only (no higher-order SH)
 *  - `static=1`: draw the fixed frame through a plain static `SplatMesh`
 *  - `gpu=1`: evaluate the curves on the GPU (`csgs-gpu.ts`) through a
 *    `UnifiedSplatMesh`, WebGPU only; `stageBudget=<bytes>` sets how much of
 *    the next section it stages per frame
 *  - `nocanvas=1`: render only into the readback target (headless checks)
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, createWebGPURenderer } from '../lib/core';
import { UnifiedSplatMesh } from '../lib/unified';
import { CSGS_STAGE_BYTES_PER_FRAME, CsgsGpuPlaybackMesh } from './csgs-gpu';
import {
  CSGS_DEMO_SCENE,
  CsgsPlaybackMesh,
  fetchCsgsScene,
  loadCsgsClip,
  type CsgsSceneFile,
  type CsgsTestCamera,
} from './csgs-playback';

/** Thumbnail size of the reference strips (`synth/<clip>/<cam>.jpg`, one per frame). */
const THUMB = { width: 64, height: 116 } as const;

const query = new URLSearchParams(location.search);
const backend = query.get('backend') === 'webgl2' ? 'webgl2' : 'webgpu';
const sceneUrl = new URL(query.get('scene') ?? CSGS_DEMO_SCENE, location.href);
const pinnedCamera = query.get('cam');
const fixedFrame = query.has('frame') ? Number(query.get('frame')) : null;
const scale = Number(query.get('scale') ?? '0.5');
/** `sh=0` drops the higher-order SH bands (DC color only), to isolate color issues. */
const shBands = query.get('sh') === '0' ? 0 : 3;
/** `static=1` draws the fixed frame through a plain static `SplatMesh` (no dynamic pool). */
const staticMesh = query.get('static') === '1';
/** `gpu=1` plays through `CsgsGpuPlaybackMesh` in a `UnifiedSplatMesh` (WebGPU). */
const gpuPlayback = query.get('gpu') === '1';
/** `stageBudget=<bytes>`: GPU staging per frame (default `CSGS_STAGE_BYTES_PER_FRAME`). */
const stageBudget = query.has('stageBudget')
  ? Number(query.get('stageBudget'))
  : CSGS_STAGE_BYTES_PER_FRAME;
/**
 * `nocanvas=1` renders only into the readback target, never the canvas. The
 * headless browser check needs it: presenting to a canvas on the SwiftShader
 * WebGPU build used here destroys the device ("Device was destroyed"), while
 * render-target drawing and readback work. Interactive use keeps the canvas.
 */
const skipCanvas = query.get('nocanvas') === '1';

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const resultEl = document.querySelector<HTMLOutputElement>('#result')!;
const playButton = document.querySelector<HTMLButtonElement>('#play')!;
const scrub = document.querySelector<HTMLInputElement>('#scrub')!;
const frameLabel = document.querySelector<HTMLSpanElement>('#frame')!;
const referenceFigure = document.querySelector<HTMLElement>('#reference')!;
const referenceImage = document.querySelector<HTMLImageElement>('#reference-image')!;

const errors: string[] = [];
/** The step the page is in, for diagnostics. */
let stage = 'start';
window.addEventListener('error', (event) => errors.push(event.message));

function print(message: string): void {
  statusEl.textContent = message;
}

/** A three.js camera at a Faltwerk test camera's pose and intrinsics. */
function cameraFromTestCamera(testCamera: CsgsTestCamera): THREE.PerspectiveCamera {
  const { R, t, fy, w, h } = testCamera;
  const fov = (2 * Math.atan(h / (2 * fy)) * 180) / Math.PI;
  const camera = new THREE.PerspectiveCamera(fov, w / h, 0.01, 100);
  // camera→world is Rᵀ; three.js looks down -Z with +Y up where OpenCV looks
  // down +Z with -Y up, so the Y and Z basis columns flip sign.
  const basis = new THREE.Matrix4();
  // prettier-ignore
  basis.set(
    R[0]![0]!, -R[1]![0]!, -R[2]![0]!, 0,
    R[0]![1]!, -R[1]![1]!, -R[2]![1]!, 0,
    R[0]![2]!, -R[1]![2]!, -R[2]![2]!, 0,
    0, 0, 0, 1,
  );
  const position = new THREE.Vector3(
    -(R[0]![0]! * t[0]! + R[1]![0]! * t[1]! + R[2]![0]! * t[2]!),
    -(R[0]![1]! * t[0]! + R[1]![1]! * t[1]! + R[2]![1]! * t[2]!),
    -(R[0]![2]! * t[0]! + R[1]![2]! * t[1]! + R[2]![2]! * t[2]!),
  );
  camera.quaternion.setFromRotationMatrix(basis);
  camera.position.copy(position);
  camera.updateMatrixWorld(true);
  return camera;
}

function cameraFromOrbit(scene: CsgsSceneFile, aspect: number): THREE.PerspectiveCamera {
  const { center, front, up, dist, fovy_deg } = scene.orbit;
  const camera = new THREE.PerspectiveCamera(fovy_deg, aspect, 0.01, 100);
  const target = new THREE.Vector3(center[0], center[1], center[2]);
  camera.position.set(front[0]!, front[1]!, front[2]).multiplyScalar(dist).add(target);
  camera.up.set(up[0]!, up[1]!, up[2]);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  return camera;
}

/** Premultiplied RGB + coverage of one render into a transparent target. */
interface Readback {
  width: number;
  height: number;
  rgb: Float32Array;
  alpha: Float32Array;
  /** The readback as a PNG data URL (straight bytes, as the target holds them). */
  png: string;
}

/**
 * Renders into a transparent render target and reads it back. The splat
 * material blends premultiplied, so the target holds Σ premultiplied color and
 * the accumulated coverage in alpha. Headless WebGPU canvases are not reliably
 * readable through `toDataURL`, which is why the measurement bypasses the
 * canvas; the canvas keeps showing the live frame for a person.
 */
async function readFrame(
  renderer: THREE.WebGPURenderer,
  target: THREE.RenderTarget,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Promise<Readback> {
  const { width, height } = target;
  const previous = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
  } finally {
    renderer.setRenderTarget(previous);
    renderer.setClearColor(0x3a3a3a, 1);
  }
  const source = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
  // WebGPU pads readback rows to 256 bytes; the WebGL2 path returns tight rows.
  const rowBytes = width * 4;
  const stride = height > 1 ? (source.byteLength - rowBytes) / (height - 1) : rowBytes;
  if (!Number.isInteger(stride) || stride < rowBytes) {
    throw new Error('Unexpected readback row layout.');
  }
  const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  const pixels = new Uint8ClampedArray(rowBytes * height);
  // WebGL reads rows bottom-up (GL convention); WebGPU copies them top-down.
  for (let row = 0; row < height; row++) {
    const sourceRow = backend === 'webgl2' ? height - 1 - row : row;
    pixels.set(bytes.subarray(sourceRow * stride, sourceRow * stride + rowBytes), row * rowBytes);
  }
  const rgb = new Float32Array(width * height * 3);
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    alpha[i] = pixels[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = pixels[i * 4 + c]!;
  }
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const context = scratch.getContext('2d')!;
  // Straight bytes: putImageData takes un-premultiplied input, so lift the
  // premultiplied color back out for the picture only.
  const straight = new Uint8ClampedArray(pixels);
  for (let i = 0; i < width * height; i++) {
    const a = pixels[i * 4 + 3]!;
    if (a > 0 && a < 255) {
      for (let c = 0; c < 3; c++)
        straight[i * 4 + c] = Math.min(255, (pixels[i * 4 + c]! * 255) / a);
    }
  }
  context.putImageData(new ImageData(straight, width, height), 0, 0);
  return { width, height, rgb, alpha, png: scratch.toDataURL('image/png') };
}

/** Box-filters a premultiplied frame down to the reference thumbnail size. */
function downsample(frame: Readback): {
  rgb: Float32Array;
  alpha: Float32Array;
} {
  const rgb = new Float32Array(THUMB.width * THUMB.height * 3);
  const alpha = new Float32Array(THUMB.width * THUMB.height);
  const sx = frame.width / THUMB.width;
  const sy = frame.height / THUMB.height;
  for (let y = 0; y < THUMB.height; y++) {
    for (let x = 0; x < THUMB.width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = yy * frame.width + xx;
          r += frame.rgb[i * 3]!;
          g += frame.rgb[i * 3 + 1]!;
          b += frame.rgb[i * 3 + 2]!;
          a += frame.alpha[i]!;
          n++;
        }
      }
      const o = y * THUMB.width + x;
      rgb[o * 3] = r / n;
      rgb[o * 3 + 1] = g / n;
      rgb[o * 3 + 2] = b / n;
      alpha[o] = a / n;
    }
  }
  return { rgb, alpha };
}

/** One thumbnail of a reference strip as RGB bytes. */
function thumbnail(strip: HTMLImageElement, frame: number): Uint8ClampedArray {
  const scratch = document.createElement('canvas');
  scratch.width = THUMB.width;
  scratch.height = THUMB.height;
  const context = scratch.getContext('2d')!;
  context.drawImage(
    strip,
    frame * THUMB.width,
    0,
    THUMB.width,
    THUMB.height,
    0,
    0,
    THUMB.width,
    THUMB.height,
  );
  return context.getImageData(0, 0, THUMB.width, THUMB.height).data;
}

/**
 * Mean absolute RGB difference between the render composited over a reference
 * thumbnail and that thumbnail, over the pixels the render covers. Uncovered
 * pixels match trivially, so they are left out; `coverage` reports them.
 */
function compare(
  render: ReturnType<typeof downsample>,
  reference: Uint8ClampedArray,
): { meanAbsDiff: number; coverage: number } {
  let sum = 0;
  let weight = 0;
  let covered = 0;
  for (let i = 0; i < THUMB.width * THUMB.height; i++) {
    const a = render.alpha[i]!;
    if (a > 0.05) covered++;
    for (let c = 0; c < 3; c++) {
      const ref = reference[i * 4 + c]!;
      const composed = render.rgb[i * 3 + c]! + (1 - a) * ref;
      sum += a * Math.abs(composed - ref);
    }
    weight += a * 3;
  }
  return {
    meanAbsDiff: weight > 0 ? sum / weight : 0,
    coverage: covered / (THUMB.width * THUMB.height),
  };
}

async function run(): Promise<void> {
  const scene = await fetchCsgsScene(sceneUrl);
  const testCamera = pinnedCamera
    ? (scene.testcams.find((c) => c.name === pinnedCamera) ?? null)
    : null;
  if (pinnedCamera && !testCamera) throw new Error(`No test camera "${pinnedCamera}".`);
  canvas.width = Math.round((testCamera?.w ?? 704) * scale);
  canvas.height = Math.round((testCamera?.h ?? 1280) * scale);

  // The renderer comes first so the GPU device exists before the heavy fetch
  // and worker decode; it also shows the canvas while the clip loads.
  const renderer = await createWebGPURenderer({
    canvas,
    antialias: false,
    forceWebGL: backend === 'webgl2',
    requireWebGpu: backend === 'webgpu',
  });
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.setClearColor(0x3a3a3a, 1);
  await renderer.init();
  // Diagnostics: a lost device explains any later "Instance dropped" failure,
  // and the stage it was lost in says what triggered it.
  const device = (
    renderer.backend as {
      device?: {
        lost: Promise<{ reason: string; message: string }>;
        addEventListener(type: 'uncapturederror', listener: (event: unknown) => void): void;
      };
    }
  ).device;
  device?.lost.then((info) => {
    errors.push(`device lost (${info.reason}) during "${stage}": ${info.message}`);
  });
  device?.addEventListener('uncapturederror', (event) => {
    const message = (event as { error?: { message?: string } }).error?.message ?? String(event);
    errors.push(`uncaptured GPU error during "${stage}": ${message}`);
  });

  stage = 'fetch';
  const clip = await loadCsgsClip(
    sceneUrl,
    (message) => {
      if (message.startsWith('Decoding')) stage = 'decode';
      print(message);
    },
    scene,
  );
  const { totalFrames, decodeMs } = clip;
  const clipName = clip.name;
  const ready = clip.sections;
  stage = 'mesh';

  const three = new THREE.Scene();
  // The clips are already Y-up (the orbit's up vector is +Y), so the 3DGS
  // 180°-X correction must not be applied.
  if (gpuPlayback && backend !== 'webgpu') throw new Error('gpu=1 needs the WebGPU backend.');
  if (gpuPlayback && !clip.sections.every((s) => s.halfSafe)) {
    throw new Error('gpu=1: the clip has knots beyond the half-float range.');
  }
  const mesh = staticMesh
    ? new SplatMesh((await clip.evaluate(fixedFrame ?? 0)).data, {
        shBands,
        orientation: 'source',
      })
    : gpuPlayback
      ? new CsgsGpuPlaybackMesh(clip, renderer, { shBands, orientation: 'source' })
      : new CsgsPlaybackMesh(clip, { shBands, orientation: 'source' });
  three.add(mesh);
  // GPU playback moves splats in the modifier, which only the unified draw
  // sorts by; the mesh stays in the scene graph for its transform.
  const unified =
    mesh instanceof CsgsGpuPlaybackMesh ? new UnifiedSplatMesh(renderer, mesh.capacity) : null;
  if (unified) {
    unified.addSource(mesh, { visible: true, cacheModifiers: true });
    three.add(unified);
  }
  const camera = testCamera
    ? cameraFromTestCamera(testCamera)
    : cameraFromOrbit(scene, canvas.width / canvas.height);
  const controls = testCamera ? null : new OrbitControls(camera, canvas);
  if (controls) {
    const { center } = scene.orbit;
    controls.target.set(center[0]!, center[1]!, center[2]);
    controls.update();
  }

  let shownFrame = -1;
  const playback = mesh instanceof CsgsPlaybackMesh ? mesh : null;
  /** Playback counters; the static mesh shows its one frame whole. */
  const stats = () => ({
    alive:
      playback?.alive ?? (mesh instanceof CsgsGpuPlaybackMesh ? mesh.alive : mesh.activeSplatCount),
    evalMs: playback?.evalMs ?? 0,
    swapMs: playback?.swapMs ?? 0,
    heldSwaps: playback?.heldSwaps ?? 0,
  });
  let lastReadback: Readback | null = null;
  let measuring = false;
  let disposed = false;
  const target = new THREE.RenderTarget(canvas.width, canvas.height, {
    type: THREE.UnsignedByteType,
    depthBuffer: true,
  });
  target.texture.colorSpace = renderer.outputColorSpace;

  /**
   * Moves playback toward frame time `t` (see `CsgsPlaybackMesh.advance`);
   * `exact` waits for that very frame. Returns whether it is shown.
   */
  function showFrame(t: number, exact: boolean): boolean {
    const frame = Math.floor(t);
    if (mesh instanceof CsgsGpuPlaybackMesh) {
      // Seeking shows the whole frame; playing interpolates between frames.
      // A seek waits for its section without showing a held frame first: the
      // unified draw publishes frames late, and `measure` must not read one.
      if (mesh.setTime(exact ? frame : t, !exact)) unified!.invalidateSource(mesh);
      mesh.stage(stageBudget);
      if (!mesh.shows(frame)) return false;
      if (frame !== shownFrame) {
        shownFrame = frame;
        scrub.value = String(frame);
        frameLabel.textContent = `frame ${frame} / ${totalFrames - 1}`;
      }
      return true;
    }
    if (!(mesh instanceof CsgsPlaybackMesh)) {
      shownFrame = frame;
      return true;
    }
    const shown = mesh.advance(frame, exact);
    if (mesh.shownFrame !== shownFrame) {
      shownFrame = mesh.shownFrame;
      if (!stage.startsWith('measure')) stage = `frame ${shownFrame}`;
      scrub.value = String(shownFrame);
      frameLabel.textContent = `frame ${shownFrame} / ${totalFrames - 1}`;
    }
    return shown;
  }

  function render(): void {
    controls?.update();
    if (unified) unified.update(camera);
    else mesh.update(camera, renderer);
    if (skipCanvas) {
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(three, camera);
      renderer.setRenderTarget(null);
      return;
    }
    renderer.render(three, camera);
  }

  scrub.max = String(totalFrames - 1);
  let playing = fixedFrame === null;
  let time = fixedFrame ?? 0;
  playButton.textContent = playing ? 'Pause' : 'Play';
  playButton.onclick = () => {
    playing = !playing;
    playButton.textContent = playing ? 'Pause' : 'Play';
  };
  scrub.oninput = () => {
    playing = false;
    playButton.textContent = 'Play';
    time = Number(scrub.value);
  };

  let referenceStrip: HTMLImageElement | null = null;
  if (testCamera) {
    const strip = new Image();
    // Cross-origin strips must be CORS-loaded, or reading them back taints the canvas.
    strip.crossOrigin = 'anonymous';
    strip.src = new URL(`synth/${clipName}/${testCamera.name}.jpg`, sceneUrl).href;
    referenceStrip = await new Promise<HTMLImageElement | null>((resolve) => {
      strip.onload = () => resolve(strip);
      strip.onerror = () => resolve(null);
    });
    if (referenceStrip) {
      referenceFigure.hidden = false;
      referenceImage.src = referenceStrip.src;
      referenceImage.width = Math.min(1024, referenceStrip.width);
      referenceFigure.querySelector('figcaption')!.textContent =
        `reference strip ${testCamera.name} (one thumbnail per frame)`;
    }
  }

  const harness = {
    scene: { clip: clipName, fps: scene.fps, totalFrames, sections: ready.map((s) => s.count) },
    decodeMs,
    get frame() {
      return shownFrame;
    },
    get alive() {
      return stats().alive;
    },
    /** The playback mesh, for console debugging. */
    get mesh() {
      return mesh;
    },
    /** Swaps deferred because the previous frame's sort was still in flight. */
    get heldSwaps() {
      return stats().heldSwaps;
    },
    errors,
    /** Shows one frame and returns its metrics (and a reference diff when pinned to a test camera). */
    async measure(frame: number) {
      stage = `measure ${frame}`;
      // The animation loop must not render into the target while an
      // asynchronous readback of it is pending (the WebGL2 readback then never
      // completes on SwiftShader).
      measuring = true;
      playing = false;
      time = frame;
      const before = lastReadback;
      for (let wait = 0; !showFrame(frame, true) && wait < 80; wait++) {
        render();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      render();
      // A unified draw keeps its last publication on screen until the new
      // gather's sort lands (slow on SwiftShader); wait until it shows the
      // current sources rather than reading a stale frame.
      for (
        let wait = 0;
        unified && !unified.getDrawPublicationSnapshot().ready && wait < 200;
        wait++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        render();
      }
      // The worker sort (WebGL2, or `sortStrategy: 'worker'`) keeps the last
      // published frame visible until the new snapshot lands, and draws
      // nothing before the first one; keep rendering until the pixels differ
      // from the previous measurement and are not empty.
      let read = await readFrame(renderer, target, three, camera);
      const unchanged = (): boolean =>
        !read.alpha.some((a) => a > 0) ||
        (before !== null && before.alpha.every((a, i) => a === read.alpha[i]));
      let attempts = 0;
      for (; attempts < 80 && unchanged(); attempts++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        render();
        read = await readFrame(renderer, target, three, camera);
      }
      // GPU playback on SwiftShader lands its new section a few frames after
      // the publication reports ready; the seeked frame is static, so read
      // until two readbacks agree.
      for (let settle = 0; unified && settle < 40; settle++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        render();
        const next = await readFrame(renderer, target, three, camera);
        const settled = next.rgb.every((value, i) => value === read.rgb[i]);
        read = next;
        if (settled) break;
      }
      lastReadback = read;
      const small = downsample(read);
      let coverage = 0;
      for (const a of read.alpha) if (a > 0.05) coverage++;
      coverage /= read.alpha.length;
      let reference: { meanAbsDiff: number; coverage: number; otherPoseAbsDiff: number } | null =
        null;
      if (referenceStrip) {
        const matching = compare(small, thumbnail(referenceStrip, frame));
        const other = compare(
          small,
          thumbnail(referenceStrip, (frame + Math.floor(totalFrames / 2)) % totalFrames),
        );
        reference = { ...matching, otherPoseAbsDiff: other.meanAbsDiff };
      }
      render();
      measuring = false;
      return {
        backend,
        frame,
        ...stats(),
        coverage,
        reference,
        width: read.width,
        height: read.height,
        shBands: mesh.shBands,
        attempts,
        activeSplatCount: mesh.activeSplatCount,
      };
    },
    /**
     * Stops the animation loop and releases the GPU resources. The headless
     * check calls it before closing the page: a SwiftShader GPU process still
     * tearing down this page's pool and sort buffers stalls the next page's
     * adapter request past its deadline.
     */
    dispose(): void {
      disposed = true;
      unified?.dispose();
      mesh.dispose();
      clip.dispose();
      target.dispose();
      renderer.dispose();
    },
    /** PNG data URL of the last measured readback. */
    get readbackPng() {
      return lastReadback?.png ?? null;
    },
    capture(): string {
      render();
      return canvas.toDataURL('image/png');
    },
  };
  Object.assign(window, { __csgsHarness: harness });

  let last = performance.now();
  const loop = (): void => {
    if (disposed) return;
    if (measuring) {
      requestAnimationFrame(loop);
      return;
    }
    const now = performance.now();
    if (playing) {
      time = (time + ((now - last) / 1000) * scene.fps) % totalFrames;
    }
    last = now;
    showFrame(time, !playing);
    render();
    print(
      `${clipName}: ${stats().alive} alive of ${ready.map((s) => s.count).join('/')} · ` +
        `eval ${stats().evalMs.toFixed(1)} ms · swap ${stats().swapMs.toFixed(1)} ms · ` +
        `held swaps ${stats().heldSwaps} · decode ${decodeMs.map((ms) => ms.toFixed(0)).join('/')} ms · ${backend}`,
    );
    requestAnimationFrame(loop);
  };

  if (fixedFrame !== null) {
    const metrics = await harness.measure(fixedFrame);
    resultEl.textContent = JSON.stringify({ ...metrics, errors, decodeMs });
  }
  requestAnimationFrame(loop);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  errors.push(message);
  print(`Error: ${message}`);
  resultEl.textContent = JSON.stringify({ error: message, errors });
});
