import { expect, test, type Page } from '@playwright/test';

/**
 * `.asog` (Animated SOG) playback through the harness, with no network: a
 * synthetic clip written in the page (`src/tools/asog/encode-asog.ts`) with
 * real rotation and translation. On WebGPU the GPU path (motion evaluated by
 * a `SplatModifier`) must draw what the frame path (the worker's CPU
 * evaluation) draws, standalone and as a `UnifiedSplatMesh` source (which
 * sorts the gathered, moved centres itself); WebGL2 plays the frame path.
 */

interface Thumb {
  rgb: number[];
  alpha: number[];
}

interface Metrics {
  backend: string;
  playback: string;
  unified: boolean;
  frame: number;
  shownFrame: number;
  shownInTime: boolean;
  alive: number;
  coverage: number;
  thumb: Thumb;
}

interface Harness {
  playback: string;
  errors: string[];
  measure(frame: number): Promise<Metrics>;
  dispose(): void;
}

/** Frames across the 60-frame clip, out of order so the GPU path jumps too. */
const FRAMES = [0, 9, 23, 37, 52, 14, 59];

function backendOf(projectName: string): 'webgpu' | 'webgl2' {
  return projectName === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
}

async function open(page: Page, backend: string, playback: string, extra = ''): Promise<void> {
  await page.goto(
    `/src/viewer/asog-harness.html?backend=${backend}&playback=${playback}&nocanvas=1&size=384&frame=0${extra}`,
  );
  await expect(page.locator('#result')).not.toHaveText('', { timeout: 120_000 });
  const result = JSON.parse((await page.locator('#result').textContent())!) as {
    error?: string;
    errors: string[];
  };
  expect(result.error, result.error).toBeUndefined();
  expect(result.errors).toEqual([]);
}

async function measureAll(page: Page): Promise<Metrics[]> {
  const out: Metrics[] = [];
  for (const frame of FRAMES) {
    out.push(
      await page.evaluate(
        (f) => (window as unknown as { __asogHarness: Harness }).__asogHarness.measure(f),
        frame,
      ),
    );
  }
  return out;
}

async function close(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const harness = (window as unknown as { __asogHarness: Harness }).__asogHarness;
    harness.dispose();
    return harness.errors;
  });
}

/** Mean absolute difference of two thumbnails' premultiplied RGB bytes. */
function meanAbsDiff(a: Thumb, b: Thumb): number {
  let sum = 0;
  for (let i = 0; i < a.rgb.length; i++) sum += Math.abs(a.rgb[i]! - b.rgb[i]!);
  return sum / a.rgb.length;
}

test('plays a synthetic .asog clip; the GPU path draws what the frame path draws', async ({
  page,
}, info) => {
  // Three passes on WebGPU (frames, GPU, unified) take about 4 minutes on SwiftShader.
  test.setTimeout(480_000);
  const backend = backendOf(info.project.name);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await open(page, backend, 'frames');
  const frames = await measureAll(page);
  expect(await close(page)).toEqual([]);
  for (const m of frames) {
    expect(m.playback).toBe('frames');
    expect(m.shownInTime, `frame ${m.frame} shown`).toBe(true);
    expect(m.shownFrame).toBe(m.frame);
    expect(m.alive).toBeGreaterThan(5000);
    expect(m.coverage).toBeGreaterThan(0.05);
  }
  // Frames differ from each other, so a comparison has teeth.
  expect(meanAbsDiff(frames[0]!.thumb, frames[3]!.thumb)).toBeGreaterThan(2);

  if (backend === 'webgpu') {
    await open(page, backend, 'gpu');
    const gpu = await measureAll(page);
    expect(await close(page)).toEqual([]);
    await open(page, backend, 'gpu', '&unified=1');
    const unified = await measureAll(page);
    expect(await close(page)).toEqual([]);
    const diffs = FRAMES.map((frame, i) => ({
      frame,
      gpuVsFrames: meanAbsDiff(gpu[i]!.thumb, frames[i]!.thumb),
      unifiedVsStandalone: meanAbsDiff(unified[i]!.thumb, gpu[i]!.thumb),
      alive: [gpu[i]!.alive, frames[i]!.alive],
    }));
    console.log(JSON.stringify({ diffs }));
    for (const [i, m] of gpu.entries()) {
      expect(m.playback).toBe('gpu');
      expect(m.shownInTime, `frame ${m.frame} shown`).toBe(true);
      expect(m.alive).toBe(frames[i]!.alive);
      expect(diffs[i]!.gpuVsFrames, `GPU vs frames at ${m.frame}`).toBeLessThan(0.5);
    }
    for (const [i, m] of unified.entries()) {
      expect(m.unified).toBe(true);
      expect(m.playback).toBe('gpu');
      expect(m.shownInTime, `unified frame ${m.frame} shown`).toBe(true);
      expect(m.alive).toBe(frames[i]!.alive);
      expect(diffs[i]!.unifiedVsStandalone, `unified vs standalone at ${m.frame}`).toBeLessThan(
        0.5,
      );
    }
  }
  expect(pageErrors).toEqual([]);
});
