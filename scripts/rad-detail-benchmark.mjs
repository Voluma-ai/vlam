/** Native-browser, screenshot-based RAD arrival probe. Run against separately
 * started baseline, rad-indexed, and rad-focus benchmark servers; see
 * docs/formats/rad-notes.md. Output is diagnostic until the route and pixel
 * threshold are visually audited. */
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  classifyBenchmarkFailures,
  parseMemoryMode,
  sampleSchedule,
  stopToEquivalentMs,
} from './rad-detail-benchmark-policy.mjs';

const flags = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, '').split('=');
    return [key, value.join('=')];
  }),
);
const scene = flags.scene ?? 'lcc';
const routes = (flags.routes ?? 'overview-fly,direct,turn-return,orbit').split(',');
const runs = Number(flags.runs ?? 5);
const allowanceMB = Number(flags.allowanceMB ?? 768);
const budget = Number(flags.budget ?? (scene === 'lcc' ? 4_000_000 : 1_000_000));
const sampleMs = Number(flags.sampleMs ?? 20000);
const base = flags.base ?? 'http://127.0.0.1:4188';
const label = flags.label ?? 'focus';
const cacheMode = flags.cacheMode ?? 'cold';
const backend = flags.backend ?? 'webgpu';
const referencePath = flags.reference;
const thresholdMae = flags.thresholdMae === undefined ? null : Number(flags.thresholdMae);
const memoryMode = parseMemoryMode(flags.memory);
if (!['cold', 'warm'].includes(cacheMode)) throw new Error('Invalid cacheMode.');
if (!['webgpu', 'webgl'].includes(backend)) throw new Error('Invalid backend.');
if (thresholdMae !== null && (!Number.isFinite(thresholdMae) || thresholdMae < 0))
  throw new Error('Invalid thresholdMae.');
if (!Number.isInteger(runs) || runs < 1 || runs > 20) {
  throw new Error('Invalid runs or sampleMs.');
}
const schedule = sampleSchedule(sampleMs);
const manifest =
  scene === 'ply'
    ? { file: 'ply/medium.ply' }
    : JSON.parse(await readFile(join('.tmp/benchmark-assets', `${scene}.json`), 'utf8'));
const sceneUrl = `/benchmark-assets/${manifest.file}`;
const sharedReference = referencePath ? await readFile(referencePath) : null;
const outputDir = join(
  '.tmp/rad-detail-benchmark',
  `${new Date().toISOString().replaceAll(':', '-')}-${label}`,
);
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.VLAM_HARDWARE_CHROMIUM ?? '/usr/bin/chromium',
  headless: false,
  args: [
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-webgpu',
    '--enable-dawn-features=allow_unsafe_apis',
    '--enable-webgpu-developer-features',
    '--use-gpu-in-tests',
    '--enable-accelerated-2d-canvas',
  ],
});

function percentile(values, p) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * p))];
}

async function centralMae(page, left, right) {
  return page.evaluate(
    async ([left64, right64]) => {
      const decode = async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      };
      const images = await Promise.all([decode(left64), decode(right64)]);
      const width = Math.floor(images[0].width * 0.5);
      const height = Math.floor(images[0].height * 0.5);
      if (images[0].width !== images[1].width || images[0].height !== images[1].height)
        throw new Error('Screenshots have different dimensions.');
      const pixels = images.map((image) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(
          image,
          -Math.floor((image.width - width) / 2),
          -Math.floor((image.height - height) / 2),
        );
        image.close();
        return context.getImageData(0, 0, width, height).data;
      });
      let sum = 0;
      for (let i = 0; i < pixels[0].length; i += 4) {
        sum += Math.abs(pixels[0][i] - pixels[1][i]);
        sum += Math.abs(pixels[0][i + 1] - pixels[1][i + 1]);
        sum += Math.abs(pixels[0][i + 2] - pixels[1][i + 2]);
      }
      return sum / (width * height * 3);
    },
    [left.toString('base64'), right.toString('base64')],
  );
}

