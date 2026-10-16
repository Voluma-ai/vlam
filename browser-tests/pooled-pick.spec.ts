import { expect, test } from '@playwright/test';

type Point = [number, number, number] | null;

/**
 * Pooled tenants are hidden from the scene draw and pick through their own
 * pass. WebGL2 has no storage buffers, so that pass must still read each
 * source's active list per instance; the WebGL2 project is the one that matters.
 */
test('pooled tenants pick their own splats on both backends', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const backend = testInfo.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    if (error.message.includes('Instance dropped in popErrorScope')) return;
    errors.push(error.message);
  });
  await page.goto(`/src/viewer/pooled-pick-probe.html?backend=${backend}`);
  const result = page.locator('[data-testid="result"]');
  await expect
    .poll(async () => errors[0] ?? (await result.textContent()), { timeout: 75_000 })
    .not.toBe('');
  expect(errors).toEqual([]);
  const text = (await result.textContent()) ?? 'null';
  expect(text).not.toContain('"error"');
  const value = JSON.parse(text) as {
    backend: string;
    tenantsHidden: boolean;
    mainX: number;
    /** Each list: [on a main splat, the gap beside it, empty space, on a marker splat]. */
    reference: Point[];
    main: Point[];
    mainSingle: Point;
    marker: Point[];
    pooled: Point[];
  };
  expect(value.backend).toBe(backend);
  expect(value.tenantsHidden).toBe(true);

  const expectHit = (hit: Point, x: number, y: number, z: number, label: string) => {
    expect(hit, label).not.toBeNull();
    expect(hit![0], label).toBeCloseTo(x, 1);
    expect(hit![1], label).toBeCloseTo(y, 1);
    expect(hit![2], label).toBeCloseTo(z, 1);
  };
  // The standalone reference anchors the expectations on this backend.
  expectHit(value.reference[0]!, value.mainX, 0, 0, 'reference on main');
  expect(value.reference.slice(1, 3)).toEqual([null, null]);

  expectHit(value.main[0]!, value.mainX, 0, 0, 'main on main');
  expectHit(value.mainSingle, value.mainX, 0, 0, 'main single pick');
  expect(value.main.slice(1)).toEqual([null, null, null]);

  expect(value.marker.slice(0, 3)).toEqual([null, null, null]);
  expectHit(value.marker[3]!, 0, 0.5, -0.2, 'marker on marker');

  expectHit(value.pooled[0]!, value.mainX, 0, 0, 'pooled on main');
  expect(value.pooled.slice(1, 3)).toEqual([null, null]);
  expectHit(value.pooled[3]!, 0, 0.5, -0.2, 'pooled on marker');
});
