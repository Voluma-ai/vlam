import { describe, expect, it, vi } from 'vitest';
import { resolveSplatBudget, type SplatDeviceProfile } from '../core/splat-budget';
import { SplatMesh } from '../core/splat-mesh';
import type { SplatData } from '../core/splat-data';
import { proportionalShares, SplatSceneBudget } from '../loaders/splat-scene-budget';
import { buildZip } from './helpers/store-zip';

const desktop: SplatDeviceProfile = { deviceMemoryGb: 8, isIOS: false, isMobile: false };
const phone: SplatDeviceProfile = { deviceMemoryGb: 8, isIOS: false, isMobile: true };

function data(count: number, extra: Partial<SplatData> = {}): SplatData {
  return {
    count,
    positions: new Float32Array(count * 3),
    colors: new Uint8Array(count * 4).fill(255),
    covariances: new Float32Array(count * 6),
    ...extra,
  };
}

describe('SplatSceneBudget totals', () => {
  it('uses the device default, never above 2^24', () => {
    expect(new SplatSceneBudget({ profile: desktop }).total).toBe(
      resolveSplatBudget(undefined, desktop),
    );
    expect(new SplatSceneBudget({ profile: null, total: 2 ** 30 }).total).toBe(2 ** 24);
    expect(new SplatSceneBudget().total).toBeLessThanOrEqual(2 ** 24);
  });

  it('treats a host total as a cap that cannot lift a device above its tier', () => {
    const tier = resolveSplatBudget(undefined, phone);
    expect(new SplatSceneBudget({ profile: phone, total: 50_000_000 }).total).toBe(tier);
    expect(new SplatSceneBudget({ profile: phone, total: 100_000 }).total).toBe(100_000);
    expect(new SplatSceneBudget({ profile: desktop, total: 4_000_000 }).total).toBe(4_000_000);
    expect(new SplatSceneBudget({ profile: null, total: 12_000_000 }).total).toBe(12_000_000);
  });

  it('rejects a non-positive total', () => {
    expect(() => new SplatSceneBudget({ total: 0 })).toThrow(RangeError);
    expect(() => new SplatSceneBudget({ total: Number.NaN })).toThrow(RangeError);
  });
});

describe('SplatSceneBudget reservations', () => {
  it('grants what is free and accounts commits, releases and in-flight shares', () => {
    const budget = new SplatSceneBudget({ profile: null, total: 1000 });
    const a = budget.reserve(600);
    expect(a.maxSplats).toBe(600);
    expect(budget.free).toBe(400);
    expect(budget.resident).toBe(0); // still decoding

    a.commit(data(550, { sourceCount: 600 }));
    expect(budget.resident).toBe(550);
    expect(budget.free).toBe(450);

    // Committed data cannot give anything back, so B takes what is free.
    const b = budget.reserve(900);
    expect(b.maxSplats).toBe(450);
    expect(budget.free).toBe(0);
    b.release();
    expect(budget.free).toBe(450);
    b.release();
    expect(b.commit(data(1))).toHaveProperty('count', 1); // settled already: ignored
    expect(budget.resident).toBe(550);

    const c = budget.reserve(undefined);
    expect(c.maxSplats).toBe(450);
  });

  it('follows the mesh built from committed data and frees it on dispose', () => {
    const budget = new SplatSceneBudget({ profile: null, total: 1000 });
    const reservation = budget.reserve(10);
    const loaded = data(10, { drawOrder: Uint32Array.from({ length: 10 }, (_, i) => 9 - i) });
    reservation.commit(loaded);
    expect(budget.resident).toBe(10);

    const mesh = new SplatMesh(loaded);
    expect(mesh.budgetedSplatCount).toBe(10);
    expect(budget.resident).toBe(10);
    // The active list stays in pool order; the draw order is retained aside.
    expect(mesh.activeSplatCount).toBe(10);

    mesh.dispose();
    expect(budget.resident).toBe(0);
    expect(budget.free).toBe(1000);
  });

  it('discards data that never became a mesh', () => {
    const budget = new SplatSceneBudget({ profile: null, total: 100 });
    const reservation = budget.reserve(40);
    const loaded = data(40);
    reservation.commit(loaded);
    expect(budget.free).toBe(60);
    budget.discard(loaded);
    expect(budget.free).toBe(100);
  });

  it('rejects a draw order that does not match the splat count', () => {
    expect(() => new SplatMesh(data(3, { drawOrder: new Uint32Array(2) }))).toThrow(/drawOrder/);
  });
});