function emptyViewerState(timestamp, error) {
  return {
    timestamp,
    backend: null,
    active: null,
    frontier: null,
    pagerMode: null,
    poolCapacity: null,
    poolMemory: null,
    browserMemoryBytes: null,
    plan: null,
    fetch: null,
    demand: null,
    pending: null,
    error,
    deviceLost: null,
  };
}

async function collectViewerState(page) {
  try {
    return await page.evaluate(() => {
      const voluma = window.__voluma;
      const splats = voluma?.splats;
      return {
        timestamp: performance.now(),
        backend: voluma?.renderer?.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2',
        active: splats?.activeSplatCount ?? null,
        frontier: splats?.frontierState ?? null,
        pagerMode: splats?.indexedPageTable ? 'indexed' : 'classic',
        poolCapacity: splats?.capacity ?? null,
        poolMemory: voluma?.radBenchmarkMemory ?? null,
        browserMemoryBytes: null,
        plan: splats?.planTimings ?? null,
        fetch: splats?.fetchCounts ?? null,
        demand: splats?.demandDiagnostics ?? null,
        pending: splats?.pendingChunkCount ?? null,
        error: splats?.streamingError?.message ?? null,
        deviceLost: voluma?.deviceLost ?? null,
      };
    });
  } catch (error) {
    return emptyViewerState(0, error instanceof Error ? error.message : String(error));
  }
}

async function snapshot(page, stopAt, index, route) {
  // Timestamp and screenshot before any browser-wide memory probe. That API
  // can GC-pause for seconds and would otherwise shift arrival and frame
  // windows.
  const state = await collectViewerState(page);
  const captureStartedAt = state.timestamp;
  let screenshot = Buffer.alloc(0);
  try {
    screenshot = await page.screenshot();
  } catch {
    // Keep the JSON row even when the page is already gone.
  }
  let captureEndedAt = captureStartedAt;
  try {
    captureEndedAt = await page.evaluate(() => performance.now());
  } catch {
    captureEndedAt = captureStartedAt;
  }
  if (memoryMode === 'sample') {
    try {
      state.browserMemoryBytes = await page.evaluate(async () => {
        try {
          return (await performance.measureUserAgentSpecificMemory?.())?.bytes ?? null;
        } catch {
          return null;
        }
      });
    } catch {
      state.browserMemoryBytes = null;
    }
  }
  if (index === 0 || index === -1 || [4, 5, 8, 9].includes(index)) {
    const name = index === 0 ? 'stop' : index === -1 ? 'final' : `sample-${index}`;
    await writeFile(join(outputDir, `${route}-${name}.png`), screenshot);
  }
  return {
    elapsedMs: state.timestamp - stopAt,
    state,
    screenshot,
    captureStartedAt,
    captureEndedAt,
  };
}

