/**
 * On-screen performance panel for on-device testing (`?hud=1`).
 *
 * This exists because the numbers were otherwise unreachable on the devices that
 * need them most. The frame benchmark writes JSON into a `hidden` `<pre>` and
 * `console.info`, both of which require a tethered inspector ÔÇö and on Windows
 * there is no Safari remote inspector for an iPhone at all. Anything measured on
 * that device has to be legible on its own screen.
 *
 * The panel is deliberately plain text at a readable size, with no charts: it is
 * read by eye, often outdoors, while dragging the scene around with one hand.
 */

/** One frame's worth of state for the panel. */
export interface PerfHudSample {
  /** CPU time from animation callback entry through render submission. */
  cpuFrameMs?: number;
  /** Splats currently drawn. */
  activeSplats: number;
  /** The budget those splats are drawn against. */
  budget: number;
  /** Resident streamed chunks, when the mesh streams. */
  chunks?: number;
  /** Spherical-harmonic bands the mesh renders. */
  shBands: number;
  /** Applied renderer pixel ratio. */
  pixelRatio: number;
  /** `WebGPU` or `WebGL2`. */
  backend: string;
  /** Physical drawing-buffer dimensions after DPR is applied. */
  physicalSize?: { width: number; height: number };
  /** Accepted depth-sort cadence and age, when a WebGPU sorter exists. */
  sort?: { hz: number; ageMs: number };
  /** GPU compute-pass milliseconds, when `?gpuTimestamps=1` is on. */
  computeGpuMs?: number | undefined;
  /** GPU render-pass milliseconds, when `?gpuTimestamps=1` is on. */
  renderGpuMs?: number | undefined;
  /**
   * Worst page-table plan application seen so far, in milliseconds
   * (`StreamedSplatMesh.planTimings.worstApplyMs`).
   *
   * Applying a plan runs off the render loop's own timing, so it never shows up
   * in `frameMs` attribution even though it lands on the same thread. On a
   * foveated `.rad` a churning frontier can make it the largest stall in a
   * frame, which is exactly the shape a bad 1% low takes.
   */
  worstPlanApplyMs?: number | undefined;
  /** Worst per-update CPU cost by stage, as monotonic maxima. */
  worstUpdate?:
    { cpuMs: number; uploadMs: number; sortSubmitMs: number; activeListMs: number } | undefined;
  /**
   * What the LOD scheduler asked for (`StreamedSplatMesh.lodStats`), which the
   * resident count alone cannot distinguish from what the mesh managed to draw.
   */
  lodStats?: { inFrustum: number; leaves: number; desired: number; filled: number } | undefined;
  /**
   * Lifetime chunk-fetch totals by kind plus cache state
   * (`StreamedSplatMesh.fetchCounts`) ÔÇö what tells a scene that is still
   * converging apart from one that is thrashing its cache.
   */
  fetchCounts?:
    | {
        priority: number;
        base: number;
        sweep: number;
        evicted: number;
        uncovered: number;
        retiredEarly: number;
        cacheFull: boolean;
        cacheBytes: number;
        cacheLimitBytes: number;
      }
    | undefined;
  /**
   * The device signals `resolveSplatBudget` chose from
   * ({@link detectSplatDeviceProfile}).
   *
   * Shown because a surprising budget is otherwise unattributable on a device
   * with no reachable console: the tiers key off `navigator.deviceMemory`, which
   * some Android builds simply do not expose ÔÇö and when it is missing the
   * low-power tier cannot fire at all, which looks identical to the tier being
   * wrong.
   */
  device?:
    | {
        memoryGb?: number | undefined;
        mobile: boolean;
        lowPower: boolean;
        gpuClass?: string | undefined;
      }
    | undefined;
}

/** Ten seconds at 60 Hz: enough for a meaningful slowest-one-percent cohort. */
const WINDOW_FRAMES = 600;
/** Repaint interval. Fast enough to feel live, slow enough to read. */
const REPAINT_MS = 250;

/**
 * Builds the panel. The caller appends {@link PerfHud.element} and calls
 * {@link PerfHud.record} once per frame; painting throttles itself.
 */
export interface PerfHud {
  readonly element: HTMLElement;
  record(sample: PerfHudSample, nowMs: number): void;
  /** Clears timing history after visibility, XR, scene, or resize discontinuities. */
  reset(): void;
}

