# Works everywhere: the WebGL2 fallback

**What you get:** a viewer that runs on WebGPU or WebGL2 and can force the
fallback for testing.

<ExampleEmbed slug="webgl-fallback" hint="Says which backend it got, the link forces the fallback" />

## You already have a fallback

`createSplatRenderer()` probes for WebGPU and, if it is missing, quietly builds three.js's WebGL2 renderer instead. Your capture renders either way, and most apps need no code for this at all.

Test the fallback path: older browsers, locked-down machines, and some mobile
configurations use it, and WebGPU-only effects will not run there.

```ts
const renderer = await createSplatRenderer(); // WebGPU if possible, WebGL2 otherwise
const isWebGPU = renderer.backend.isWebGPUBackend === true;
```

Pass `requireWebGpu: true` if you would rather fail loudly than degrade, reasonable when your app genuinely depends on a WebGPU-only feature, and better than shipping something subtly broken.

## What actually differs

| | WebGPU | WebGL2 |
| --- | --- | --- |
| Static and streamed captures | ✓ | ✓ |
| Picking, spatial queries | ✓ | ✓ |
| Depth of field | ✓ | ✓ |
| `sdfEffects`, `lightingPreset`, plain-TSL modifiers | ✓ | ✓ |
| `revealPreset` and other `wgslFn` shaders | ✓ | **inert** |
| `SplatScene` (many captures, one sort) | ✓ | **unavailable** |
| `UnifiedSplatRenderer` | ✓ | **unavailable** |

**"Inert" is the dangerous word.** A `wgslFn`-based modifier on WebGL2 does not throw and does not warn, it simply does nothing. If your load sequence hides the capture behind a reveal that never plays, the capture never appears, and the bug report you get says "black screen on my work laptop".

Branch on the backend and use an alternative path:

```ts
const reveal = isWebGPU ? revealPreset() : null;
splats.modifiers = reveal ? [reveal.modifier, ...rest] : rest;
```

## Test it without hunting for hardware

The trick that makes this practical: `forceWebGL: true` builds the WebGL2 backend on a machine that has WebGPU, so the fallback path is one reload away.

```ts
const useWebGL = new URLSearchParams(location.search).get('backend') === 'webgl';
const renderer = await createSplatRenderer(useWebGL ? { forceWebGL: true } : {});
```

(`forceWebGL` and `requireWebGpu` are mutually exclusive, asking for both throws, since there is no sensible answer.)

Wire this to a development query parameter to test the fallback easily. The
[full viewer](/demo/) uses the same `?backend=webgl` switch.

## The code

::: code-group

<<< ../../docs/examples/samples/webgl-fallback.ts [main.ts]

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
 #banner {
 position: fixed;
 top: 14px;
 left: 14px;
 z-index: 1;
 color: #fff;
 text-shadow: 0 1px 4px #000;
 }
 </style>
 </head>
 <body>
 <p id="banner">Detecting backend…</p>
 <script type="module" src="/main.ts"></script>
 </body>
</html>
```

:::

## Performance is different, not simply worse

Captures render properly on the fallback, but sorting and projection work
differently. A scene that performs well on WebGPU may be demanding on WebGL2.

Treat it as its own performance target: measure there, and consider a smaller budget on that path. Everything in [Make it fast on a phone](/examples/fast-on-phones) applies, and applies harder.

## Should you tell the user?

The banner here exists to demonstrate the detection. In a real product, mostly **no**, a message about graphics APIs is noise to someone who just wants to look at a capture, and there is usually nothing they can do about it.

Say something only when it changes what they can do: a disabled feature that they might otherwise go looking for, or a "this will look better in a newer browser" note where that is genuinely true. Log the backend for yourself either way; when a support ticket arrives, it is the first thing worth knowing.

## Next

- [Make it fast on a phone](/examples/fast-on-phones): the other axis of "works on their machine, not just yours"
- [Several captures in one scene](/examples/many-captures): the main feature that has no fallback path
