import { expect, test } from '@playwright/test';

test('keeps large edge splats visible and their cached colors current', async ({ page }, info) => {
  const backend = info.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/src/viewer/large-splat-visibility-probe.html?backend=${backend}`);
  const result = page.locator('[data-testid="result"]');
  await expect(result).not.toHaveText('', { timeout: 30_000 });
  const value = JSON.parse((await result.textContent()) ?? 'null') as {
    footprint: number[];
    cachedColor: { cropped: number[]; full: number[]; dispatches: number } | null;
    offscreen: number[];
    behind: number[];
    beyondFar: number[];
  };
  expect(errors).toEqual([]);
  expect(value.footprint[3]).toBeGreaterThan(100);
  expect(value.offscreen[3]).toBe(0);
  expect(value.behind[3]).toBe(0);
  expect(value.beyondFar[3]).toBe(0);
  if (backend === 'webgpu') {
    expect(value.cachedColor).not.toBeNull();
    expect(value.cachedColor?.dispatches).toBeGreaterThan(1);
    expect(value.cachedColor?.cropped).toEqual(value.cachedColor?.full);
  }
});