describe('SplatSceneBudget planning', () => {
  it('splits proportionally, never above a file or the total', () => {
    const shares = proportionalShares([10_000_000, 1_000_000, 20_000_000], 16_000_000);
    expect(shares).toEqual([5_161_290, 516_129, 10_322_580]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(16_000_000);
    expect(proportionalShares([3, 4], 100)).toEqual([3, 4]);
    expect(proportionalShares([1, 1, 1], 2).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2);
  });

  it('plans shares from file headers and grants them on reserve', async () => {
    const budget = new SplatSceneBudget({ profile: null, total: 3000 });
    const ply = new File(
      ['ply\nformat binary_little_endian 1.0\nelement vertex 3000\nproperty float x\nend_header\n'],
      'a.ply',
    );
    const sog = new File(
      [buildZip({ 'meta.json': JSON.stringify({ version: 2, count: 1000 }) })],
      'b.sog',
    );
    const unknown = new File([new Uint8Array(4)], 'c.rad');
    await budget.plan([ply, sog, unknown]);

    expect(budget.reserve(3000, ply).maxSplats).toBe(2250);
    expect(budget.reserve(1000, sog).maxSplats).toBe(750);
    expect(budget.free).toBe(0);
    // Unplanned and nothing free: it still gets its share of the scene
    // (500 of 4500 splats → 333), reclaimed from the two files in flight.
    expect(budget.reserve(500, unknown).maxSplats).toBe(333);
  });
});

describe('SplatSceneBudget with files decoding side by side', () => {
  /** Decoded data for a reservation, as the worker would thin it. */
  function decoded(count: number, share: number): SplatData {
    const kept = Math.min(count, share);
    return data(kept, {
      drawOrder: Uint32Array.from({ length: kept }, (_, i) => kept - 1 - i),
      ...(kept < count ? { sourceCount: count } : {}),
    });
  }

  it('never starves a file that asks while another is still loading', () => {
    const budget = new SplatSceneBudget({ profile: null, total: 12_000 });
    const a = budget.reserve(20_000);
    const b = budget.reserve(20_000);
    expect(a.maxSplats).toBe(12_000);
    expect(b.maxSplats).toBe(6_000);

    // A commits while over-committed: it gives back its excess before any
    // mesh is built, keeping the head of its draw order.
    const aData = a.commit(decoded(20_000, a.maxSplats));
    expect(aData.count).toBe(6_000);
    expect(aData.sourceCount).toBe(20_000);
    expect(Array.from(aData.drawOrder ?? []).slice(0, 3)).toEqual([5_999, 5_998, 5_997]);
    const bData = b.commit(decoded(20_000, b.maxSplats));
    expect(bData.count).toBe(6_000);
    expect(budget.resident).toBe(12_000);
    expect(budget.free).toBe(0);
    new SplatMesh(aData).dispose();
  });

  it('shrinks an attached mesh that was built before the over-commit cleared', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const budget = new SplatSceneBudget({ profile: null, total: 1_000 });
    const a = budget.reserve(1_000);
    const b = budget.reserve(1_000); // fair 500, reclaimable from A
    expect(b.maxSplats).toBe(500);
    const bData = b.commit(decoded(1_000, b.maxSplats));
    const bMesh = new SplatMesh(bData);
    const aData = a.commit(decoded(1_000, a.maxSplats));
    expect(aData.count).toBe(500);
    expect(bMesh.budgetedSplatCount).toBe(500);
    expect(budget.resident).toBe(1_000);
    bMesh.dispose();
  });
});
