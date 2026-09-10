import { expect, test, type Page } from '@playwright/test';

test.setTimeout(90_000);

async function waitForBenchmarkReport(page: Page): Promise<Record<string, unknown>> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const result = page.locator('[data-testid="result"]');
  await expect(result).not.toHaveText('', { timeout: 60_000 });
  const report = JSON.parse((await result.textContent()) ?? 'null') as {
    error?: string;
  } & Record<string, unknown>;
  if (typeof report.error === 'string') {
    throw new Error(report.error);
  }
  expect(errors).toEqual([]);
  return report;
}

test('records and disposes a static scene memory run', async ({ page }, testInfo) => {
  const backend = testInfo.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl';
  await page.goto(
    `/src/viewer/memory-benchmark.html?scene=synthetic&syntheticSplats=64&backend=${backend}&uaMemory=0`,
  );

  const report = (await waitForBenchmarkReport(page)) as {
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

test('loads a real scene through the isolated loader worker', async ({ page }, testInfo) => {
  const backend = testInfo.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl';
  await page.goto(
    `/src/viewer/memory-benchmark.html?scene=/goose.sog&backend=${backend}&uaMemory=0&position=0,0,1.5&target=0,0,0`,
  );

  const report = (await waitForBenchmarkReport(page)) as {
    configuration: {
      sourceFormat: string;
      cameraPosition: [number, number, number];
      cameraTarget: [number, number, number];
    };
    scene: { activeSplats: number; settleTimedOut: boolean };
    measured: { checkpoints: { phase: string; activeSplats: number }[] };
  };

  expect(report.configuration.sourceFormat).toBe('sog');
  expect(report.configuration.cameraPosition).toEqual([0, 0, 1.5]);
  expect(report.configuration.cameraTarget).toEqual([0, 0, 0]);
  expect(report.scene.activeSplats).toBe(149_120);
  expect(report.scene.settleTimedOut).toBe(false);
  expect(report.measured.checkpoints.at(-1)).toMatchObject({
    phase: 'after-dispose',
    activeSplats: 0,
  });
});

test('releases render-only CPU scene storage on WebGPU', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-webgpu', 'render-only storage requires WebGPU');
  const runtimePlatform = await page.evaluate(() => navigator.platform);
  test.fixme(
    runtimePlatform.startsWith('Linux'),
    'Chromium Linux SwiftShader drops its external Dawn instance when a released CPU mirror is followed by GPUBuffer readback.',
  );
  await page.goto(
    '/src/viewer/memory-benchmark.html?scene=synthetic&syntheticSplats=64&storage=render-only&backend=webgpu&uaMemory=0',
  );

  const report = (await waitForBenchmarkReport(page)) as {
    scene: {
      cpuStorageReleased: boolean;
      releasedCpuBytes: number;
      gpuPickAfterRelease: boolean;
    };
    accounted: { mesh: { cpuBackingBytes: number; releasedCpuBackingBytes: number } };
  };

  expect(report.scene.cpuStorageReleased).toBe(true);
  expect(report.scene.releasedCpuBytes).toBeGreaterThan(0);
  expect(report.scene.gpuPickAfterRelease).toBe(true);
  expect(report.accounted.mesh.cpuBackingBytes).toBe(0);
  expect(report.accounted.mesh.releasedCpuBackingBytes).toBe(report.scene.releasedCpuBytes);
});
