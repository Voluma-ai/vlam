import { expect, test, type Page } from '@playwright/test';

/**
 * `SplatClipMesh` (`@voluma/vlam/dynamic`) through the playback harness, with
 * no network: a procedural clip (`clip=procedural`, GPU-eligible) for the GPU
 * path, and Faltwerk's synthetic `synth_shared` fixture stream (knots beyond
 * the half-float range, so CPU only) for the real container and the fallback.
 */

interface Thumb {
  rgb: number[];
  alpha: number[];
}

interface Metrics {
  backend: string;
  playback: string;
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
  measure(frame: number, options?: { from?: number }): Promise<Metrics>;
  disposeWhileStaging(frame: number): Promise<string[]>;
  dispose(): void;
}

const SYNTH_SHARED = '/src/lib/__tests__/fixtures/csgs/synth_shared.scene.json';

/** Frames inside each procedural section (3 × 8 frames) and right after each boundary. */
const FRAMES = [0, 3, 7, 8, 12, 15, 16, 20, 23];

function backendOf(projectName: string): 'webgpu' | 'webgl2' {
  return projectName === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
}

/** Opens the harness paused on frame 0 and waits for its first measurement. */
async function open(page: Page, backend: string, params: string): Promise<void> {
  await page.goto(
    `/src/viewer/csgs-harness.html?backend=${backend}&nocanvas=1&scale=0.5&frame=0&${params}`,
  );
  await expect(page.locator('#result')).not.toHaveText('', { timeout: 120_000 });
  const result = JSON.parse((await page.locator('#result').textContent())!) as {
    error?: string;
    errors: string[];
  };
  expect(result.error, result.error).toBeUndefined();
  expect(result.errors).toEqual([]);
}

async function measure(page: Page, frame: number, from?: number): Promise<Metrics> {
  return page.evaluate(
    ([f, start]) =>
      (window as unknown as { __csgsHarness: Harness }).__csgsHarness.measure(
        f,
        start === null ? {} : { from: start },
      ),
    [frame, from ?? null] as const,
  );
}

async function harnessField<K extends keyof Harness>(page: Page, key: K): Promise<Harness[K]> {
  return page.evaluate(
    (k) => (window as unknown as { __csgsHarness: Harness }).__csgsHarness[k as K],
    key,
  );
}

/**
 * Releases the GPU, then lets SwiftShader settle on a backend probe: right
 * after a page's teardown it needs seconds to serve the next adapter request.
 */
async function close(page: Page, backend: string): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __csgsHarness: Harness }).__csgsHarness.dispose(),
  );
  await page.goto(`/src/viewer/backend-probe.html?backend=${backend}`);
  await expect(page.locator('[data-testid="backend"]')).toHaveText(backend, { timeout: 60_000 });
}

/** Mean absolute difference of two thumbnails' premultiplied RGB bytes. */
function thumbDiff(a: Thumb, b: Thumb): number {
  let sum = 0;
  for (let i = 0; i < a.rgb.length; i++) sum += Math.abs(a.rgb[i]! - b.rgb[i]!);
  return sum / a.rgb.length;
}

/** Measures every frame of {@link FRAMES}, checking each was shown exactly. */
async function measureAll(page: Page): Promise<Metrics[]> {
  const out: Metrics[] = [];
  for (const frame of FRAMES) {
    const metrics = await measure(page, frame);
    expect(metrics.shownInTime, `frame ${frame} shown`).toBe(true);
    expect(metrics.shownFrame).toBe(frame);
    out.push(metrics);
  }
  return out;
}

