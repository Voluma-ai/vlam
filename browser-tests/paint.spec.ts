import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('renders a surface-aware painted channel on both backends', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const backend = testInfo.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    // Three's sync pipeline compile leaves popErrorScope untracked. Chromium
    // Linux SwiftShader (CI) can then reject it as "Instance dropped" after
    // pixels are already correct. createWebGPURenderer guards this on the
    // owned device; ignore the leftover in case the host object was frozen.
    if (error.message.includes('Instance dropped in popErrorScope')) return;
    errors.push(error.message);
  });
  await page.goto(`/src/viewer/paint-probe.html?backend=${backend}`);
  const result = page.locator('[data-testid="result"]');
  await expect
    .poll(async () => errors[0] ?? (await result.textContent()), { timeout: 75_000 })
    .not.toBe('');
  expect(errors).toEqual([]);
  const value = JSON.parse((await result.textContent()) ?? 'null') as {
    backend: string;
    batchPicks: (number[] | null)[];
    affinePreviews: { kind: string; maxDifference: number; selected: number }[];
    paintedMode: { depth: string; footprint: string };
    modes: {
      surfaceCenter: number;
      throughCenter: number;
      surfaceFootprint: number;
      throughFootprint: number;
    };
    changedPixels: number;
    centerBefore: number[];
    centerAfter: number[];
  };

  expect(errors).toEqual([]);
  expect(value.batchPicks.every((hit) => hit !== null)).toBe(true);
  expect(value.batchPicks[1]![1]).toBeGreaterThan(value.batchPicks[0]![1]!);
  expect(value.affinePreviews).toHaveLength(3);
  for (const preview of value.affinePreviews) {
    expect(preview.selected, preview.kind).toBe(1);
    expect(preview.maxDifference, preview.kind).toBeLessThanOrEqual(2);
  }
  const captures = await page.locator('#affine-captures canvas').evaluateAll((canvases) =>
    canvases.map((canvas) => ({
      kind: (canvas as HTMLCanvasElement).title,
      pixels: JSON.parse((canvas as HTMLCanvasElement).dataset.pixels!) as number[],
    })),
  );
  const capturePath = testInfo.outputPath(`${backend}-affine-rgb.json`);
  writeFileSync(capturePath, JSON.stringify(captures));
  await testInfo.attach(`${backend}-affine-rgb`, {
    path: capturePath,
    contentType: 'application/json',
  });
  await page
    .locator('#affine-captures')
    .screenshot({ path: testInfo.outputPath(`${backend}-affine-previews.png`) });
  expect(value.backend).toBe(backend);
  expect(value.paintedMode).toEqual({ depth: 'surface', footprint: 'center' });
  expect(value.modes).toEqual({
    surfaceCenter: 1,
    throughCenter: 2,
    surfaceFootprint: 2,
    throughFootprint: 3,
  });
  expect(value.changedPixels).toBeGreaterThan(20);
  expect(value.centerAfter).not.toEqual(value.centerBefore);
  expect(value.centerAfter[0]).toBeGreaterThan(value.centerBefore[0] as number);
  expect(value.centerAfter[2]).toBeGreaterThan(value.centerBefore[2] as number);
});
