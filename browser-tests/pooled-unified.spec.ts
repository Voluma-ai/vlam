import { expect, test } from '@playwright/test';

/**
 * The pooled unified draw inter-sorts a static and a dynamic source sharing
 * one pool on both backends - the WebGL2 project is the one that matters,
 * since the compute unified path never runs there.
 */
test('pooled unified draw composites the nearer source in front from either side', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const backend = testInfo.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    if (error.message.includes('Instance dropped in popErrorScope')) return;
    errors.push(error.message);
  });
  await page.goto(`/src/viewer/pooled-unified-probe.html?backend=${backend}`);
  const result = page.locator('[data-testid="result"]');
  await expect
    .poll(async () => errors[0] ?? (await result.textContent()), { timeout: 75_000 })
    .not.toBe('');
  expect(errors).toEqual([]);
  const text = (await result.textContent()) ?? 'null';
  expect(text).not.toContain('"error"');
  const value = JSON.parse(text) as {
    backend: string;
    standaloneHidden: boolean;
    positiveCount: number;
    fromPositiveZ: number[];
    fromNegativeZ: number[];
    blueHidden: number[];
    moved: number[];
    movedCenter: number[];
    blueFaded: number[];
    blueRemoved: number[];
    blueStandaloneAgain: boolean;
  };
  expect(value.backend).toBe(backend);
  expect(value.standaloneHidden).toBe(true);
  expect(value.positiveCount).toBe(2);
  // Red (z = +0.1) is nearer from +Z: it composites over blue, so red wins
  // the center pixel; from -Z blue is nearer and wins.
  expect(value.fromPositiveZ[0]!).toBeGreaterThan(value.fromPositiveZ[2]!);
  expect(value.fromNegativeZ[2]!).toBeGreaterThan(value.fromNegativeZ[0]!);
  // Both contribute: neither view is a single pure source.
  expect(value.fromPositiveZ[2]!).toBeGreaterThan(8);
  expect(value.fromNegativeZ[0]!).toBeGreaterThan(8);
  // Hidden, faded and removed blue leave only red at the center.
  for (const pixel of [value.blueHidden, value.blueFaded, value.blueRemoved]) {
    expect(pixel[2]!).toBeLessThan(8);
    expect(pixel[0]!).toBeGreaterThan(60);
  }
  // A moved source draws at its new placement: blue appears right of center
  // and no longer contributes at the center.
  expect(value.moved[2]!).toBeGreaterThan(8);
  expect(value.movedCenter[2]!).toBeLessThan(value.fromPositiveZ[2]!);
  expect(value.blueStandaloneAgain).toBe(true);
});
