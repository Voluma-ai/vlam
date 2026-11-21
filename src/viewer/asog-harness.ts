/**
 * `.asog` (Animated SOG) playback harness: plays a clip through
 * `SplatClipMesh` (`@voluma/vlam/dynamic`), its `time` driven by an
 * `AnimationMixer`, and measures single frames so the GPU path can be held
 * against the frame path.
 *
 * Query parameters:
 *  - `src=<url>`: an `.asog` file (default: a synthetic clip made in the page
 *    by `src/tools/asog/encode-asog.ts`; no download)
 *  - `backend=webgpu|webgl2`
 *  - `playback=auto|gpu|frames`: `SplatClipMesh`'s path (default `auto`)
 *  - `frame=<n>`: show one frame instead of playing; writes metrics to `#result`
 *  - `size=<px>`: canvas size (default 768)
 *  - `sh=0`: DC colour only
 *  - `flip=0`: keep the file's y-down frame (default: turn it 180° about X)
 *  - `orbit=<deg/s>`: circle the camera while playing (default 0)
 *  - `sort=exact`: the stable float32-depth GPU radix sort (WebGPU), to tell
 *    depth-order flips between near-equal splats apart from real differences
 *  - `unified=1`: draw the clip through a `UnifiedSplatMesh` (WebGPU), which
 *    sorts its gathered, moved centres instead of the mesh's own sort
 *  - `nocanvas=1`: render only into the readback target (headless checks)
 *  - `bg=<hex>`: background colour (default 202020)
 *  - `srgb=1`: blend the stored sRGB colours as they are (`srgbOutput`, the
 *    renderer's output conversion off), as 3DGS training and the reference
 *    players do; default: VLAM's linear blending
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createWebGPURenderer } from '../lib/core';
import { SplatClipMesh, loadAsogClip, type AsogClip } from '../lib/dynamic';
import { exactSort } from '../lib/sorting/radix';
import { UnifiedSplatMesh } from '../lib/unified';
import { syntheticAsog } from '../tools/asog/encode-asog';

/** Thumbnail size the GPU/frame comparison reads. */
const THUMB = { width: 96, height: 96 } as const;

const query = new URLSearchParams(location.search);
const backend = query.get('backend') === 'webgl2' ? 'webgl2' : 'webgpu';
const src = query.get('src');
const fixedFrame = query.has('frame') ? Number(query.get('frame')) : null;
const size = Number(query.get('size') ?? '768');
const shBands = query.get('sh') === '0' ? 0 : undefined;
const flip = query.get('flip') !== '0';
const orbitSpeed = Number(query.get('orbit') ?? '0');
const playbackParam = query.get('playback');
const playback = playbackParam === 'gpu' || playbackParam === 'frames' ? playbackParam : 'auto';
const skipCanvas = query.get('nocanvas') === '1';
const exact = query.get('sort') === 'exact';
const unifiedDraw = query.get('unified') === '1';
const background = parseInt(query.get('bg') ?? '202020', 16);
const srgbBlend = query.get('srgb') === '1';

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const resultEl = document.querySelector<HTMLOutputElement>('#result')!;
const playButton = document.querySelector<HTMLButtonElement>('#play')!;
const scrub = document.querySelector<HTMLInputElement>('#scrub')!;
const speedSelect = document.querySelector<HTMLSelectElement>('#speed')!;
const frameLabel = document.querySelector<HTMLSpanElement>('#frame')!;

const errors: string[] = [];
window.addEventListener('error', (event) => errors.push(event.message));
const print = (message: string): void => void (statusEl.textContent = message);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Readback {
  width: number;
  height: number;
  rgb: Float32Array;
  alpha: Float32Array;
  png: string;
}

