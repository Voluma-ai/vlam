import { expect, test } from '@playwright/test';

test.setTimeout(90_000);

test('records and disposes a static scene memory run', async ({ page }, testInfo) => {
  const backend = testInfo.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl';
  await page.goto(
    `/src/viewer/memory-benchmark.html?scene=synthetic&syntheticSplats=64&backend=${backend}&uaMemory=0`,
  );

  const result = page.locator('[data-testid="result"]');
  await expect(result).not.toHaveText('', { timeout: 60_000 });
  const report = JSON.parse((await result.textContent()) ?? 'null') as {
    schemaVersion: number;
    environment: { backend: string };
    scene: { activeSplats: number; capacity: number };
    measured: { checkpoints: { phase: string; activeSplats: number }[] };
    accounted: {
      decodedSource: { totalBytes: number } | null;
      mesh: { cpuBackingBytes: number; gpuBytes: number; totalBytes: number };
    };
  };

  expect(report.schemaVersion).toBe(1);
  expect(report.environment.backend).toBe(backend === 'webgpu' ? 'WebGPU' : 'WebGL2');
  expect(report.scene.activeSplats).toBeGreaterThan(0);
  expect(report.scene.capacity).toBeGreaterThanOrEqual(report.scene.activeSplats);
  expect(report.accounted.decodedSource?.totalBytes).toBeGreaterThan(0);
  expect(report.accounted.mesh.cpuBackingBytes).toBeGreaterThan(0);
  expect(report.accounted.mesh.gpuBytes).toBeGreaterThan(0);
  expect(report.accounted.mesh.totalBytes).toBe(
    report.accounted.mesh.cpuBackingBytes + report.accounted.mesh.gpuBytes,
  );
  expect(report.measured.checkpoints.at(-1)).toMatchObject({
    phase: 'after-dispose',
    activeSplats: 0,
  });
});
