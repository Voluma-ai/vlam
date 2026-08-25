# Make it fast on a phone

**What you get:** a viewer that caps pixel ratio and adapts it to frame time.

<ExampleEmbed slug="fast-on-phones" hint="Watch the pixel ratio move as the frame time changes" />

## Mobile rendering is usually fill-bound

On mobile, splat rendering is usually **fill-bound**, not memory-bound: the GPU
struggles to shade covered pixels rather than store splats. Reducing splat count
often helps less than reducing render resolution.

## Pixel ratio is the biggest single number

A phone screen reports `devicePixelRatio` 3. Render at that and you are shading **nine times** the fragments of ratio 1, for a display so small and so close that most of it is invisible to the eye.

`recommendedMaxPixelRatio` gives the ceiling worth using: 1.5 on mobile and
integrated / laptop-class desktops, 2 on discrete desktop GPUs. Cap to it before
anything else:

```ts
renderer.setPixelRatio(Math.min(devicePixelRatio, recommendedMaxPixelRatio()));
```

For many apps, this is the most effective performance setting.

## Then let it adjust itself

A fixed ceiling is a guess about the worst case. `suggestAdaptivePixelRatio` turns it into a measurement: hand it the frame time each frame and it tells you whether to spend or save.

It smooths the input and separates the "speed up" and "slow down" thresholds, so a single slow frame does not make the image flicker between resolutions. Thread `emaMs` and `warmupRemaining` from the previous result each frame. Warmup plus a hitch filter keep one-time WebGPU pipeline compiles from pinning the ratio at 1.

The viewer stays sharp when it has headroom and lowers resolution when needed.

## Laptops are not workstations

A MacBook or Windows iGPU reports as *desktop* in the user agent, so without a
GPU class it would inherit the multi-million splat workstation budget. Probe the
adapter once and pass the profile into load options:

```ts
const gpuClass = await probeSplatGpuClass();
const deviceProfile = { ...detectSplatDeviceProfile(), ...(gpuClass ? { gpuClass } : {}) };
const mesh = await StreamedSplatMesh.load(url, { deviceProfile });
```

`integrated` (Apple Silicon, typical Intel/AMD iGPUs) gets ~1M for LCC-class
formats and ~2M for streamed SOG, plus the same smooth profile / 1.5 DPR ceiling
as phones. `discrete` keeps the workstation path. `fallback` (software adapter)
is tighter still. When the probe fails, the library leaves `gpuClass` unset and
keeps the legacy desktop defaults.

## What the library already decides for you

Three settings are device-derived unless you override them:

**The splat budget**, `resolveSplatBudget()`. How many splats may be active. A hardcoded number that suits your workstation is the classic way to make a phone worse.

**The performance profile**, `resolveSplatPerformanceProfile()` picks `'smooth'` on mobile and fill-constrained desktops, `'quality'` on discrete desktop, which controls how aggressively faint splats are culled.

**Coverage and rendering defaults**, device-derived, and generally not worth touching until you have measured a specific problem. The public demo's performance mode (on by default on phones and on integrated / fallback desktops) is the exception: it uses a 3σ Gaussian cutoff and no renderer MSAA, because 4σ plus MSAA was what made a 600k scene on an iPhone 15 Pro miss vsync during a hard orbit. A MacBook Air M3 keeps that same SD default: goose looks fine without MSAA, and streamed million-splat scenes already miss 60 Hz before HD. `?maxStdDev=` and `?rendererAntialias=` pin those for A/B.

::: warning A cap is not a pin
If you want "the usual settings, but no more than N", use `budgetCap`, not `budget`. `budget` is absolute and overrides the device tier entirely, which has shipped as a bug more than once, in the form of a "performance mode" that raised the load on the weakest device it was meant to help.
:::

## The code

::: code-group

<<< ../../docs/examples/samples/fast-on-phones.ts [main.ts]

```html [index.html]
<!doctype html>
<html>
 <head>
 <meta charset="utf-8" />
 <meta name="viewport" content="width=device-width, initial-scale=1" />
 <style>
 body {
 margin: 0;
 overflow: hidden;
 font: 13px system-ui;
 }
 #hud {
 position: fixed;
 top: 12px;
 left: 12px;
 z-index: 1;
 color: #fff;
 text-shadow: 0 1px 4px #000;
 }
 </style>
 </head>
 <body>
 <p id="hud"></p>
 <script type="module" src="/main.ts"></script>
 </body>
</html>
```

:::

## Testing it honestly

- **A desktop window shrunk to phone size proves nothing.** Same GPU, same fill rate. Use a real device.
- **iOS reports no `deviceMemory`.** Any `?? fallback` you write is the iPhone path, whether you meant it or not: so make that fallback the conservative one.
- **Check it warm, not cold.** Phones throttle. A capture that runs at 60 fps for twenty seconds and 30 fps after two minutes is the normal shape of the problem, and it is exactly what the adaptive ratio exists to absorb.

## Next

- [Huge scenes that load as you walk](/examples/big-scenes): the budget in its natural habitat
- [View it in VR](/examples/in-vr): the same reasoning, with a much harder frame deadline
