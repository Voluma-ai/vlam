import { expect, test } from '@playwright/test';
for (const strategy of ['counting', 'radix', 'exact']) {
  test(`streaming ${strategy} permutation`, async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium-webgpu');
    test.setTimeout(120000);
    await page.goto(`/src/viewer/sort-stream-probe.html?sort=${strategy}`);
    await expect(page.locator('#result')).not.toHaveText('', { timeout: 110000 });
    const result = await page.locator('#result').innerText();
    console.log(result);
    expect(result).not.toContain('Error');
    const reports = JSON.parse(result) as {
      duplicates: number;
      invalid: number;
      inversions: number;
    }[];
    expect(reports).toHaveLength(6);
    for (const report of reports)
      expect(report).toMatchObject({ duplicates: 0, invalid: 0, inversions: 0 });
  });
}
