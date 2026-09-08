# Get started

Install VLAM! and render a splat scene in a three.js app. The
[getting-started guide](/guide/getting-started) is the authoritative walkthrough
for renderer setup, loading, resizing, and disposal; its samples are compiled
against the current package.

## Install

```bash
npm install @voluma/vlam three
```

`three` is a peer dependency (`>= 0.185.0`).

## Minimal example

<<< ../docs/guide/samples/getting-started-basic.ts

Call `splats.update(camera, renderer)` every frame before `renderer.render`.
For the reasoning behind the helper, loading alternatives, resize handling,
and cleanup, continue with the [full guide](/guide/getting-started).

For an interactive camera-controls version, see [Your first viewer](/examples/first-viewer).

## Next

- [Examples](/examples/): explained walkthroughs, starting with a viewer you can drag
- [FAQ](/faq): formats, CORS, and the short version
- [API reference](/api/): every exported symbol
- <a href="/demo/" target="_self">Full viewer</a>: try scenes in the browser
