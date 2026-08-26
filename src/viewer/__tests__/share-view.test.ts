import { describe, expect, it } from 'vitest';

import { parseFpvParam, parseOrbitPlayingParam, writeShareViewSearchParams } from '../share-view';

describe('parseFpvParam', () => {
  it('enables walk for bare, 1, true, and on', () => {
    expect(parseFpvParam('')).toBe(true);
    expect(parseFpvParam('1')).toBe(true);
    expect(parseFpvParam('true')).toBe(true);
    expect(parseFpvParam('on')).toBe(true);
  });

  it('ignores missing or other values', () => {
    expect(parseFpvParam(null)).toBe(false);
    expect(parseFpvParam('0')).toBe(false);
    expect(parseFpvParam('walk')).toBe(false);
  });
});

describe('parseOrbitPlayingParam', () => {
  it('reads paused and playing flags', () => {
    expect(parseOrbitPlayingParam('0')).toBe(false);
    expect(parseOrbitPlayingParam('paused')).toBe(false);
    expect(parseOrbitPlayingParam('1')).toBe(true);
    expect(parseOrbitPlayingParam('on')).toBe(true);
  });

  it('leaves unknown values to the chrome default', () => {
    expect(parseOrbitPlayingParam(null)).toBeNull();
    expect(parseOrbitPlayingParam('maybe')).toBeNull();
  });
});

describe('writeShareViewSearchParams', () => {
  it('writes camera, tool, effect, fpv, and paused orbit', () => {
    const url = new URL('https://vlam.voluma.ai/demo/?scene=goose.sog&separate=1');
    writeShareViewSearchParams(url, {
      position: { x: 1, y: 2, z: 3 },
      target: { x: 0, y: 0.5, z: 0 },
      tool: 'measure',
      effect: 'dof',
      fpv: true,
      orbitPlaying: false,
    });
    expect(url.searchParams.get('cameraPosition')).toBe('1,2,3');
    expect(url.searchParams.get('cameraTarget')).toBe('0,0.5,0');
    expect(url.searchParams.get('tool')).toBe('measure');
    expect(url.searchParams.get('effects')).toBe('dof');
    expect(url.searchParams.get('fpv')).toBe('1');
    expect(url.searchParams.get('orbit')).toBe('0');
    expect(url.searchParams.has('separate')).toBe(false);
  });

  it('drops docs CTA welcome and fallback flags from a copied view', () => {
    const url = new URL('https://vlam.voluma.ai/demo/?scene=Dehaar.lcc2&welcome=1&fallback=goose');
    writeShareViewSearchParams(url, {
      position: { x: 1, y: 2, z: 3 },
      target: { x: 0, y: 0.5, z: 0 },
      tool: 'none',
      effect: null,
      fpv: false,
      orbitPlaying: true,
    });
    expect(url.searchParams.has('welcome')).toBe(false);
    expect(url.searchParams.has('fallback')).toBe(false);
    expect(url.searchParams.get('scene')).toBe('Dehaar.lcc2');
  });

  it('omits default chrome so a playing orbit with no tool stays a camera link', () => {
    const url = new URL('https://vlam.voluma.ai/demo/?tool=paint&effects=demo&fpv=1&orbit=0');
    writeShareViewSearchParams(url, {
      position: { x: 0, y: 0, z: 1 },
      target: { x: 0, y: 0, z: 0 },
      tool: 'none',
      effect: null,
      fpv: false,
      orbitPlaying: true,
    });
    expect(url.searchParams.has('tool')).toBe(false);
    expect(url.searchParams.has('effects')).toBe(false);
    expect(url.searchParams.has('fpv')).toBe(false);
    expect(url.searchParams.has('orbit')).toBe(false);
  });
});
