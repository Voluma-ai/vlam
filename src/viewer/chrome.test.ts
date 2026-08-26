import { describe, expect, it } from 'vitest';

import {
  parseGooseFallbackParam,
  parseWelcomeExpandedParam,
  viewerChromeForPreset,
} from './chrome';

describe('viewerChromeForPreset', () => {
  it('runs the cinematic orbit in the home-page embed without showing its toggle', () => {
    const chrome = viewerChromeForPreset('embed');

    expect(chrome.cinematicOrbit).toBe(true);
    expect(chrome.cinematicOrbitToggle).toBe(false);
  });

  it('starts the cinematic orbit paused with its toggle in the full viewer', () => {
    const chrome = viewerChromeForPreset('full');

    expect(chrome.cinematicOrbit).toBe(false);
    expect(chrome.cinematicOrbitToggle).toBe(true);
  });
});

describe('parseWelcomeExpandedParam', () => {
  it('enables the docs Open demo pickers', () => {
    expect(parseWelcomeExpandedParam('1')).toBe(true);
    expect(parseWelcomeExpandedParam('true')).toBe(true);
  });

  it('ignores missing or other values', () => {
    expect(parseWelcomeExpandedParam(null)).toBe(false);
    expect(parseWelcomeExpandedParam('0')).toBe(false);
  });
});

describe('parseGooseFallbackParam', () => {
  it('opts in only for fallback=goose', () => {
    expect(parseGooseFallbackParam('goose')).toBe(true);
    expect(parseGooseFallbackParam('1')).toBe(false);
    expect(parseGooseFallbackParam(null)).toBe(false);
  });
});