/**
 * Renders into a transparent render target and reads it back (premultiplied
 * colour, coverage in alpha), as `csgs-harness.ts` does.
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
    renderer.setClearColor(background, 1);
  }
  const source = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
  const rowBytes = width * 4;
  const stride = height > 1 ? (source.byteLength - rowBytes) / (height - 1) : rowBytes;
  const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  const pixels = new Uint8ClampedArray(rowBytes * height);
  for (let row = 0; row < height; row++) {
    const sourceRow = backend === 'webgl2' ? height - 1 - row : row;
    pixels.set(bytes.subarray(sourceRow * stride, sourceRow * stride + rowBytes), row * rowBytes);
  }
  const rgb = new Float32Array(width * height * 3);
  const alpha = new Float32Array(width * height);
  const straight = new Uint8ClampedArray(pixels);
  for (let i = 0; i < width * height; i++) {
    const a = pixels[i * 4 + 3]!;
    alpha[i] = a / 255;
    for (let c = 0; c < 3; c++) {
      rgb[i * 3 + c] = pixels[i * 4 + c]!;
      if (a > 0 && a < 255) straight[i * 4 + c] = Math.min(255, (pixels[i * 4 + c]! * 255) / a);
    }
  }
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  scratch.getContext('2d')!.putImageData(new ImageData(straight, width, height), 0, 0);
  return { width, height, rgb, alpha, png: scratch.toDataURL('image/png') };
}

/** Box-filters a premultiplied frame down to the thumbnail size. */
function downsample(frame: Readback): { rgb: number[]; alpha: number[] } {
  const rgb: number[] = [];
  const alpha: number[] = [];
  const sx = frame.width / THUMB.width;
  const sy = frame.height / THUMB.height;
  for (let y = 0; y < THUMB.height; y++) {
    for (let x = 0; x < THUMB.width; x++) {
      const sum = [0, 0, 0, 0];
      let n = 0;
      for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy++) {
        for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx++) {
          const i = yy * frame.width + xx;
          for (let c = 0; c < 3; c++) sum[c]! += frame.rgb[i * 3 + c]!;
          sum[3]! += frame.alpha[i]!;
          n++;
        }
      }
      for (let c = 0; c < 3; c++) rgb.push(Math.round(sum[c]! / Math.max(n, 1)));
      alpha.push(sum[3]! / Math.max(n, 1));
    }
  }
  return { rgb, alpha };
}

