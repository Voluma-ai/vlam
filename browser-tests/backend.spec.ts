import { expect, test } from '@playwright/test';

test('initializes the requested backend and produces deterministic pixels', async ({ page }, testInfo) => {
  const requested = testInfo.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  await page.goto(`/src/viewer/backend-probe.html?backend=${requested}`);
  await expect(page.locator('[data-testid="backend"]')).toHaveText(requested);
  await expect(page.locator('[data-testid="pixel"]')).toHaveText('34,139,230,255');
});
