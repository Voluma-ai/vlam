import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * `.csgs` playback proof of concept: decodes a Faltwerk clip, shows one
 * frame per section through the dynamic pool, and compares the pinned test
 * camera's render with that camera's reference thumbnail.
 *
 * The clips are third-party captures with no stated license, linked from the
 * public faltwerk-demo site rather than copied. The check skips on CI (no
 * third-party downloads per run) and whenever that site is unreachable.
 */
const SCENE = 'https://jameskane05.github.io/faltwerk-demo/scene_female.json';

/** Whether the linked clip answers, so an offline run skips instead of failing. */
async function sceneReachable(): Promise<boolean> {
  try {
    return (await fetch(SCENE, { method: 'HEAD', signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    return false;
  }
}

interface Metrics {
  backend: string;
  frame: number;
  alive: number;
  coverage: number;
  evalMs: number;
  swapMs: number;
  reference: { meanAbsDiff: number; coverage: number; otherPoseAbsDiff: number } | null;
  errors: string[];
  decodeMs: number[];
  error?: string;
}

/** Saves the harness's last render-target readback (the measured pixels) as a PNG. */
async function savePng(page: Page, path: string): Promise<void> {
  const dataUrl = await page.evaluate(
    () =>
      (window as unknown as { __csgsHarness: { readbackPng: string | null } }).__csgsHarness
        .readbackPng,
  );
  expect(dataUrl).not.toBeNull();
  const base64 = dataUrl!.split(',')[1]!;
  writeFileSync(
    path,
    Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
  );
}

test('plays a Faltwerk .csgs clip through a dynamic SplatMesh', async ({ page }, info) => {
  test.skip(
    Boolean(
      (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CI,
    ),
    'linked third-party clips are not fetched on CI',
  );
  test.skip(!(await sceneReachable()), 'the linked .csgs clip is unreachable');
  test.setTimeout(240_000);
  const backend = info.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(
    // `nocanvas`: presenting to a canvas on headless SwiftShader WebGPU destroys
    // the device; the render-target path is what the metrics read anyway.
    `/src/viewer/csgs-harness.html?backend=${backend}&scene=${encodeURIComponent(SCENE)}&cam=c00&frame=0&scale=0.5&nocanvas=1`,
  );
  await expect(page.locator('#result')).not.toHaveText('', { timeout: 200_000 });
  const first = JSON.parse((await page.locator('#result').textContent())!) as Metrics;
  expect(first.error, first.error).toBeUndefined();
  expect(first.errors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(first.backend).toBe(backend);
  expect(first.decodeMs).toHaveLength(2);
  expect(first.alive).toBeGreaterThan(30_000);
  // A standing person covers roughly a quarter of the 704×1280 test view.
  expect(first.coverage).toBeGreaterThan(0.15);
  expect(first.coverage).toBeLessThan(0.5);
  expect(first.reference).not.toBeNull();
  // Composited over its own reference thumbnail the render differs by ~11/255
  // (measured 11.0 on both backends); DC-only color gives 15 and the wrong
  // pose 54, so the bound also guards the SH path.
  expect(first.reference!.meanAbsDiff).toBeLessThan(20);
  expect(first.reference!.meanAbsDiff).toBeLessThan(first.reference!.otherPoseAbsDiff / 2);
  await savePng(page, info.outputPath(`${backend}-frame-0.png`));

  // The second section (frames 32..63) swaps in through the same pool.
  const later = await page.evaluate(() =>
    (
      window as unknown as { __csgsHarness: { measure(frame: number): Promise<Metrics> } }
    ).__csgsHarness.measure(48),
  );
  expect(later.alive).toBeGreaterThan(30_000);
  expect(later.coverage).toBeGreaterThan(0.15);
  expect(later.reference!.meanAbsDiff).toBeLessThan(20);
  expect(later.reference!.meanAbsDiff).toBeLessThan(later.reference!.otherPoseAbsDiff / 2);
  await savePng(page, info.outputPath(`${backend}-frame-48.png`));
  expect(pageErrors).toEqual([]);
  // Release the GPU before the page closes, so the next check's adapter
  // request does not wait on this page's teardown (SwiftShader).
  await page.evaluate(() =>
    (window as unknown as { __csgsHarness: { dispose(): void } }).__csgsHarness.dispose(),
  );
  // Then let the GPU process settle on a fresh backend probe: right after
  // this page's teardown, SwiftShader needs about 5 s to serve the next
  // adapter request, which would trip the next check's 5 s default deadline.
  await page.goto(`/src/viewer/backend-probe.html?backend=${backend}`);
  await expect(page.locator('[data-testid="backend"]')).toHaveText(backend, { timeout: 60_000 });
  console.log(JSON.stringify({ backend, first, later }));
});
