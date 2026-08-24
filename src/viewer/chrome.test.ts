import { describe, expect, it } from 'vitest';

import { viewerChromeForPreset } from './chrome';

describe('viewerChromeForPreset', () => {
  it('runs the cinematic orbit in the home-page embed without showing its toggle', () => {
    const chrome = viewerChromeForPreset('embed');

    expect(chrome.cinematicOrbit).toBe(true);
    expect(chrome.cinematicOrbitToggle).toBe(false);
  });

  it('runs the cinematic orbit with its toggle in the full viewer', () => {
    const chrome = viewerChromeForPreset('full');

    expect(chrome.cinematicOrbit).toBe(true);
    expect(chrome.cinematicOrbitToggle).toBe(true);
  });
});
