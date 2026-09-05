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