async function run(): Promise<void> {
  canvas.width = size;
  canvas.height = size;
  const renderer = await createWebGPURenderer({
    canvas,
    antialias: false,
    forceWebGL: backend === 'webgl2',
    requireWebGpu: backend === 'webgpu',
  });
  renderer.setSize(size, size, false);
  renderer.setClearColor(background, 1);
  // `srgbOutput` emits sRGB values as they are: the renderer must not encode again.
  if (srgbBlend) renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  await renderer.init();

  const loadStarted = performance.now();
  const clip: AsogClip = src
    ? await loadAsogClip(src, { onProgress: ({ message }) => print(message) })
    : await loadAsogClip('synthetic.asog', {
        bytes: (await syntheticAsog({ count: 20000, duration: 2, fps: 30, coeffs: 8 }))
          .buffer as ArrayBuffer,
      });
  const loadMs = performance.now() - loadStarted;

  const scene = new THREE.Scene();
  const mesh = new SplatClipMesh(clip, {
    renderer,
    playback,
    ...(srgbBlend ? { srgbOutput: true } : {}),
    ...(shBands !== undefined ? { shBands } : {}),
    ...(exact ? { sortStrategy: exactSort() } : {}),
  });
  // Fetch start → the first frame on screen (the time a viewer waits).
  let firstShownMs = Number.NaN;
  void mesh.whenShown().then(
    () => (firstShownMs = performance.now() - loadStarted),
    () => undefined,
  );
  mesh.addEventListener('error', ({ error }) => {
    errors.push(`playback error: ${error instanceof Error ? error.message : String(error)}`);
  });
  // .asog is y down (TRiGS/COLMAP); VLAM stands such captures up by 180° about X.
  if (flip) mesh.rotation.x = Math.PI;
  scene.add(mesh);
  mesh.updateMatrixWorld(true);
  if (unifiedDraw && backend !== 'webgpu') throw new Error('unified=1 needs the WebGPU backend.');
  // The mesh stays in the scene graph for its transform; the unified draw updates it.
  const unified = unifiedDraw ? new UnifiedSplatMesh(renderer, mesh.capacity) : null;
  if (unified) {
    unified.addSource(mesh, { visible: true });
    scene.add(unified);
  }

  // Frame most of the subject: the 2nd to 98th percentile of the first frame's
  // centres (captures carry stray splats far out, which the clip bounds hold).
  const first = await clip.frame(0);
  const box = new THREE.Box3();
  if (first.count > 0) {
    const low = new THREE.Vector3();
    const high = new THREE.Vector3();
    for (let c = 0; c < 3; c++) {
      const axis = Array.from({ length: first.count }, (_, i) => first.positions[i * 3 + c]!).sort(
        (a, b) => a - b,
      );
      low.setComponent(c, axis[Math.floor(0.02 * (axis.length - 1))]!);
      high.setComponent(c, axis[Math.ceil(0.98 * (axis.length - 1))]!);
    }
    box.set(low, high).applyMatrix4(mesh.matrixWorld);
  } else {
    box.copy(clip.bounds).applyMatrix4(mesh.matrixWorld);
  }
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
  const camera = new THREE.PerspectiveCamera(40, 1, radius / 100, radius * 100);
  camera.position.copy(center).add(new THREE.Vector3(0, radius * 0.15, radius * 3.2));
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
  controls.update();

  const mixer = new THREE.AnimationMixer(mesh);
  const action = mixer.clipAction(mesh.animation);
  action.play();
  if (fixedFrame !== null) action.paused = true;
  scrub.max = String(clip.duration);
  playButton.addEventListener('click', () => {
    action.paused = !action.paused;
    playButton.textContent = action.paused ? 'Play' : 'Pause';
  });
  scrub.addEventListener('input', () => {
    action.time = Number(scrub.value);
    mixer.update(0);
  });
  speedSelect.addEventListener('change', () => (action.timeScale = Number(speedSelect.value)));

  const target = new THREE.RenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    depthBuffer: true,
  });
  target.texture.colorSpace = renderer.outputColorSpace;
  let measuring = false;
  let disposed = false;
  let lastReadback: Readback | null = null;
  /** Frame `lastReadback` shows, or null before the first measurement. */
  let lastMeasuredFrame: number | null = null;

  function render(): void {
    controls.update();
    if (unified) unified.update(camera);
    else mesh.update(camera, renderer);
    if (skipCanvas) {
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      return;
    }
    renderer.render(scene, camera);
  }

  async function showFrame(frame: number): Promise<boolean> {
    action.paused = true;
    action.time = frame / clip.fps;
    mixer.update(0);
    let shown = false;
    void mesh.whenShown().then(
      () => (shown = true),
      () => undefined,
    );
    for (let wait = 0; !shown && wait < 400; wait++) {
      render();
      await sleep(25);
    }
    return shown;
  }

  const harness = {
    playback: mesh.playback,
    errors,
    clip: {
      name: clip.name,
      count: clip.maxCount,
      fps: clip.fps,
      totalFrames: clip.totalFrames,
      shBands: clip.shBands,
      decodeMs: clip.decodeMs,
      loadMs,
      get firstShownMs() {
        return firstShownMs;
      },
    },
    get mesh() {
      return mesh;
    },
    get action() {
      return action;
    },
    camera,
    /** For side-by-side captures: set `controls.target` with the camera. */
    controls,
    renderer,
    /** Shows integer frame `frame`, waits for the sort to settle, and measures it. */
    async measure(frame: number) {
      measuring = true;
      // The frame already measured (the page's own `?frame=`): time does not
      // move, so neither a new order nor a changed picture will come; waiting
      // for them would only run out the waits below.
      const moved = frame !== lastMeasuredFrame;
      const orderBefore = unified?.getDrawPublicationSnapshot().orderRevision ?? 0;
      const shownInTime = await showFrame(frame);
      // A unified draw re-sorts its gathered centres when the clip's time
      // moves: wait for an order newer than the one before the change, and for
      // it to be the one on screen.
      for (let wait = 0; unified && wait < 400; wait++) {
        if (!moved && unified.getDrawPublicationSnapshot().ready) break;
        const snapshot = unified.getDrawPublicationSnapshot();
        if (snapshot.ready && snapshot.orderRevision > orderBefore) break;
        render();
        await sleep(10);
      }
      // On the GPU path a time change re-sorts at the sort cadence, not at
      // once, so readbacks can agree before the order reflects the new time.
      // Wait until the mesh's order is built from the current displacement.
      const sortState = mesh as unknown as {
        sortDisplacementRevision: number;
        sortedDisplacementRevision: number;
      };
      for (
        let wait = 0;
        !unified &&
        wait < 400 &&
        sortState.sortedDisplacementRevision !== sortState.sortDisplacementRevision;
        wait++
      ) {
        render();
        await sleep(10);
      }
      const before = lastReadback;
      let read = await readFrame(renderer, target, scene, camera);
      const unchanged = (): boolean =>
        !read.alpha.some((a) => a > 0) ||
        (moved && before !== null && before.alpha.every((a, i) => a === read.alpha[i]));
      for (let attempt = 0; attempt < 80 && unchanged(); attempt++) {
        await sleep(25);
        render();
        read = await readFrame(renderer, target, scene, camera);
      }
      for (let settle = 0; settle < 40; settle++) {
        await sleep(25);
        render();
        const next = await readFrame(renderer, target, scene, camera);
        const settled = next.rgb.every((value, i) => value === read.rgb[i]);
        read = next;
        if (settled) break;
      }
      lastReadback = read;
      lastMeasuredFrame = frame;
      let coverage = 0;
      for (const a of read.alpha) if (a > 0.05) coverage++;
      measuring = false;
      return {
        backend,
        playback: mesh.playback,
        unified: unified !== null,
        frame,
        shownFrame: mesh.shownFrame,
        shownInTime,
        alive: mesh.alive,
        coverage: coverage / read.alpha.length,
        evalMs: mesh.playbackStats.evalMs,
        thumb: downsample(read),
      };
    },
    get readbackPng() {
      return lastReadback?.png ?? null;
    },
    dispose(): void {
      disposed = true;
      unified?.dispose();
      mesh.dispose();
      clip.dispose();
      target.dispose();
      renderer.dispose();
    },
  };
  Object.assign(window, { __asogHarness: harness });

  const timer = new THREE.Timer();
  const loop = (): void => {
    if (disposed) return;
    timer.update();
    const delta = timer.getDelta();
    if (!measuring) {
      mixer.update(delta);
      if (orbitSpeed && !action.paused) {
        camera.position
          .sub(center)
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), (orbitSpeed * Math.PI * delta) / 180)
          .add(center);
      }
      render();
      scrub.value = String(action.time);
      frameLabel.textContent = `frame ${mesh.shownFrame} / ${clip.totalFrames}`;
      print(
        `${clip.name}: ${mesh.alive} alive of ${clip.maxCount} · ${mesh.playback} · ` +
          `eval ${(mesh.playbackStats.evalMs ?? 0).toFixed(1)} ms · decode ${clip.decodeMs.toFixed(0)} ms · ` +
          `load ${loadMs.toFixed(0)} ms · first shown ${firstShownMs.toFixed(0)} ms · ${backend}`,
      );
    }
    requestAnimationFrame(loop);
  };

  if (fixedFrame !== null) {
    const { thumb: _thumb, ...metrics } = await harness.measure(fixedFrame);
    resultEl.textContent = JSON.stringify({ ...metrics, clip: harness.clip, errors });
  }
  requestAnimationFrame(loop);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  errors.push(message);
  print(`Error: ${message}`);
  resultEl.textContent = JSON.stringify({ error: message, errors });
});