async function move(page, route) {
  const pose = manifest.camera;
  if (route === 'direct') {
    const now = await page.evaluate(() => performance.now());
    return {
      startedAt: now,
      endedAt: now,
      maxCameraTravel: 0,
      configuredHorizontalRadius: 0,
      effectiveHorizontalRadius: 0,
    };
  } // document navigation is the direct-load start
  if (!pose) throw new Error(`Route ${route} requires a camera pose in the scene manifest.`);
  return page.evaluate(
    async ({ position, target, route }) => {
      const { controls, THREE } = window.__voluma;
      const startPosition = controls.getPosition(new THREE.Vector3(), false).toArray();
      const startTarget = controls.getTarget(new THREE.Vector3(), false).toArray();
      const duration = route === 'orbit' ? 8000 : route === 'turn-return' ? 1500 : 2000;
      const begin = performance.now();
      const configuredHorizontalRadius = Math.hypot(
        position[0] - target[0],
        position[2] - target[2],
      );
      // A top-down pose has no horizontal heading. Keep the supplied pose for
      // the settled frame, but use a deterministic scene-scale radius so an
      // orbit/turn route actually exercises camera motion instead of tracing a
      // zero-length circle.
      const effectiveHorizontalRadius =
        configuredHorizontalRadius > 1e-3
          ? configuredHorizontalRadius
          : Math.max(1, Math.abs(position[1] - target[1]) * 0.25);
      let maxCameraTravel = 0;
      const recordTravel = () => {
        const currentPosition = controls.getPosition(new THREE.Vector3(), false).toArray();
        const currentTarget = controls.getTarget(new THREE.Vector3(), false).toArray();
        const positionTravel = Math.hypot(
          currentPosition[0] - startPosition[0],
          currentPosition[1] - startPosition[1],
          currentPosition[2] - startPosition[2],
        );
        const targetTravel = Math.hypot(
          currentTarget[0] - startTarget[0],
          currentTarget[1] - startTarget[1],
          currentTarget[2] - startTarget[2],
        );
        maxCameraTravel = Math.max(maxCameraTravel, positionTravel, targetTravel);
      };
      while (performance.now() - begin < duration) {
        const t = Math.min(1, (performance.now() - begin) / duration);
        if (route === 'orbit') {
          const angle = t * Math.PI * 2;
          const configuredDx = position[0] - target[0];
          const configuredDz = position[2] - target[2];
          const configuredRadius = Math.hypot(configuredDx, configuredDz);
          const dx = configuredRadius > 1e-3 ? configuredDx : effectiveHorizontalRadius;
          const dz = configuredRadius > 1e-3 ? configuredDz : 0;
          controls.setLookAt(
            target[0] + dx * Math.cos(angle) - dz * Math.sin(angle),
            position[1],
            target[2] + dx * Math.sin(angle) + dz * Math.cos(angle),
            ...target,
            false,
          );
        } else if (route === 'turn-return') {
          const yaw = Math.sin(Math.PI * t) * (Math.PI / 2);
          const configuredDx = target[0] - position[0];
          const configuredDz = target[2] - position[2];
          const configuredRadius = Math.hypot(configuredDx, configuredDz);
          const dx = configuredRadius > 1e-3 ? configuredDx : effectiveHorizontalRadius;
          const dz = configuredRadius > 1e-3 ? configuredDz : 0;
          controls.setLookAt(
            ...position,
            position[0] + dx * Math.cos(yaw) - dz * Math.sin(yaw),
            target[1],
            position[2] + dx * Math.sin(yaw) + dz * Math.cos(yaw),
            false,
          );
        } else {
          const smooth = t * t * (3 - 2 * t);
          const lerp = (a, b) => a.map((value, axis) => value + (b[axis] - value) * smooth);
          controls.setLookAt(...lerp(startPosition, position), ...lerp(startTarget, target), false);
        }
        recordTravel();
        await new Promise(requestAnimationFrame);
      }
      controls.setLookAt(...position, ...target, false);
      recordTravel();
      return {
        startedAt: begin,
        endedAt: performance.now(),
        maxCameraTravel,
        configuredHorizontalRadius,
        effectiveHorizontalRadius,
      };
    },
    { ...pose, route },
  );
}

function frontierStillPending(frontier) {
  return (
    frontier !== undefined &&
    frontier !== null &&
    (!frontier.frontierConverged ||
      (frontier.pendingFrontierSplats ?? 0) > 0 ||
      (frontier.staleResidentSplats ?? 0) > 0)
  );
}

async function referenceRunStillPending() {
  if (!referencePath) return false;
  const match = /^(.*)-(\d+)-final\.png$/.exec(basename(referencePath));
  if (!match) return false;
  try {
    const prior = JSON.parse(await readFile(join(dirname(referencePath), 'results.json'), 'utf8'));
    const row = prior.find((entry) => entry.route === match[1] && entry.run === Number(match[2]));
    return Boolean(
      row &&
      (row.runStillPending || row.final?.pending > 0 || frontierStillPending(row.final?.frontier)),
    );
  } catch {
    // A standalone PNG has no convergence metadata; retain the existing
    // caller contract while validating references produced by this runner.
    return false;
  }
}

