import { describe, expect, it } from 'vitest';
import { demoSortStrategy } from './sort-policy';

const hd = { override: null, constrainedDevice: false, sd: false, profile: undefined } as const;

describe('demo sorting defaults', () => {
  it.each(['castle.lcc', '/remote/castle.LCC2', 'https://example.test/castle.lcc2?token=x#view'])(
    'uses stable radix for desktop HD %s',
    (scene) => expect(demoSortStrategy(scene, hd)).toBe('radix'),
  );

  it.each(['goose.sog', 'scene.rad', 'lod-meta.json', 'scene.ply?fallback=castle.lcc2'])(
    'retains counting for %s',
    (scene) => expect(demoSortStrategy(scene, hd)).toBe('counting'),
  );

  it.each(['castle.lcc', 'castle.lcc2'])('keeps cheaper profiles on counting for %s', (scene) => {
    expect(demoSortStrategy(scene, { ...hd, constrainedDevice: true })).toBe('counting');
    expect(demoSortStrategy(scene, { ...hd, sd: true })).toBe('counting');
    expect(demoSortStrategy(scene, { ...hd, profile: 'smooth' })).toBe('counting');
    expect(demoSortStrategy(scene, { ...hd, sd: true, profile: 'quality' })).toBe('counting');
  });

  it.each(['counting', 'radix', 'exact', 'worker'] as const)(
    'honors explicit %s on every profile',
    (override) => {
      expect(demoSortStrategy('castle.lcc2', { ...hd, override })).toBe(override);
      expect(
        demoSortStrategy('goose.sog', {
          ...hd,
          override,
          sd: true,
          constrainedDevice: true,
          profile: 'smooth',
        }),
      ).toBe(override);
    },
  );

  it('falls back to the format policy for an unrecognized override', () => {
    expect(demoSortStrategy('castle.lcc2', { ...hd, override: 'typo' })).toBe('radix');
  });
});
