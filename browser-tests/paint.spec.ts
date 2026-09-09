import { expect, test } from '@playwright/test';

test('renders a surface-aware painted channel on both backends', async ({ page }, testInfo) => {
  const backend = testInfo.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/src/viewer/paint-probe.html?backend=${backend}`);
  const result = page.locator('[data-testid="result"]');
  await expect(result).not.toHaveText('', { timeout: 30_000 });
  const value = JSON.parse((await result.textContent()) ?? 'null') as {
    backend: string;
    modes: {
      surfaceCenter: number;
      throughCenter: number;
      surfaceFootprint: number;
      throughFootprint: number;
    };
    changedPixels: number;
    centerBefore: number[];
    centerAfter: number[];
  };

  expect(errors).toEqual([]);
  expect(value.backend).toBe(backend);
  expect(value.modes).toEqual({
    surfaceCenter: 1,
    throughCenter: 2,
    surfaceFootprint: 2,
    throughFootprint: 3,
  });
  expect(value.changedPixels).toBeGreaterThan(20);
  expect(value.centerAfter).not.toEqual(value.centerBefore);
  expect(value.centerAfter[0]).toBeGreaterThan(value.centerBefore[0] as number);
  expect(value.centerAfter[2]).toBeGreaterThan(value.centerBefore[2] as number);
});