test.describe('SplatClipMesh', () => {
  test.setTimeout(240_000);

  test('procedural clip: GPU path matches the frame path, standalone and unified', async ({
    page,
  }, info) => {
    const backend = backendOf(info.project.name);
    test.skip(backend !== 'webgpu', 'the GPU path needs WebGPU');
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await open(page, backend, 'clip=procedural&playback=frames');
    const cpu = await measureAll(page);
    await close(page, backend);

    await open(page, backend, 'clip=procedural&playback=auto');
    expect(await harnessField(page, 'playback')).toBe('gpu');
    const gpu = await measureAll(page);
    // Reverse playback across both boundaries lands on the same pixels.
    const reverse = await measure(page, 6, 20);
    expect(reverse.shownFrame).toBe(6);
    const forward = await measure(page, 6, 0);
    expect(thumbDiff(reverse.thumb, forward.thumb)).toBeLessThan(0.5);
    expect(await harnessField(page, 'errors')).toEqual([]);
    await close(page, backend);

    await open(page, backend, 'clip=procedural&playback=gpu&unified=1');
    const unified = await measureAll(page);
    expect(await harnessField(page, 'errors')).toEqual([]);
    await close(page, backend);

    const diffs = FRAMES.map((frame, i) => ({
      frame,
      cpu: thumbDiff(gpu[i]!.thumb, cpu[i]!.thumb),
      unified: thumbDiff(gpu[i]!.thumb, unified[i]!.thumb),
    }));
    console.log(JSON.stringify({ diffs }));
    for (const [i, frame] of FRAMES.entries()) {
      expect(gpu[i]!.alive, `alive at ${frame}`).toBe(cpu[i]!.alive);
      expect(unified[i]!.alive).toBe(gpu[i]!.alive);
      expect(gpu[i]!.coverage).toBeGreaterThan(0.01);
      // Half-float knots on the GPU against float32 on the CPU (measured ~0.05).
      expect(Math.abs(gpu[i]!.coverage - cpu[i]!.coverage), `coverage at ${frame}`).toBeLessThan(
        0.01,
      );
      expect(diffs[i]!.cpu, `GPU vs CPU at ${frame}`).toBeLessThan(0.5);
      expect(diffs[i]!.unified, `unified vs standalone at ${frame}`).toBeLessThan(0.5);
    }
    // Frames differ from each other, so the comparison above has teeth.
    expect(thumbDiff(gpu[0]!.thumb, gpu[4]!.thumb)).toBeGreaterThan(2);
    expect(pageErrors).toEqual([]);
  });

  test('disposing while a section stages leaves no errors', async ({ page }, info) => {
    const backend = backendOf(info.project.name);
    test.skip(backend !== 'webgpu', 'the GPU path needs WebGPU');
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await open(page, backend, 'clip=procedural&playback=gpu&resident=2&stageBudget=1');
    const errors = await page.evaluate(() =>
      (window as unknown as { __csgsHarness: Harness }).__csgsHarness.disposeWhileStaging(20),
    );
    expect(errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    await close(page, backend);
  });

  test('synth_shared falls back to the frame path and renders', async ({ page }, info) => {
    const backend = backendOf(info.project.name);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await open(page, backend, `scene=${encodeURIComponent(SYNTH_SHARED)}&playback=auto`);
    expect(await harnessField(page, 'playback')).toBe('frames');
    for (const frame of [0, 9, 18]) {
      const metrics = await measure(page, frame);
      expect(metrics.shownFrame, `frame ${frame}`).toBe(frame);
      expect(metrics.alive).toBeGreaterThan(0);
    }
    expect(await harnessField(page, 'errors')).toEqual([]);
    expect(pageErrors).toEqual([]);
    await close(page, backend);
  });

  test('procedural clip plays on the frame path under WebGL2', async ({ page }, info) => {
    const backend = backendOf(info.project.name);
    test.skip(backend !== 'webgl2', 'WebGL2 fallback');
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await open(page, backend, 'clip=procedural&playback=auto');
    expect(await harnessField(page, 'playback')).toBe('frames');
    const metrics = await measure(page, 12, 20);
    expect(metrics.shownFrame).toBe(12);
    expect(metrics.coverage).toBeGreaterThan(0.01);
    expect(pageErrors).toEqual([]);
    await close(page, backend);
  });
});
