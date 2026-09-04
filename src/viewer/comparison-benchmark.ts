import { PerspectiveCamera } from 'three';
import { RenderBenchmarkSession } from './render-benchmark-session';
import {
  applyComparisonCamera,
  comparisonConfig,
  comparisonSuite,
  comparisonUrl,
  summarize,
  type ComparisonPose,
} from './comparison-config';
import type { ComparisonAdapter } from './comparison-adapter';

interface Manifest {
  source: string;
  sha256: string;
  bytes: number;
  count: number;
  shBands: number;
  camera: ComparisonPose;
}
const params = new URLSearchParams(location.search);
const status = document.querySelector<HTMLElement>('#status')!;
const results = document.querySelector<HTMLElement>('#results')!;
const view = document.querySelector<HTMLElement>('#view')!;
const links = document.querySelector<HTMLElement>('#links')!;

function download(name: string, href: string): void {
  const link = document.createElement('a');
  link.download = name;
  link.href = href;
  link.click();
}

function suiteUrl(step: number): string {
  const run = comparisonSuite()[step]!;
  const query = new URLSearchParams(params);
  for (const key of ['engine', 'preset', 'mode', 'repeat', 'probe', 'sh', 'width', 'height'])
    query.delete(key);
  run.forEach((value, key) => query.set(key, value));
  query.set('suite', '1');
  query.set('step', String(step));
  query.set('suiteId', params.get('suiteId') ?? crypto.randomUUID());
  return `/${run.get('engine')}-benchmark.html?${query}`;
}

