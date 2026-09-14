import { expect, test } from '@playwright/test';

test('mixed flat triangle retains application state after the benchmark render', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-webgl2');
  await page.goto('/src/viewer/provoking-vertex-probe.html');
  const output = page.locator('[data-testid="result"]');
  await expect(output).not.toHaveText('');
  const result = JSON.parse((await output.textContent()) ?? 'null') as {
    before: number[];
    during: number[];
    after: number[];
    state: {
      supported: boolean;
      initialConvention: number | null;
      currentConvention: number | null;
    };
  };
  expect(result.before[2]).toBeGreaterThan(240);
  expect(result.after).toEqual(result.before);
  expect(result.state.currentConvention).toBe(result.state.initialConvention);
  if (result.state.supported) expect(result.during[0]).toBeGreaterThan(240);
  else expect(result.during).toEqual(result.before);
});
