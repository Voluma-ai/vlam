import { expect, test } from '@playwright/test';

test('preserves Gaussian, DoF, RAD, clipping and picking across material paths', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const backend = info.project.name === 'chromium-webgpu' ? 'webgpu' : 'webgl2';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/src/viewer/render-math-probe.html?backend=${backend}`);
  await expect(page.locator('#result')).not.toHaveText('', { timeout: 150_000 });
  const data = JSON.parse((await page.locator('#result').textContent())!) as {
    backend: string;
    pickOwnership: (number[] | null)[];
    results: {
      name: string;
      unified: boolean;
      pixels: number[];
      initialPixels: number[] | null;
      restoredPixels: number[] | null;
      updatedPixels: number[] | null;
      hit: number[] | null;
    }[];
  };
  expect(data.backend).toBe(backend);
  expect(errors).toEqual([]);
  if (backend === 'webgpu') {
    expect(data.pickOwnership).toHaveLength(3);
    for (const hit of data.pickOwnership) {
      expect(hit).not.toBeNull();
      expect(hit![0]).toBeCloseTo(0, 5);
      expect(hit![1]).toBeCloseTo(0, 5);
      expect(hit![2]).toBeCloseTo(0, 5);
    }
  }
  await page
    .locator('#captures')
    .screenshot({ path: info.outputPath(`${backend}-render-math.png`) });
  for (const unified of backend === 'webgpu' ? [false, true] : [false]) {
    const cases = data.results.filter((result) => result.unified === unified);
    const result = (name: string) => {
      const entry = cases.find((value) => value.name === name);
      expect(entry, name).toBeDefined();
      return entry!;
    };
    const coverage = (name: string) =>
      result(name).pixels.filter((value, i) => i % 4 === 3 && value > 0).length;
    const centerAlpha = (name: string) => result(name).pixels[(32 * 64 + 32) * 4 + 3]!;
    for (const name of [
      'axis',
      'axis-aligned',
      'anisotropic',
      'antialias',
      'lcc',
      'dof',
      'dof-aa',
      'dof-lcc',
      'rad-leaf',
      'rad-merged',
      'fade',
      'isotropic',
      'sh',
    ]) {
      expect(coverage(name), name).toBeGreaterThan(0);
      expect(result(name).pixels.every(Number.isFinite), name).toBe(true);
      expect(result(name).hit, name).not.toBeNull();
      expect(result(name).hit![2], name).toBeCloseTo(0, 5);
    }
    const maxDifference = (a: number[], b: number[]) =>
      Math.max(...a.map((value, i) => Math.abs(value - b[i]!)));
    expect(coverage('rad-whole-zero')).toBe(0);
    expect(centerAlpha('rad-whole-translucent')).toBeGreaterThan(0);
    expect(centerAlpha('rad-whole-translucent')).toBeLessThan(centerAlpha('rad-whole-opaque'));
    expect(maxDifference(result('rad-whole-opaque').pixels, result('rad-reference').pixels)).toBe(
      0,
    );
    expect
      .soft(maxDifference(result('warp-zero').pixels, result('warp-zero-baked').pixels))
      .toBeLessThanOrEqual(2);
    for (const name of ['warp-planet', 'warp-fold']) {
      expect.soft(coverage(name)).toBeGreaterThan(0);
      expect
        .soft(maxDifference(result(name).pixels, result(`${name}-baked`).pixels), name)
        .toBeLessThanOrEqual(2);
      expect.soft(maxDifference(result(name).initialPixels!, result(name).restoredPixels!)).toBe(0);
      expect
        .soft(maxDifference(result(name).pixels, result(name).initialPixels!))
        .toBeGreaterThan(5);
    }
    expect
      .soft(maxDifference(result('relight-default').pixels, result('relight-one').pixels))
      .toBe(0);
    expect.soft(maxDifference(result('relight-zero').pixels, result('axis').pixels)).toBe(0);
    expect
      .soft(maxDifference(result('relight-default').updatedPixels!, result('axis').pixels))
      .toBe(0);
    expect
      .soft(maxDifference(result('relight-zero').updatedPixels!, result('relight-one').pixels))
      .toBe(0);
    expect
      .soft(maxDifference(result('relight-one').pixels, result('axis').pixels))
      .toBeGreaterThan(5);
    expect(maxDifference(result('mixed-before').pixels, result('mixed-compacted').pixels)).toBe(0);
    expect(result('mixed-before').hit).not.toBeNull();
    expect(result('mixed-compacted').hit, `${backend} unified=${unified}`).not.toBeNull();
    expect(result('mixed-compacted').hit![0]).toBeCloseTo(result('mixed-before').hit![0]!, 5);
    expect(result('mixed-removed').hit).toBeNull();
    expect(coverage('mixed-removed')).toBeGreaterThan(0);
    expect(coverage('mixed-removed')).toBeLessThan(coverage('mixed-compacted'));
    expect(coverage('dof')).toBeGreaterThan(coverage('axis'));
    expect(centerAlpha('dof')).toBeLessThan(centerAlpha('axis'));
    expect(centerAlpha('antialias')).toBeLessThan(centerAlpha('axis'));
    expect(coverage('rad-merged')).toBeGreaterThan(coverage('rad-leaf'));
    expect(centerAlpha('fade')).toBeLessThan(centerAlpha('rad-merged'));
    expect(coverage('isotropic')).toBeLessThan(coverage('axis'));
    expect(coverage('edge')).toBeGreaterThan(0);
    expect(result('edge').hit).toBeNull();
    for (const name of ['behind', 'far']) {
      expect(coverage(name), name).toBe(0);
      expect(result(name).hit, name).toBeNull();
    }
  }
});
