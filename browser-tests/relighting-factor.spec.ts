import { expect, test } from '@playwright/test';

test('shadow factor material renders the same umbra without three.js lighting', async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const backend = info.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  await page.goto(`/src/viewer/relighting-factor-probe.html?backend=${backend}`);
  const output = page.locator('[data-testid="result"]');
  await expect(output).not.toHaveText('', { timeout: 45_000 });
  const value = JSON.parse((await output.textContent()) ?? 'null') as {
    error?: string;
    backend: string;
    builtLights: boolean;
    center: number[];
    lit: number[];
    maxDiff: number;
    builtFragmentLength: number | null;
    litFragmentLength: number | null;
  };
  await info.attach('relighting-factor', {
    body: JSON.stringify(value, null, 2),
    contentType: 'application/json',
  });
  expect(value.error, JSON.stringify(value)).toBeUndefined();
  expect(value.backend).toBe(backend);
  // The factor comes only from the material's own shadow nodes, so three.js lighting stays off.
  expect(value.builtLights).toBe(false);
  // Umbra under the occluder (umbra 0.45 of 255), much brighter where the ground is lit.
  const umbra = value.center[0]!;
  const lit = value.lit[0]!;
  expect(umbra).toBeGreaterThan(100);
  expect(umbra).toBeLessThan(130);
  expect(lit).toBeGreaterThan(umbra + 80);
  // Forcing three.js lighting back on changes nothing visible; it only grows the shader.
  expect(value.maxDiff).toBeLessThanOrEqual(2);
  if (value.builtFragmentLength !== null && value.litFragmentLength !== null) {
    expect(value.builtFragmentLength).toBeLessThan(value.litFragmentLength);
  }
});
