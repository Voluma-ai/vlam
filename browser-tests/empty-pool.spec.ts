import { expect, test } from '@playwright/test';

declare const process: { env: { VLAM_EXPERIMENT?: string } };

test('skip-empty dynamic pool renders after both append orders', async ({ page }, testInfo) => {
  test.skip(process.env.VLAM_EXPERIMENT !== 'skip-empty', 'requires the isolated skip-empty build');
  const backend = testInfo.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  for (const dynamic of ['before', 'after']) {
    await page.goto(`/src/viewer/backend-probe.html?backend=${backend}&dynamic=${dynamic}`);
    await expect(page.locator('[data-testid="backend"]')).toHaveText(backend);
    const pixel = (await page.locator('[data-testid="pixel"]').textContent())
      ?.split(',')
      .map(Number);
    expect(pixel?.slice(0, 4).every((channel) => channel > 220)).toBe(true);
    const uploads = JSON.parse(
      (await page.locator('[data-testid="pool-uploads"]').textContent()) ?? 'null',
    ) as { dataReady: boolean[]; destinationUploads: number };
    expect(uploads.dataReady).toEqual([false, false, false, false]);
    expect(uploads.destinationUploads).toBe(0);
    if (dynamic === 'after') {
      expect(await page.locator('[data-testid="empty-pixel"]').textContent()).toBe('0,0,0,0');
    }
  }
});

test('baseline uploads its empty destination textures', async ({ page }, testInfo) => {
  test.skip(process.env.VLAM_EXPERIMENT !== 'baseline', 'requires the isolated baseline build');
  const backend = testInfo.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  await page.goto(`/src/viewer/backend-probe.html?backend=${backend}&dynamic=after`);
  await expect(page.locator('[data-testid="backend"]')).toHaveText(backend);
  const uploads = JSON.parse(
    (await page.locator('[data-testid="pool-uploads"]').textContent()) ?? 'null',
  ) as { dataReady: boolean[]; destinationUploads: number };
  expect(uploads.dataReady).toEqual([true, true, true, true]);
  expect(uploads.destinationUploads).toBeGreaterThanOrEqual(4);
});

test('skip-empty handles float formats and packed SH bands', async ({ page }, testInfo) => {
  test.skip(process.env.VLAM_EXPERIMENT !== 'skip-empty', 'requires the isolated skip-empty build');
  const backend = testInfo.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  for (const float16 of [false, true]) {
    for (const bands of [0, 1, 2, 3]) {
      await page.goto(
        `/src/viewer/backend-probe.html?backend=${backend}&dynamic=before&bands=${bands}&float16=${Number(float16)}`,
      );
      await expect(page.locator('[data-testid="backend"]')).toHaveText(backend);
      const pixel = (await page.locator('[data-testid="pixel"]').textContent())
        ?.split(',')
        .map(Number);
      expect(pixel?.slice(0, 4).every((channel) => channel > 220)).toBe(true);
      const uploads = JSON.parse(
        (await page.locator('[data-testid="pool-uploads"]').textContent()) ?? 'null',
      ) as { dataReady: boolean[]; destinationUploads: number };
      expect(uploads.dataReady).toEqual(Array(4 + [0, 1, 2, 4][bands]!).fill(false));
      expect(uploads.destinationUploads).toBe(0);
    }
  }
});

test('skip-empty preserves disjoint, reused, cleared and compacted pixels', async ({
  page,
}, testInfo) => {
  test.skip(process.env.VLAM_EXPERIMENT !== 'skip-empty', 'requires the isolated skip-empty build');
  const backend = testInfo.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  await page.goto(`/src/viewer/empty-pool-lifecycle-probe.html?backend=${backend}`);
  const output = page.locator('[data-testid="result"]');
  await expect(output).not.toHaveText('', { timeout: 30_000 });
  const value = JSON.parse((await output.textContent()) ?? 'null') as {
    error?: string;
    backend: string;
    initial: { samples: number[][]; corner: number[] };
    disjoint: { samples: number[][]; corner: number[] };
    reused: { samples: number[][]; corner: number[] };
    compacted: { samples: number[][]; corner: number[] };
    cleared: { samples: number[][]; corner: number[] };
    filledAgain: { samples: number[][]; corner: number[] };
  };
  expect(value.error, JSON.stringify(value)).toBeUndefined();
  expect(value.backend).toBe(backend);
  expect(value.initial.samples.every((pixel) => pixel[3] === 0)).toBe(true);
  expect(value.disjoint.corner[3]).toBe(0);
  for (const [pixel, channel] of value.disjoint.samples.map((p, i) => [p, i] as const)) {
    expect(pixel[channel]).toBeGreaterThan(pixel[(channel + 1) % 3] as number);
  }
  expect(value.reused.samples[1]![0]).toBeGreaterThan(16);
  expect(value.reused.samples[1]![1]).toBeGreaterThan(16);
  expect(value.reused.samples[1]![2]).toBeLessThan(16);
  expect(value.compacted.samples[0]![3]).toBe(0);
  expect(value.cleared.samples.every((pixel) => pixel[3] === 0)).toBe(true);
  expect(value.filledAgain.samples[1]!.slice(0, 3).every((channel) => channel > 16)).toBe(true);
  await page
    .locator('#preview')
    .screenshot({ path: testInfo.outputPath(`disjoint-${backend}.png`) });
  await testInfo.attach('pool-lifecycle', {
    body: JSON.stringify(value, null, 2),
    contentType: 'application/json',
  });
});
