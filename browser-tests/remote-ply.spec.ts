import { expect, test } from '@playwright/test';

declare const process: { env: { VLAM_EXPERIMENT?: string } };

test('remote PLY stream decodes SH and renders on both backends', async ({ page }, testInfo) => {
  const variant = process.env.VLAM_EXPERIMENT;
  test.skip(variant !== 'exact-stream' && variant !== 'approximate-sh-stream');
  const backend = testInfo.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  await page.goto(`/src/viewer/ply-stream-probe.html?backend=${backend}`);
  const result = page.locator('[data-testid="result"]');
  await expect(result).not.toHaveText('', { timeout: 30_000 });
  const value = JSON.parse((await result.textContent()) ?? 'null') as {
    error?: string;
    count: number;
    secondCount: number;
    temporaryEntries: number;
    metrics: { mode: string; temporaryDiskBytes: number; bufferedFallback: boolean };
    samples: number[][];
  };
  expect(value.error).toBeUndefined();
  expect(value.count).toBe(3);
  expect(value.secondCount).toBe(3);
  expect(value.temporaryEntries).toBe(0);
  expect(value.metrics.mode).toBe(variant);
  expect(value.metrics.bufferedFallback).toBe(false);
  expect(value.metrics.temporaryDiskBytes > 0).toBe(variant === 'exact-stream');
  for (const [i, pixel] of value.samples.entries()) {
    expect(pixel[3]).toBeGreaterThan(0);
    expect(pixel[i]).toBeGreaterThan(pixel[(i + 1) % 3] as number);
  }
  await page
    .locator('#preview')
    .screenshot({ path: testInfo.outputPath(`${variant}-${backend}.png`) });
});