export function createPerfHud(): PerfHud {
  const element = document.createElement('div');
  element.id = 'perf-hud';
  Object.assign(element.style, {
    position: 'fixed',
    // Below the home logo, and Enter VR when XR is available. The panel is
    // opaque and would otherwise bury those controls, which an A/B run needs.
    top: document.getElementById('enter-vr') ? '86px' : '52px',
    left: '12px',
    zIndex: '20',
    padding: '8px 10px',
    borderRadius: '8px',
    background: 'rgba(0, 0, 0, 0.72)',
    color: '#fff',
    font: '600 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    whiteSpace: 'pre',
    pointerEvents: 'none',
    // A phone is the point of this panel, and a phone renders it over the
    // scene: without this it inherits the page's text rendering and washes out
    // against bright captures.
    textShadow: '0 1px 2px rgba(0, 0, 0, 0.9)',
  } satisfies Partial<CSSStyleDeclaration>);

  const frames: number[] = [];
  let paintedAt = 0;
  let previousAt: number | undefined;

  return {
    element,
    record(sample: PerfHudSample, nowMs: number): void {
      // Measure the animation-loop clock directly. THREE.Timer is intentionally
      // used for control motion, but it is not an independent presentation
      // clock and can be reset/scaled by its owner.
      const frameMs = previousAt === undefined ? undefined : nowMs - previousAt;
      previousAt = nowMs;
      if (frameMs !== undefined && Number.isFinite(frameMs) && frameMs > 0) {
        frames.push(frameMs);
        if (frames.length > WINDOW_FRAMES) frames.shift();
      }
      if (nowMs - paintedAt < REPAINT_MS) return;
      paintedAt = nowMs;
      element.textContent = formatHud(sample, frames);
    },
    reset(): void {
      frames.length = 0;
      previousAt = undefined;
      paintedAt = 0;
    },
  };
}

/**
 * Renders the panel text.
 *
 * Reports the **p99 frame FPS** beside callback cadence because a splat scene's problem is
 * rarely its average: swaps and sorts land as isolated long frames that a mean
 * hides completely, and those are what read as stutter.
 *
 * Exported for unit testing: the panel's DOM half needs a browser (and the
 * browser pane cannot paint it ÔÇö its tab stays hidden, so rAF never fires), but
 * the formatting is pure and is where a wrong number would mislead a whole
 * measurement session.
 */
