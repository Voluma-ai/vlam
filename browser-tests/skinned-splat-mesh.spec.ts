import { expect, test } from '@playwright/test';

/**
 * `SkinnedSplatMesh`'s GPU skin against its CPU twin (`posedSplatData`), on
 * both backends and (WebGPU) under the unified draw. See
 * `src/viewer/skinned-splat-probe.ts`.
 */
test('the GPU skin draws where the CPU poses the splats', async ({ page }, info) => {
  test.setTimeout(120_000);
  const backend = info.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  await page.goto(`/src/viewer/skinned-splat-probe.html?backend=${backend}`);
  await expect(page.locator('#result')).not.toHaveText('', { timeout: 110_000 });
  const report = JSON.parse((await page.locator('#result').textContent())!) as {
    error?: string;
    gpuVsCpu: number;
    restVsCpu: number;
    unifiedVsCpu: number | null;
    coverage: number;
    cpuCoverage: number;
    pick: { posedError: number | null; restHitNearRestTip: boolean };
  };
  console.log(JSON.stringify(report));
  expect(report.error, report.error).toBeUndefined();
  // The probe sees the limb, and sees a wrong pose (the control).
  expect(report.coverage).toBeGreaterThan(0.03);
  expect(report.restVsCpu).toBeGreaterThan(4);
  // WebGPU sorts the posed centers; the WebGL2 worker sorts the bind pose,
  // so overlapping splats may blend in a different order there.
  expect(report.gpuVsCpu).toBeLessThan(backend === 'webgpu' ? 1 : 3);
  if (backend === 'webgpu') expect(report.unifiedVsCpu!).toBeLessThan(1);
  // A GPU pick finds the posed splats, not where they rested.
  expect(report.pick.posedError).not.toBeNull();
  expect(report.pick.posedError!).toBeLessThan(0.15);
  expect(report.pick.restHitNearRestTip).toBe(false);
});