async function run(): Promise<void> {
  if (params.get('suite') === '1' && !params.has('step')) {
    location.replace(suiteUrl(0));
    return;
  }
  const config = comparisonConfig(location.pathname, params);
  document.title = `${config.engine.toUpperCase()} | ${config.scene} benchmark`;
  const response = await fetch(`/benchmark-assets/${config.scene}.json`);
  if (!response.ok) throw new Error('Scene cache is missing. Run npm run benchmark:cache first.');
  const manifest = (await response.json()) as Manifest;
  const environmentResponse = await fetch('/__benchmark/environment');
  if (!environmentResponse.ok)
    throw new Error('Benchmark requires the repository development server.');
  const environment: unknown = await environmentResponse.json();
  const pose =
    config.position && config.target
      ? { position: config.position, target: config.target }
      : manifest.camera;
  for (const engine of ['spark', 'vlam'] as const) {
    const link = document.createElement('a');
    link.textContent = `Open ${engine.toUpperCase()} at this camera`;
    const standalone = new URLSearchParams(params);
    standalone.delete('suite');
    standalone.delete('step');
    standalone.delete('suiteId');
    standalone.delete('engine');
    link.href = comparisonUrl(engine, standalone, pose);
    links.append(link);
  }
  const suite = document.querySelector<HTMLButtonElement>('#suite')!;
  suite.onclick = () => {
    const url = new URL(suiteUrl(0), location.href);
    url.searchParams.set('suiteId', crypto.randomUUID());
    location.href = url.href;
  };
  const step = Number(params.get('step') ?? 0);
  if (!Number.isInteger(step) || step < 0 || step >= comparisonSuite().length)
    throw new Error('Invalid suite step.');
  const suiteLabel =
    params.get('suite') === '1' ? `Run ${step + 1}/${comparisonSuite().length}: ` : '';
  status.textContent = `${suiteLabel}Loading ${config.engine.toUpperCase()} — ${manifest.count.toLocaleString()} splats…`;
  const camera = new PerspectiveCamera(45, config.width / config.height, 0.01, 10000);
  applyComparisonCamera(camera, pose, 0, false);
  let adapter: ComparisonAdapter | undefined;
  try {
    adapter =
      config.engine === 'spark'
        ? await (
            await import('./comparison-spark')
          ).createComparisonSpark(config, `/benchmark-assets/${config.scene}.sog`)
        : await (
            await import('./comparison-vlam')
          ).createComparisonVlam(config, `/benchmark-assets/${config.scene}.sog`);
    const active = adapter;
    view.replaceChildren(active.canvas);
    status.textContent = `${suiteLabel}Waiting for the initial sort…`;
    await active.settle(camera);
    const session = new RenderBenchmarkSession(config.warmup * 1000, config.seconds * 1000);
    const cpu: number[] = [],
      draws: number[] = [],
      activeCounts: number[] = [];
    let frame = 0;
    let diagnosticStart: Record<string, unknown> | undefined;
    const dispatchFrames: { frame: number; sh: number; sort: number }[] = [];
    let lastStatus = '';
    const reset = () => {
      if (document.visibilityState === 'visible') return;
      session.reset();
      active.reset();
      cpu.length = draws.length = activeCounts.length = 0;
      diagnosticStart = undefined;
      dispatchFrames.length = 0;
      status.textContent = 'Paused — keep this page visible. Warm-up restarts on return.';
      lastStatus = '';
    };
    document.addEventListener('visibilitychange', reset);
    try {
      await new Promise<void>((resolve, reject) => {
        const tick = (timestamp: number): void => {
          if (document.visibilityState !== 'visible') {
            requestAnimationFrame(tick);
            return;
          }
          try {
            const state = session.frame(timestamp);
            applyComparisonCamera(
              camera,
              pose,
              Math.max(0, state.elapsedMs - config.warmup * 1000),
              config.mode,
            );
            const before = state.sampling ? active.diagnostics?.() : undefined;
            diagnosticStart ??= before;
            const sample = active.frame(camera, ++frame, state.sampling);
            if (state.sampling) {
              const after = active.diagnostics?.();
              if (before && after)
                dispatchFrames.push({
                  frame,
                  sh: Number(after.dispatches) - Number(before.dispatches),
                  sort: Number(after.sortSubmissions) - Number(before.sortSubmissions),
                });
              cpu.push(sample.cpuMs);
              draws.push(sample.draws);
              activeCounts.push(sample.activeSplats);
            }
            const nextStatus = `${suiteLabel}${state.sampling ? 'Measuring' : 'Warming up'} ${config.preset} / ${config.mode}…`;
            if (nextStatus !== lastStatus) {
              status.textContent = nextStatus;
              lastStatus = nextStatus;
            }
            if (state.complete) resolve();
            else requestAnimationFrame(tick);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        requestAnimationFrame(tick);
      });
    } finally {
      document.removeEventListener('visibilitychange', reset);
    }
    await active.finish();
    const gpu = active.gpu();
    const frameSummary = summarize(session.frameTimes);
    const result = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      environment,
      browser: navigator.userAgent,
      platform: navigator.platform,
      pageState: {
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        devicePixelRatio,
      },
      pacingAssessment:
        (frameSummary.medianMs ?? 0) > 100
          ? 'Slow callback cadence: check foreground visibility and browser throttling before interpreting FPS.'
          : 'No slow-callback warning; inspect GPU coverage and repeated runs before drawing conclusions.',
      suiteId: params.get('suiteId'),
      step: params.get('suite') === '1' ? step : null,
      repeat: Number(params.get('repeat') ?? 1),
      probe: params.get('probe') ?? 'baseline',
      config,
      scene: manifest,
      camera: { ...pose, fov: 45, near: 0.01, far: 10000 },
      renderer: active.metadata,
      diagnostics: active.diagnostics?.() ?? null,
      measuredDispatches: {
        sh: dispatchFrames.reduce((sum, entry) => sum + entry.sh, 0),
        sort: dispatchFrames.reduce((sum, entry) => sum + entry.sort, 0),
        initial: diagnosticStart ?? null,
      },
      frame: {
        ...frameSummary,
        averageFps: frameSummary.meanMs ? 1000 / frameSummary.meanMs : null,
        intervalsOver16_67ms: session.frameTimes.filter((ms) => ms > 1000 / 60).length,
        intervalsOver33_33ms: session.frameTimes.filter((ms) => ms > 1000 / 30).length,
      },
      cpuUpdateAndRender: summarize(cpu),
      drawCalls: { median: summarize(draws).medianMs, max: Math.max(...draws) },
      activeSplats: { min: Math.min(...activeCounts), max: Math.max(...activeCounts) },
      gpu: {
        supported: gpu.supported,
        coverage: gpu.coverage,
        rejected: gpu.rejected ?? 0,
        render: summarize(gpu.render.map((sample) => sample.ms)),
        compute: summarize(gpu.compute.map((sample) => sample.ms)),
      },
      raw: {
        frameIntervalsMs: session.frameTimes,
        cpuUpdateAndRenderMs: cpu,
        gpuRender: [...gpu.render],
        gpuCompute: [...gpu.compute],
        dispatchFrames,
      },
      caveats: [
        'FPS is observed animation callback cadence, not display presentation or uncapped throughput.',
        'CPU submission excludes asynchronous worker execution and GPU completion.',
        'GPU render and compute percentiles are separate; do not add unpaired percentiles.',
        'Compute timing includes SH preparation and sorting; dispatch counters distinguish their frequency.',
        'Diagnostic counters include initial preparation and warm-up; timed deltas are recorded separately.',
      ],
    };
    status.textContent = `${suiteLabel}Capturing fixed comparison poses…`;
    const screenshots: { name: string; data: string }[] = [];
    for (const time of [0, 12000]) {
      applyComparisonCamera(camera, pose, time, time !== 0);
      await active.settle(camera);
      screenshots.push({
        name: time === 0 ? 'front' : 'orbit',
        data: active.canvas.toDataURL('image/png'),
      });
    }
    active.dispose();
    adapter = undefined;
    view.replaceChildren(
      ...screenshots.map((shot) => {
        const image = document.createElement('img');
        image.src = shot.data;
        image.alt = `${config.engine} fixed ${shot.name} pose`;
        return image;
      }),
    );
    const save = await fetch('/__benchmark/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result, screenshots }),
    });
    if (!save.ok) throw new Error(`Could not archive results: HTTP ${save.status}.`);
    const saved = (await save.json()) as { directory: string };
    const text = JSON.stringify(result, null, 2);
    results.textContent = text;
    status.textContent = `${suiteLabel}Complete. ${frameSummary.medianMs?.toFixed(2)} ms frame interval; ${result.gpu.render.medianMs?.toFixed(2) ?? 'unavailable'} ms GPU render. Saved to ${saved.directory}`;
    const jsonButton = document.querySelector<HTMLButtonElement>('#download-json')!;
    jsonButton.disabled = false;
    jsonButton.onclick = () => {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      download(`${config.engine}-${config.preset}-${config.mode}.json`, url);
      URL.revokeObjectURL(url);
    };
    const shotButton = document.querySelector<HTMLButtonElement>('#download-shot')!;
    shotButton.disabled = false;
    shotButton.onclick = () => download(`${config.engine}-front.png`, screenshots[0]!.data);
    if (params.get('suite') === '1' && step + 1 < comparisonSuite().length) {
      location.href = suiteUrl(step + 1);
    }
  } finally {
    adapter?.dispose();
  }
}

void navigator.locks
  .request('vlam-spark-comparison', { ifAvailable: true }, async (lock) => {
    if (!lock)
      throw new Error('Another benchmark is running in this browser. Wait for it to finish.');
    await run();
  })
  .catch((error: unknown) => {
    status.textContent = `Benchmark stopped: ${error instanceof Error ? error.message : String(error)}`;
  });
