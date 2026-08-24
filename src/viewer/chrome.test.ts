import { describe, expect, it } from 'vitest';

import { viewerChromeForPreset } from './chrome';

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
