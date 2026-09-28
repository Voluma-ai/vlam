# View it in VR

**What you get:** a room-scale Goose scene with teleport and 30° snap turns.

<ExampleEmbed slug="in-vr" hint="Needs a WebXR headset; the button reports browser support" />

The existing sample defaults to WebGL2 for a predictable headset path. Add
`?backend=webgpu` to request WebGPU explicitly. The WebGPU path needs a
browser and headset that support the WebXR `webgpu` feature.

The floor is visible around a pedestal. Only its four floor meshes are valid
teleport destinations. Hold either controller trigger to show the destination
marker, then release to teleport. Push the right thumbstick left or right for
one 30° turn; release it to the centre before another turn. The camera stays
on the XR rig, so walking in the tracked space preserves the headset's height.

The example requests `local-floor` and reports unsupported or denied sessions.
It restores the desktop camera and orbit controls on exit and accepts a new
session. VLAM receives the application camera in both `splats.update(camera,
renderer)` and `renderer.render(scene, camera)`; three manages the stereo
camera internally.

## Rendering budget

The bundled Goose scene is fully loaded, so its splat count is fixed for the
whole session. A budget number on this static mesh would have no effect. For a
streamed scene, change its budget when the session starts and restore it on exit:

<<< ../../docs/examples/samples/xr-streamed-budget.ts

The WebGL2 example applies `recommendedXrFramebufferScale()` before entering
XR. `xrSessionInit(renderer, …)` adds the WebGPU session feature when the
explicit WebGPU option is used. Headset comfort and stereo correctness still
need a real device check.

## The code

::: code-group

<<< ../../docs/examples/samples/in-vr.ts [main.ts]

```html [index.html]
<!doctype html>
<html>
 <head>
 <meta charset="utf-8" />
 <style>
 body { margin: 0; overflow: hidden; font: 14px system-ui; }
 #ui {
 position: fixed; top: 14px; left: 14px; z-index: 1;
 display: flex; gap: 12px; align-items: center;
 color: #fff; text-shadow: 0 1px 4px #000;
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

WebXR requires HTTPS except on localhost. The bundled Goose is about one
world unit tall; real captures need scale calibration before room-scale use.

## Next

- [Make it fast on a phone](/examples/fast-on-phones)
- [Huge scenes that load as you walk](/examples/big-scenes)
