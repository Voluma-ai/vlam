import { expect, test } from '@playwright/test';
for (const strategy of ['counting', 'radix', 'exact']) {
  test(`${strategy} sort follows sortDisplacement`, async ({ page }, info) => {
    test.skip(!info.project.name.startsWith('chromium-webgpu'));
    test.setTimeout(120000);
    const runtimePlatform = await page.evaluate(() => navigator.platform);
    test.fixme(
      info.project.name === 'chromium-webgpu' && runtimePlatform.startsWith('Linux'),
      'Chromium Linux SwiftShader drops its external Dawn instance during sort GPUBuffer readback.',
    );
    await page.goto(`/src/viewer/sort-displacement-probe.html?sort=${strategy}`);
    await expect(page.locator('#result')).not.toHaveText('', { timeout: 110000 });
    const result = await page.locator('#result').innerText();
    console.log(result);
    expect(result).not.toContain('Error');
    const report = JSON.parse(result) as {
      displaced: number;
      staleWithoutInvalidate: number;
      afterInvalidate: number;
      withoutDisplacement: number;
    };
    expect(report.displaced).toBe(0);
    expect(report.afterInvalidate).toBe(0);
    // Controls: the probe can see a wrong order, so the zeros above mean something.
    expect(report.staleWithoutInvalidate).toBeGreaterThan(0);
    expect(report.withoutDisplacement).toBeGreaterThan(0);
  });
}
