import { expect, test } from '@playwright/test';

test('renders a splat through the requested backend', async ({ page }, testInfo) => {
  const requested = testInfo.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  await page.goto(`/src/viewer/backend-probe.html?backend=${requested}`);
  await expect(page.locator('[data-testid="backend"]')).toHaveText(requested);
  await expect(page.locator('[data-testid="pixel"]')).not.toHaveText('');
  const rgba = (await page.locator('[data-testid="pixel"]').textContent())?.split(',').map(Number);
  expect(rgba).toHaveLength(4);
  expect(rgba?.every(Number.isFinite)).toBe(true);
  expect(rgba?.[0]).toBeGreaterThan(220);
  expect(rgba?.[1]).toBeGreaterThan(220);
  expect(rgba?.[2]).toBeGreaterThan(220);
  expect(rgba?.[3]).toBeGreaterThan(220);
});

test('compute projection compacts on WebGPU and falls back on WebGL2', async ({
  page,
}, testInfo) => {
  const requested = testInfo.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  await page.goto(`/src/viewer/backend-probe.html?backend=${requested}&projection=compute`);
  await expect(page.locator('[data-testid="projection"]')).not.toHaveText('');
  const projectionText = (await page.locator('[data-testid="projection"]').textContent()) ?? 'null';
  expect(projectionText).not.toContain('"error"');
  await expect(page.locator('[data-testid="pixel"]')).not.toHaveText('');
  const rgba = (await page.locator('[data-testid="pixel"]').textContent())?.split(',').map(Number);
  expect(rgba?.[3]).toBeGreaterThan(220);
  const status = JSON.parse(projectionText) as {
    effective: string;
    reason: string;
    visibleCount: number | null;
  };
  if (requested === 'webgpu') {
    expect(status).toEqual({ effective: 'compute', reason: 'explicit-compute', visibleCount: 1 });
  } else {
    expect(status).toEqual({ effective: 'vertex', reason: 'webgl', visibleCount: null });
  }
});

test('refreshes a cropped SH cache during rotation without a radial sort', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-webgpu');
  await page.goto('/src/viewer/sh-cache-probe.html');
  const result = page.locator('[data-testid="result"]');
  await expect(result).not.toHaveText('');
  const value = JSON.parse((await result.textContent()) ?? 'null') as {
    beforeRotation: { dispatches: number; sortSubmissions: number };
    afterRotation: {
      dispatches: number;
      sortSubmissions: number;
      viewCadenceRefreshes: number;
    };
    pixel: number[];
  };
  expect(value.afterRotation.sortSubmissions).toBe(value.beforeRotation.sortSubmissions);
  expect(value.afterRotation.dispatches).toBeGreaterThan(value.beforeRotation.dispatches);
  expect(value.afterRotation.viewCadenceRefreshes).toBeGreaterThan(0);
  expect(value.pixel.slice(0, 3).every((channel) => channel > 1)).toBe(true);
  expect(value.pixel[3]).toBeGreaterThan(1);
});
