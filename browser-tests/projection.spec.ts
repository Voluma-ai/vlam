import { expect, test } from '@playwright/test';

test('compute projection has exact dense coverage and indirect arguments', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-webgpu');
  test.setTimeout(180_000);
  const runtimePlatform = await page.evaluate(() => navigator.platform);
  test.fixme(
    runtimePlatform.startsWith('Linux'),
    'Chromium Linux SwiftShader drops its external Dawn instance during projection GPUBuffer readback.',
  );
  await page.goto('/src/viewer/projection-probe.html?renderOnly=1');
  const result = page.locator('[data-testid="result"]');
  await expect(result).not.toHaveText('', { timeout: 120_000 });
  const text = (await result.textContent()) ?? 'null';
  expect(text).not.toContain('"error"');
  const value = JSON.parse(text) as {
    standalone: {
      count: number;
      visible: number[];
      dispatch: number[];
      draw: number[];
      order: number[];
      pixel: number[];
      vertexParity?: { differentChannels: number; maxChannelDifference: number };
    };
    unified: {
      count: number;
      visible: number[];
      dispatch: number[];
      draw: number[];
      order: number[];
      pixel: number[];
    };
    gooseParity: { differentChannels: number; maxChannelDifference: number };
    picking: { frontZ: number | null; backZ: number | null; displayChangedChannels: number };
    renderOnlyPicking: { released: boolean; backZ: number | null } | null;
  };
  for (const path of [value.standalone, value.unified]) {
    expect(path.count).toBe(2);
    expect(path.visible).toEqual([0, 1]);
    expect(path.dispatch).toEqual([1, 1, 1]);
    expect(path.draw).toEqual([6, 2, 0, 0, 0]);
    expect(new Set(path.order)).toEqual(new Set([0, 1]));
    expect(path.pixel[3]).toBeGreaterThan(220);
  }
  expect(value.standalone.vertexParity).toEqual({ differentChannels: 0, maxChannelDifference: 0 });
  // Projection in a compute shader and in a vertex shader may round their
  // final float differently. At 1280×720 the real SOG comparison is still
  // pixel-equivalent: only a few hundred of 3.7M channels may differ by ≤2.
  expect(value.gooseParity.differentChannels).toBeLessThanOrEqual(512);
  expect(value.gooseParity.maxChannelDifference).toBeLessThanOrEqual(2);
  expect(value.picking.frontZ).toBeCloseTo(0, 3);
  expect(value.picking.backZ).toBeCloseTo(3, 3);
  expect(value.picking.displayChangedChannels).toBe(0);
  expect(value.renderOnlyPicking?.released).toBe(true);
  expect(value.renderOnlyPicking?.backZ).toBeCloseTo(3, 3);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('projection.png') });
});
