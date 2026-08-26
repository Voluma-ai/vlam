---
layout: page
title: Quest XR tests
description: One-click Quest XR stability comparisons for the VLAM! viewer.
---

<main class="xr-test-page">
  <header class="xr-test-header">
    <p class="xr-test-kicker">Quest XR stability harness</p>
    <h1>Choose a test</h1>
    <p>
      Run each test for about 30 seconds while turning and leaning. Open the Meta system menu
      briefly too. Exit VR before choosing the next test so framebuffer changes take effect.
    </p>
  </header>

  <section aria-labelledby="start-tests">
    <h2 id="start-tests">Start here</h2>
    <div class="xr-test-grid">
      <a class="xr-test-card xr-test-card-primary" href="/demo/?backend=webgl&amp;xrDiagnostics=1&amp;xrStability=1&amp;xrScale=0.7&amp;xrSortHz=30&amp;xrDepth=off" target="_self">
        <strong>Recommended stability</strong>
        <span>Scale 0.7 · sort 30 Hz · depth off</span>
      </a>
      <a class="xr-test-card" href="/demo/?backend=webgl&amp;xrDiagnostics=1&amp;xrStability=0&amp;xrScale=0.8&amp;xrSortHz=0&amp;xrDepth=off" target="_self">
        <strong>Current baseline</strong>
        <span>Scale 0.8 · unrestricted sort · depth off</span>
      </a>
      <a class="xr-test-card xr-test-card-warning" href="/demo/?backend=webgl&amp;xrDiagnostics=1&amp;xrStability=1&amp;xrScale=0.5&amp;xrSortHz=15&amp;xrDepth=off" target="_self">
        <strong>Aggressive performance</strong>
        <span>Scale 0.5 · sort 15 Hz · depth off</span>
      </a>
    </div>
  </section>

  <section aria-labelledby="isolate-tests">
    <h2 id="isolate-tests">Isolate scale and sorting</h2>
    <div class="xr-test-grid">
      <a class="xr-test-card" href="/demo/?backend=webgl&amp;xrDiagnostics=1&amp;xrStability=0&amp;xrScale=0.7&amp;xrSortHz=0&amp;xrDepth=off" target="_self">
        <strong>Scale only</strong>
        <span>Scale 0.7 · unrestricted sort</span>
      </a>
      <a class="xr-test-card" href="/demo/?backend=webgl&amp;xrDiagnostics=1&amp;xrStability=0&amp;xrScale=0.8&amp;xrSortHz=30&amp;xrDepth=off" target="_self">
        <strong>Sort throttle only</strong>
        <span>Scale 0.8 · sort 30 Hz</span>
      </a>
    </div>
  </section>

  <section aria-labelledby="complex-scenes">
    <h2 id="complex-scenes">Complex scenes</h2>
    <p class="xr-test-note">
      These use Recommended stability with diagnostics enabled. Allow the scene to settle before
      beginning the 30-second motion test.
    </p>
    <div class="xr-test-grid">
      <a class="xr-test-card xr-test-card-primary" href="/demo/?scene=%2Fremote%2Fjack%2Fv%2Fsandwijck-lod%2Flod-meta.json&amp;backend=webgl&amp;xrDiagnostics=1&amp;xrStability=1&amp;xrScale=0.7&amp;xrSortHz=30&amp;xrDepth=off" target="_self">
        <strong>Sandwijck LOD</strong>
        <span>Streamed SOG · recommended stability</span>
      </a>
      <a class="xr-test-card xr-test-card-primary" href="/demo/?scene=%2Fremote%2Fjack%2Fv%2FDehaar%2FDehaar.lcc2&amp;backend=webgl&amp;xrDiagnostics=1&amp;xrStability=1&amp;xrScale=0.7&amp;xrSortHz=30&amp;xrDepth=off" target="_self">
        <strong>Dehaar LCC2</strong>
        <span>Streamed octree · recommended stability</span>
      </a>
    </div>
  </section>

  <section aria-labelledby="depth-tests">
    <h2 id="depth-tests">Experimental depth</h2>
    <p class="xr-test-note">
      Compare these with Recommended stability. Look for holes, hard edges, or incorrect
      occlusion around the goose.
    </p>
    <div class="xr-test-grid">
      <a class="xr-test-card" href="/demo/?backend=webgl&amp;xrDiagnostics=1&amp;xrStability=1&amp;xrScale=0.7&amp;xrSortHz=30&amp;xrDepth=0.05" target="_self">
        <strong>Depth 0.05</strong>
        <span>Most transparent tails retained</span>
      </a>
      <a class="xr-test-card" href="/demo/?backend=webgl&amp;xrDiagnostics=1&amp;xrStability=1&amp;xrScale=0.7&amp;xrSortHz=30&amp;xrDepth=0.15" target="_self">
        <strong>Depth 0.15</strong>
        <span>Balanced alpha threshold</span>
      </a>
      <a class="xr-test-card" href="/demo/?backend=webgl&amp;xrDiagnostics=1&amp;xrStability=1&amp;xrScale=0.7&amp;xrSortHz=30&amp;xrDepth=0.3" target="_self">
        <strong>Depth 0.3</strong>
        <span>Strongest cutoff; watch for holes</span>
      </a>
    </div>
  </section>

  <aside class="xr-test-help">
    The green cube is the opaque reference. If the cube, goose, and Meta menu all judder, the
    whole XR session is missing frame deadlines. Diagnostic JSON is logged as
    <code>XR_DIAGNOSTIC</code> every ten seconds and when VR ends.
  </aside>
