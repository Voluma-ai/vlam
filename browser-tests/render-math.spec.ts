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
    results: { name: string; unified: boolean; pixels: number[]; hit: number[] | null }[];
  };
  expect(data.backend).toBe(backend);
  expect(errors).toEqual([]);
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
