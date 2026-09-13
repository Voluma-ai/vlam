import { expect, test } from '@playwright/test';

test('verifies projection and SH caching on a non-software WebGPU adapter', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-webgpu-hardware');
  test.setTimeout(180_000);
  await page.goto('/src/viewer/projection-probe.html');
  const result = page.locator('[data-testid="result"]');
  await expect(result).not.toHaveText('', { timeout: 120_000 });
  const value = JSON.parse((await result.textContent()) ?? 'null') as {
    error?: string;
    hardware: {
      browser: string;
      backend: string;
      adapter: {
        vendor: string | null;
        architecture: string | null;
        device: string | null;
        description: string | null;
        driver: string | null;
        isFallback: boolean | null;
      };
      isSoftware: boolean;
      viewport: { width: number; height: number };
    };
    shParity: {
      base: number[][];
      vertex: number[][];
      computeCache: number[][];
      cacheDispatches: number;
      projectorPackedColor: boolean | null;
    };
    gooseParity: {
      projectionDispatches: number | null;
    };
  };
  await testInfo.attach('hardware-environment.json', {
    body: JSON.stringify(value.hardware, null, 2),
    contentType: 'application/json',
  });
  expect(value.error).toBeUndefined();
  expect(value.hardware.backend).toBe('webgpu');
  expect(value.hardware.isSoftware).toBe(false);
  expect(value.hardware.adapter.isFallback).not.toBe(true);
  expect(
    [
      value.hardware.adapter.vendor,
      value.hardware.adapter.architecture,
      value.hardware.adapter.device,
      value.hardware.adapter.description,
    ].some((value) => typeof value === 'string' && value.length > 0),
  ).toBe(true);
  expect(value.hardware.viewport).toEqual({ width: 1280, height: 720 });
  expect(value.shParity.cacheDispatches).toBeGreaterThanOrEqual(2);
  expect(value.shParity.projectorPackedColor).toBe(false);
  // The fixture changes the camera twice, then calls `update()` twice more
  // without changing any projector input. A third/fourth compute projection
  // here would be redundant work and would defeat the static-scene policy.
  expect(value.gooseParity.projectionDispatches).toBe(2);
  for (let pose = 0; pose < 2; pose++) {
    expect(value.shParity.vertex[pose]![0]! - value.shParity.base[pose]![0]!).toBeGreaterThan(30);
    for (let channel = 0; channel < 4; channel++) {
      expect(
        Math.abs(
          value.shParity.computeCache[pose]![channel]! - value.shParity.vertex[pose]![channel]!,
        ),
      ).toBeLessThanOrEqual(3);
    }
  }
  expect(Math.abs(value.shParity.vertex[0]![0]! - value.shParity.vertex[1]![0]!)).toBeGreaterThan(
    5,
  );
});