async function runOne(route, run, sharedContext) {
  const context =
    sharedContext ?? (await browser.newContext({ viewport: { width: 1280, height: 720 } }));
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__radFrames = [];
    let previous = 0;
    const tick = (now) => {
      if (previous) window.__radFrames.push([now, now - previous]);
      previous = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('crash', () => errors.push('page crashed'));
  const params = new URLSearchParams({
    scene: sceneUrl,
    orientation: 'source',
    radBenchmarkAllowanceMB: String(allowanceMB),
    budget: String(budget),
    foveationDraw: String(budget),
    benchmarkSeconds: '5',
    benchmarkStart: 'manual',
    pixelRatio: '1',
    adaptiveDpr: '0',
    chrome: 'embed',
  });
  params.set('backend', backend);
  if (scene === 'lcc') params.set('foveationMode', 'page-table');
  if (route !== 'overview-fly' && manifest.camera) {
    params.set('cameraPosition', manifest.camera.position.join(','));
    params.set('cameraTarget', manifest.camera.target.join(','));
  }
  await page.goto(`${base}/src/viewer/index.html?${params}`, { waitUntil: 'domcontentloaded' });
  let sawFirstImage = true;
  try {
    await page.waitForFunction(() => window.__voluma?.splats?.activeSplatCount > 0, null, {
      timeout: 120000,
    });
  } catch {
    sawFirstImage = false;
  }
  if (sawFirstImage) {
    const actualBackend = await page.evaluate(() =>
      window.__voluma.renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl',
    );
    if (actualBackend !== backend)
      throw new Error(`Requested ${backend}, but the viewer activated ${actualBackend}.`);
  }
  if (sawFirstImage && (route === 'turn-return' || route === 'orbit'))
    await page.waitForTimeout(7000);
  else if (sawFirstImage && route === 'overview-fly') await page.waitForTimeout(1500);
  const motion = sawFirstImage
    ? await move(page, route)
    : {
        startedAt: 0,
        endedAt: 0,
        maxCameraTravel: 0,
        configuredHorizontalRadius: 0,
        effectiveHorizontalRadius: 0,
      };
  if (sawFirstImage && (route === 'orbit' || route === 'turn-return')) {
    if (motion.maxCameraTravel < 1) {
      throw new Error(`Route ${route} did not move the camera.`);
    }
  }
  const stopAt = motion.endedAt;
  const shots = [];
  if (sawFirstImage) {
    for (let index = 0; index < schedule.length; index++) {
      const elapsed = await page.evaluate((start) => performance.now() - start, stopAt);
      if (schedule[index] > elapsed) await page.waitForTimeout(schedule[index] - elapsed);
      shots.push(await snapshot(page, stopAt, index, `${route}-${run}`));
    }
  }
  const final = await snapshot(page, stopAt, -1, `${route}-${run}`);
  const captureWindows = [...shots, final].map((shot) => [
    shot.captureStartedAt - 100,
    shot.captureEndedAt + 100,
  ]);
  let frameDurations = { motion: [], settled: [] };
  try {
    frameDurations = await page.evaluate(
      ({ motionStart, settledStart, excluded }) => {
        const collect = (start) =>
          (window.__radFrames ?? [])
            .filter(([time]) => time >= start && !excluded.some(([a, b]) => time >= a && time <= b))
            .map(([, duration]) => duration);
        return { motion: collect(motionStart), settled: collect(settledStart) };
      },
      { motionStart: motion.startedAt, settledStart: stopAt, excluded: captureWindows },
    );
  } catch {
    frameDurations = { motion: [], settled: [] };
  }
  const reference = sharedReference ?? final.screenshot;
  const errorsToReference = [];
  const canCompare = shots.length > 0 && reference.length > 0 && final.screenshot.length > 0;
  if (canCompare) {
    for (const shot of shots)
      errorsToReference.push(await centralMae(page, shot.screenshot, reference));
  }
  const finalCentralMae = canCompare ? await centralMae(page, final.screenshot, reference) : null;
  const startError = errorsToReference[0];
  // An absolute 2 RGB levels across a large ROI accepted visibly soft cuts as
  // equivalent; 0.25 remains above tiny stationary capture/sort noise.
  const threshold =
    thresholdMae ?? (Number.isFinite(startError) ? Math.max(0.25, startError * 0.1) : 0.25);
  const errorsThroughFinal = [...errorsToReference, finalCentralMae].filter((error) =>
    Number.isFinite(error),
  );
  const firstEquivalent = shots.findIndex(
    (shot, i) =>
      Number.isFinite(errorsToReference[i]) &&
      errorsToReference[i] <= threshold &&
      errorsThroughFinal.slice(i).every((error) => error <= threshold),
  );
  const runStillPending =
    !sawFirstImage || final.state.pending > 0 || frontierStillPending(final.state.frontier);
  const referenceStillPending =
    runStillPending || (sharedReference !== null && (await referenceRunStillPending()));
  const browserMemorySamples = [...shots, final]
    .map((shot) => shot.state.browserMemoryBytes)
    .filter((bytes) => Number.isFinite(bytes));
  const streamingError =
    final.state.error ?? shots.map((shot) => shot.state.error).find(Boolean) ?? null;
  const deviceLost =
    final.state.deviceLost ?? shots.map((shot) => shot.state.deviceLost).find(Boolean) ?? null;
  const failures = classifyBenchmarkFailures({
    pageErrors: errors,
    deviceLost,
    streamingError,
    sawFirstImage,
  });
  const result = {
    label,
    backend,
    memoryMode,
    cacheMode,
    scene,
    route,
    run,
    allowanceMB,
    budget,
    sampleMs,
    stopToEquivalentCentralMs: stopToEquivalentMs({
      failures,
      referenceStillPending,
      firstEquivalent,
      samples: shots,
    }),
    centralThresholdMae: threshold,
    referencePath: referencePath ?? null,
    referenceStillPending,
    runStillPending,
    failures,
    motionDurationMs: motion.endedAt - motion.startedAt,
    motionDistance: motion.maxCameraTravel,
    configuredHorizontalRadius: motion.configuredHorizontalRadius,
    effectiveHorizontalRadius: motion.effectiveHorizontalRadius,
    centralMae: errorsToReference,
    finalCentralMae,
    samples: shots.map(({ elapsedMs, state }) => ({ elapsedMs, ...state })),
    final: { elapsedMs: final.elapsedMs, ...final.state },
    // Include the route itself. The settled-only values remain available for
    // diagnosing stationary tails, but must not hide motion-time stalls.
    frameP95Ms: percentile(frameDurations.motion, 0.95),
    frameP99Ms: percentile(frameDurations.motion, 0.99),
    settledFrameP95Ms: percentile(frameDurations.settled, 0.95),
    settledFrameP99Ms: percentile(frameDurations.settled, 0.99),
    peakBrowserMemoryBytes: browserMemorySamples.length ? Math.max(...browserMemorySamples) : null,
    poolMemory: final.state.poolMemory,
    errors: failures,
  };
  await page.close();
  if (!sharedContext) await context.close();
  return result;
}

const results = [];
const sharedContext =
  cacheMode === 'warm'
    ? await browser.newContext({ viewport: { width: 1280, height: 720 } })
    : null;
try {
  for (const route of routes) {
    for (let run = 1; run <= runs; run++) {
      const result = await runOne(route, run, sharedContext);
      results.push(result);
      await writeFile(join(outputDir, 'results.json'), JSON.stringify(results, null, 2));
      console.log(
        JSON.stringify({
          route,
          run,
          arrivalMs: result.stopToEquivalentCentralMs,
          memoryMode: result.memoryMode,
          failures: result.failures,
          motionDistance: result.motionDistance,
          frameP95Ms: result.frameP95Ms,
          frameP99Ms: result.frameP99Ms,
          settledFrameP95Ms: result.settledFrameP95Ms,
          settledFrameP99Ms: result.settledFrameP99Ms,
          finalActive: result.final.active,
          finalDemand: result.final.demand,
          finalPending: result.final.pending,
          errors: result.errors,
        }),
      );
    }
  }
} finally {
  await sharedContext?.close();
  await browser.close();
}
console.log(`Saved ${outputDir}/results.json`);
