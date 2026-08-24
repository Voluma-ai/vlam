---
layout: page
title: VLAM!
---

<div class="vlam-home">
  <header class="vlam-hero">
    <img class="vlam-logo vlam-logo-light" src="/vlam-light.png" alt="VLAM!" width="160" height="160" />
    <img class="vlam-logo vlam-logo-dark" src="/vlam.png" alt="VLAM!" width="120" height="120" />
    <h1 class="visually-hidden">VLAM!</h1>
    <p class="vlam-lead">
      A WebGPU Gaussian splat viewer for three.js.
      Load common formats, stream large scenes, add custom shader effects and render inside your own scene graph.
    </p>
    <p class="vlam-actions">
      <a class="vlam-btn" href="/get-started">Get started</a>
      <a class="vlam-btn vlam-btn-ghost" href="/demo/" target="_self">Open demo</a>
    </p>
    <br/>
    <PreReleaseNotice variant="hero" />
  </header>

  <section class="vlam-embed" aria-label="Interactive viewer">
    <iframe
      class="vlam-viewer-frame"
      src="/demo/?preset=embed"
      title="VLAM! viewer"
      allow="fullscreen"
    ></iframe>
  </section>
</div>

<style>
.vlam-home {
  max-width: 960px;
  margin: 0 auto;
  padding: 1.5rem 1.25rem 3rem;
}
.vlam-hero {
  text-align: center;
  margin-bottom: 1.5rem;
}
.vlam-logo {
  display: block;
  margin: 0 auto 0.75rem;
}
.vlam-logo-dark {
  display: none;
}
.dark .vlam-logo-light {
  display: none;
}
.dark .vlam-logo-dark {
  display: block;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.vlam-hero h1 {
  margin: 0 0 0.5rem;
  font-size: 2.4rem;
  letter-spacing: 0.02em;
}
.vlam-lead {
  margin: 0 auto 1.25rem;
  max-width: 40rem;
  color: var(--vp-c-text-1);
  line-height: 1.5;
}
.vlam-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  justify-content: center;
  margin: 0;
}
.vlam-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.55rem 1.1rem;
  border-radius: 8px;
  background: var(--vp-c-brand-1);
  color: #fff;
  font-weight: 600;
  text-decoration: none;
}
.vlam-btn:hover {
  background: var(--vp-c-brand-2);
}
.vlam-btn-ghost {
  background: transparent;
  color: var(--vp-c-brand-1);
  border: 1px solid var(--vp-c-brand-1);
}
.vlam-btn-ghost:hover {
  background: var(--vp-c-bg-soft);
}
.vlam-embed {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  background: #1a1a1f;
  /* `width` must be explicit: with only `aspect-ratio` and a definite
     `min-height`, the height drives the width (420 × 1.6 = 672px) and the
     frame overflows a phone-width container instead of fitting it. */
  width: 100%;
  aspect-ratio: 16 / 10;
  min-height: 420px;
  /* The iframe document sets `touch-action: none` too; without it here iOS
     double-tap-zooms the parent page and cancels the inner teleport. */
  touch-action: none;
}
.vlam-viewer-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #1a1a1f;
  touch-action: none;
}
</style>