</main>

<style>
.xr-test-page {
  max-width: 880px;
  margin: 0 auto;
  padding: 1.25rem 1rem 4rem;
}
.xr-test-header {
  margin-bottom: 2rem;
}
.xr-test-header h1 {
  margin: 0.15rem 0 0.75rem;
  font-size: clamp(2rem, 7vw, 3.25rem);
  line-height: 1.05;
}
.xr-test-header p:last-child {
  max-width: 44rem;
  color: var(--vp-c-text-2);
  font-size: 1.05rem;
  line-height: 1.6;
}
.xr-test-kicker {
  margin: 0;
  color: var(--vp-c-brand-1);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.xr-test-page section {
  margin-top: 2.25rem;
}
.xr-test-page h2 {
  margin: 0 0 0.9rem;
  border: 0;
  font-size: 1.35rem;
}
.xr-test-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 0.85rem;
}
.xr-test-card {
  display: flex;
  min-height: 112px;
  flex-direction: column;
  justify-content: center;
  gap: 0.4rem;
  padding: 1.1rem 1.2rem;
  border: 2px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  text-decoration: none;
  touch-action: manipulation;
}
.xr-test-card:hover,
.xr-test-card:focus-visible {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg-alt);
}
.xr-test-card strong {
  font-size: 1.08rem;
}
.xr-test-card span {
  color: var(--vp-c-text-2);
  line-height: 1.4;
}
.xr-test-card-primary {
  border-color: var(--vp-c-brand-1);
  background: color-mix(in srgb, var(--vp-c-brand-1) 14%, var(--vp-c-bg));
}
.xr-test-card-warning {
  border-color: var(--vp-c-warning-1);
}
.xr-test-note {
  margin: -0.3rem 0 1rem;
  color: var(--vp-c-text-2);
}
.xr-test-help {
  margin-top: 2.5rem;
  padding: 1rem 1.1rem;
  border-left: 4px solid var(--vp-c-brand-1);
  border-radius: 0 10px 10px 0;
  background: var(--vp-c-bg-soft);
  line-height: 1.55;
}
@media (max-width: 520px) {
  .xr-test-page {
    padding-inline: 0.25rem;
  }
  .xr-test-grid {
    grid-template-columns: 1fr;
  }
  .xr-test-card {
    min-height: 104px;
  }
}
</style>
