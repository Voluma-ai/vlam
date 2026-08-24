# View it in VR

**What you get:** a capture at life size with an Enter VR button.

<ExampleEmbed slug="in-vr" hint="Needs a WebXR headset, the button says what your browser supports" />

## Why captures are worth the headset

Photogrammetry captures work especially well in a headset because they preserve
the scale of a real place. The render loop already supports WebXR; the main
change is the rendering budget.

## A headset is a much harder deadline

| | Monitor | Headset |
| --- | --- | --- |
| Views per frame | 1 | 2 |
| Refresh | 60 Hz | 90–120 Hz |
| Cost of a dropped frame | a stutter | physical discomfort |

This is roughly three times the work with a stricter frame deadline. Do not reuse
the page budget unchanged.

`resolveXrSplatBudget(pageBudget)` clamps a page budget to what a headset can actually hold. On a streamed mesh, apply it with `setBudget` when the session starts, and restore the page budget when it ends.

`recommendedXrFramebufferScale()` is the other half: a scale of 0.8 can recover
substantial fill rate with little visible loss.

## `xrSessionInit` exists because of the backend

When requesting a session, pass the renderer-specific initialization:

```ts
const session = await navigator.xr.requestSession('immersive-vr', xrSessionInit(renderer, {
  optionalFeatures: ['local-floor'],
}));
await renderer.xr.setSession(session);
```

`xrSessionInit` merges what the renderer's backend requires, the `'webgpu'` required feature, when that is the backend in use, into whatever features you asked for. Skip it and a WebGPU session request fails in a way that reads like a browser bug.

## The code

::: code-group

<<< ../../docs/examples/samples/in-vr.ts [main.ts]

```html [index.html]
<!doctype html>
<html>
 <head>
 <meta charset="utf-8" />
 <style>
 body {
 margin: 0;
 overflow: hidden;
 font: 14px system-ui;
 }
 #ui {
 position: fixed;
 top: 14px;
 left: 14px;
 z-index: 1;
 display: flex;
 gap: 12px;
 align-items: center;
 color: #fff;
 text-shadow: 0 1px 4px #000;
 }
 </style>
 </head>
 <body>
 <div id="ui">
 <button id="enter-vr" type="button" disabled>Enter VR</button>
 <span id="status">Checking for a headset…</span>
 </div>
 <script type="module" src="/main.ts"></script>
 </body>
</html>
```

:::

## Practical notes

**Feature-detect, always.** `navigator.xr` is absent in most browsers, and `isSessionSupported` is how you find out whether there is a headset behind it. The button should say which of those two is the reason it is disabled.

**Get the scale right.** Captures rarely arrive in metres, and in VR a wrong scale is immediately, physically obvious, a room that feels like a dollhouse or a cathedral. Expect to calibrate against something you know the size of.

**Put it at eye height.** A capture centred on its own origin usually sits at your ankles. This example lifts it; a real app should place the capture relative to `local-floor`.

**WebXR needs HTTPS.** Localhost is exempt, so a `localhost` dev server works, but anything on your network needs a certificate before a headset will talk to it.

## Next

- [Make it fast on a phone](/examples/fast-on-phones): the standalone-headset problem is the mobile problem
- [Huge scenes that load as you walk](/examples/big-scenes): where the XR budget actually bites