export function formatHud(sample: PerfHudSample, frames: readonly number[]): string {
  const lines: string[] = [];
  if (frames.length > 0) {
    const sorted = [...frames].sort((a, b) => a - b);
    const mean = frames.reduce((total, ms) => total + ms, 0) / frames.length;
    const percentile = (fraction: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] as number;
    const p95Ms = percentile(0.95);
    const p99Ms = percentile(0.99);
    // The fastest stable deltas approximate the display interval without a
    // device-name table. A callback gap of >1.5 intervals missed at least one
    // rAF opportunity; this still does not claim physical scan-out.
    const refreshMs = percentile(0.1);
    const missed = frames.reduce(
      (total, ms) => total + Math.max(0, Math.round(ms / refreshMs) - 1),
      0,
    );
    lines.push(
      `${fps(mean).padStart(5)} rAF  ${mean.toFixed(1).padStart(5)} ms` +
        `   p99 ${fps(p99Ms)} fps`,
    );
    lines.push(`frame p95 ${p95Ms.toFixed(1)}  p99 ${p99Ms.toFixed(1)} ms  missed ${missed}`);
  } else {
    lines.push('  ÔÇö   rAF');
  }

  if (sample.cpuFrameMs !== undefined) lines.push(`cpu submit ${sample.cpuFrameMs.toFixed(1)} ms`);
  if (sample.sort) {
    lines.push(`sort ${sample.sort.hz.toFixed(1)} Hz  age ${sample.sort.ageMs.toFixed(0)} ms`);
  }

  if (sample.computeGpuMs !== undefined || sample.renderGpuMs !== undefined) {
    // The measurement the whole exercise turns on: render-heavy means
    // fill/overdraw-bound, compute-heavy means sort- or gather-bound. They want
    // completely different fixes.
    const compute = sample.computeGpuMs?.toFixed(2) ?? 'ÔÇö';
    const render = sample.renderGpuMs?.toFixed(2) ?? 'ÔÇö';
    lines.push(`gpu  compute ${compute} ms  render ${render} ms`);
  } else if (sample.backend !== 'WebGPU') {
    // Timestamp queries are a WebGPU feature. Telling a WebGL2 device to "add
    // ?gpuTimestamps=1" sends the reader chasing a flag that can never help.
    lines.push('gpu  (timestamps need WebGPU)');
  } else {
    lines.push('gpu  (add ?gpuTimestamps=1)');
  }

  // The stall block. Every figure here is a *monotonic maximum*, deliberately:
  // a half-second freeze that happened once while the camera swung is the whole
  // problem, and it is exactly what a mean or a short rolling window loses. Read
  // them against `worst frame` ÔÇö whichever stage is close to it is the stall,
  // and the ones far below it are ruled out.
  if (frames.length > 0) {
    const worstFrameMs = Math.max(...frames);
    lines.push(`worst frame ${worstFrameMs.toFixed(0)} ms  (window)`);
  }
  if (sample.worstPlanApplyMs !== undefined && sample.worstPlanApplyMs > 0) {
    // Shown only once a page table has actually applied a plan, so a static or
    // prefix-read scene does not carry a permanent "0.00" line.
    lines.push(`worst plan apply ${sample.worstPlanApplyMs.toFixed(1)} ms`);
  }
  const worst = sample.worstUpdate;
  if (worst && worst.cpuMs > 0) {
    lines.push(
      `worst cpu ${worst.cpuMs.toFixed(1)}  up ${worst.uploadMs.toFixed(1)}` +
        `  sort ${worst.sortSubmitMs.toFixed(1)}  list ${worst.activeListMs.toFixed(1)} ms`,
    );
  }

  const fetches = sample.fetchCounts;
  if (fetches) {
    // Reads as a diagnosis, not a statistic: `sweep` climbing means speculative
    // pre-warming, `evicted` climbing alongside `pri`/`base` means the cut does
    // not fit the cache and is refetching what it just dropped, and `pri`/`base`
    // climbing with `evicted` flat is ordinary convergence that will stop.
    lines.push(
      `fetch pri ${fetches.priority}  base ${fetches.base}  sweep ${fetches.sweep}` +
        `  evict ${fetches.evicted}${fetches.cacheFull ? ' FULL' : ''}`,
    );
    // Why there are holes, which the counters above cannot distinguish: `hole`
    // is a leaf the coarse substitute could not cover, `late` is coverage
    // retired before its replacement landed. Both should stay flat once a scene
    // has settled; either climbing localizes a hole to one of the two paths.
    lines.push(`hole ${fetches.uncovered}  late ${fetches.retiredEarly}`);
    // The cap actually in effect, and how close the decoded-chunk cache came to
    // it. A limit far below what the cut needs is the difference between "the
    // scheduler asked for too much" and "the mesh was not allowed to keep it".
    if (fetches.cacheLimitBytes > 0) {
      const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(0);
      lines.push(`cache ${mib(fetches.cacheBytes)}/${mib(fetches.cacheLimitBytes)} MiB`);
    }
  }

  const lod = sample.lodStats;
  if (lod) {
    // `want` well below the budget means the *scheduler* left it unspent, which
    // is a different fault from the mesh failing to apply the cut it was given;
    // `fill` says whether the refinement pass contributed anything, and `view`
    // whether it had any candidates to work with - it only promotes in-frustum
    // leaves, so a frustum test that rejects everything silently disables it.
    lines.push(
      `want ${lod.desired.toLocaleString('en-US')}  fill ${lod.filled.toLocaleString('en-US')}` +
        `  view ${lod.inFrustum}/${lod.leaves}`,
    );
  }

  lines.push(
    `${sample.activeSplats.toLocaleString('en-US')} / ${sample.budget.toLocaleString('en-US')} splats` +
      (sample.chunks === undefined ? '' : `  ${sample.chunks} chunks`),
  );
  lines.push(
    `SH ${sample.shBands === 0 ? 'off' : sample.shBands}  ` +
      `dpr ${sample.pixelRatio}  ${sample.backend}`,
  );
  if (sample.physicalSize) {
    lines.push(`buffer ${sample.physicalSize.width}×${sample.physicalSize.height}`);
  }
  const device = sample.device;
  if (device) {
    // The signals the budget was actually chosen from. `resolveSplatBudget`
    // reads them and nothing downstream records which branch it took, so a
    // surprising budget is otherwise unattributable on a device with no console
    // ÔÇö and `deviceMemory` is genuinely absent on some Android builds, which
    // silently disables the low-power tier that depends on it.
    lines.push(
      `mem ${device.memoryGb ?? '-'}  ` +
        `${device.mobile ? 'mobile' : 'desktop'}` +
        `${device.lowPower ? ' low-power' : ''}` +
        `${device.gpuClass ? ` ${device.gpuClass}` : ''}`,
    );
  }
  return lines.join('\n');
}

/** Frames per second from a frame time, guarding the zero-length window. */
function fps(frameMs: number): string {
  return frameMs > 0 ? (1000 / frameMs).toFixed(0) : 'ÔÇö';
}
