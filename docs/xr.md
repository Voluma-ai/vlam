# XR / VR viewing (WebXR)

VLAM renders correctly inside an immersive WebXR session without any special
application code: `SplatMesh.update(camera, renderer)` detects a presenting session on
the renderer and switches itself over, keep passing your application camera.
The demo viewer shows an "Enter VR" button whenever the browser supports
`immersive-vr` (`?xr=0` disables, `?foveation=0..1` overrides).

Two things the application still owns, both one-liners, request the session with
`xrSessionInit(renderer)`, and cap the budget with `resolveXrSplatBudget()`
while presenting. Both are explained under [Devices](#devices).

Standalone RAD fragment culling is opt-in through `mesh.material.alphaTest`
(default `0`, disabled). The demo sets it to at least `0.5 / 255` only during
XR presentation and restores the previous value on session exit or scene
replacement. Depth writes remain disabled unless `?xrDepth` explicitly enables
them. Ordinary desktop and mobile viewing retains faint overlapping fragments.

## How stereo works here

- **Per-eye projection is three's job.** The splat material builds clip
 positions from three's per-render-view TSL nodes (`cameraProjectionMatrix`,
  `modelViewMatrix`), so the `ArrayCamera` pass projects each eye through its
  own asymmetric frustum automatically.
- **The hand-managed view uniforms go cyclopean.** While presenting, `update()`
  takes viewport size and focal length from the first eye camera and the SH
  view position from the head. Focal comes from the projection matrix, never
  `camera.fov`. XR frustums are asymmetric. Taking it from one eye is *exact*,
 not an approximation: left and right XR projections differ only in their
 center offset, not their focal length.
- **One depth sort per frame, shared by both eyes**, computed from the head
 (midpoint) camera. At a ~63 mm IPD the per-eye order difference is
 imperceptible except centimeters from the face (inside the near plane
 anyway), and a per-eye re-sort would double the frame's dominant cost.
  `renderView` (mirrors/portals) is unrelated to the stereo path, and the demo
  skips its mirror while presenting.
- **The XR camera is freshened before it is read.** three splits its per-frame
  XR work: sub-camera *local* matrices, projections and viewports land in the
  XR manager's animation-frame callback (before your loop body), but every
  *world* matrix, and the two-eye union projection, only inside
  `renderer.render()`. Since `update()` runs before `render()`, VLAM calls
  `xr.updateCamera()` itself; otherwise the sort and SH would trail a frame,
  and order the scene from the world origin on the first presenting frame.
  An application that manages the XR camera itself (`xr.cameraAutoUpdate = false`)
  is left alone.
- **Streamed LOD follows the head**, not the application camera: which does
  not move in session. `StreamedSplatMesh` schedules against the head's union
  projection, so detail resolves where the viewer actually is and looks.

## Devices

Nothing in the renderer is device-specific: the stereo path is driven by what
the session reports, so any WebXR `immersive-vr` device works. Two things do
vary, and both are handled generically.

**The renderer backend must match the session.** three has a genuine WebGPU XR
path (an `XRGPUBinding` projection layer) and **throws** out of `setSession` if
a WebGPU-backed renderer meets a session that did not enable the `webgpu`
feature, it will not silently fall back to WebGL. Use `xrSessionInit(renderer)`
to build the session options; it adds `webgpu` to `requiredFeatures` only when
the backend needs it, so an unsupporting browser rejects `requestSession`
cleanly instead of failing mid-session. (three's own `VRButton` never requests
the feature, which is why pairing it with a `WebGPURenderer` breaks.)

**Budgets follow the session, not the device.** Stereo cost is a property of
presenting, two eye viewports exceeding a 4K desktop, every splat drawn twice -
so apply `resolveXrSplatBudget(pageBudget)` on `sessionstart` and restore on
`sessionend`. This is what makes a tethered desktop, or a headset whose user
agent we do not recognize, size correctly anyway. The `isHeadset` flag on
`detectSplatDeviceProfile()` is only a first-paint hint; it is best-effort and
cannot be relied on (see the Vision Pro row).

| Device | Browser | WebXR | WebGPU in XR | Verified |
| --- | --- | --- | --- | --- |
| Meta Quest 3 | Quest Browser (Chromium) | yes | yes, with the experimental WebGPU setting enabled | **on hardware (WebGL2 and WebGPU XR)** |
| Meta Quest 2/Pro | Quest Browser (Chromium) | yes | check at runtime | no WebGPU XR verification |
| Apple Vision Pro | visionOS Safari | yes | check `XRGPUBinding` at runtime | no |
| Pico | Pico Browser (Chromium) | yes | unlikely, treat as WebGL2 | no |
| HTC Vive / Wolvic | Vive Browser, Wolvic | yes | unlikely, treat as WebGL2 | no |
| Android XR | Chrome | yes | check at runtime | no |
| Desktop + tethered headset | Chrome/Edge | yes | check at runtime | no |

Only the Quest 3 row is verified on hardware; the rest follow from the code paths
above and from vendor documentation, and the runtime handles them without any
per-device branch. **Apple Vision Pro is the case worth calling out:** visionOS
Safari presents as *desktop* Safari, so user-agent detection cannot see it and
it would otherwise take the multi-million desktop splat budget on a mobile-class
GPU driving two high-resolution eyes. The `sessionstart` budget transition is
what saves it, which is the whole argument for keying off presentation.

## Meta Quest 3: what to expect

Quest Browser normally uses WebGL2; an experimental browser setting enabled
WebGPU XR on the tested Quest 3. WebGL2 uses the worker sorter, while WebGPU
uses GPU sorting. At native scale 1.0, the XR framebuffer is about 1680×1760
**per eye**, so stereo fill and alpha blending can be expensive. Sort latency
and streaming updates can also affect motion. The controlled HOTEL results
below show that splat count alone does not predict frame pacing or visual
quality; even the 100k–300k tested cases did not sustain 72 Hz.

`resolveXrSplatBudget()` caps a presenting session at **600k**, and
`resolveSplatBudget` applies the same ceiling to a headset it recognizes by
user agent. This is a scene-wide upper bound, not a promise that 600k splats
are visible or can render at 72 Hz; a low-memory device can scale below it.

## Quest 3 WebGPU XR benchmark findings (September 2026)

With Quest Browser's experimental WebGPU support enabled, we compared VLAM
WebGPU XR with Spark WebGL2 XR on the same HOTEL RAD scene. These are device
measurements, not guaranteed headset budgets. The controlled comparison used
0.5 XR scale, a 3σ splat cutoff, two draw calls, a requested and measured
72 Hz display rate, motion reset at benchmark start, five seconds of warmup,
30 seconds of sampling, and three fresh paired runs per row. VLAM used an
opt-in unified renderer configuration; production defaults were unchanged.

| Active budget | Motion | VLAM / Spark median FPS | VLAM / Spark p99 callback gap (ms) |
| --- | --- | ---: | ---: |
| 100k | Stationary | 54.905 / 64.861 | 21.512 / 22.219 |
| 100k | Rotation | 62.858 / 69.912 | 24.874 / 20.871 |
| 100k | Translation | 57.700 / 65.025 | 20.237 / 22.392 |
| 200k | Stationary | 46.216 / 48.357 | 25.989 / 28.552 |
| 200k | Rotation | 53.610 / 60.538 | 45.847 / 26.860 |
| 200k | Translation | 45.957 / 48.395 | 27.048 / 28.762 |
| 300k | Stationary | 39.226 / 39.782 | 35.081 / 35.652 |
| 300k | Rotation | 42.947 / 47.871 | 48.702 / 35.581 |
| 300k | Translation | 36.842 / 39.046 | 37.797 / 37.052 |

The 100k stationary FPS gap is affected by different sampled GPU clocks.
At 200k rotation, VLAM's long callback gaps were worse in all three pairs.
A later opt-in packed center/color gather optimization improved three paired
VLAM rotation runs over the preceding configuration. In a fresh three-pair
200k rotation comparison of that selected configuration, VLAM reached
**54.754 FPS / 38.986 ms p99**, versus Spark's **60.868 FPS / 27.570 ms p99**.
Neither renderer sustained 72 Hz pacing. This is the current performance
reference, not a demonstration of parity.

Matched splat counts do not establish equal raster work or visual quality.
Native stills showed expected scene coverage, but exact facade/color quality
and continuous sort behavior remain unproven. The recorded `renderGpuMs`
covers only the last eye, so it cannot explain total stereo frame time.
Sparse GPU timestamps and CPU profiles have not isolated the remaining
rotation-tail cause. An idle pose tolerance reduced stationary LOD traversals
but remains opt-in because its FPS result was clock-confounded and quality
under small real head movements has not been established. Detailed captures,
measurement notes, and the benchmark runner output are local under
`.tmp/quest3-webgpu-xr/quest-3-webgpu-xr-2026-09-24/` and are ignored by Git.

## Tuning knobs

The demo enables its conservative stability policy automatically on a
recognized standalone headset: WebGL XR uses framebuffer scale **0.7** and
attempts the asynchronous worker sort at most **30 times per second**. Projection
uniforms and the headset pose still update on every XR frame; only depth-order
work is throttled. `?xrStability=0` restores the generic defaults for an A/B.

Viewer-only XR controls (they do not widen the library API):

| Query | Meaning |
| --- | --- |
| `?xrScale=0.7` | XR projection-layer scale for WebGL and WebGPU, applied before the session starts (`0.25..1`) |
| `?xrSortHz=30` | WebGL worker-sort attempt ceiling; `0` is unrestricted |
| `?xrDepth=0.15` | Experimental depth writes with this alpha-test threshold; `off` disables |
| `?xrDiagnostics=1` | Show an opaque green reference cube and emit `XR_DIAGNOSTIC` JSON every 10 seconds and on exit |

Quest 3 defaults to `xrScale=0.5` on WebGPU XR; use `xrScale=1` for native eye resolution. Quest WebGPU XR also renders display-ready splat colors directly, avoiding a fullscreen output-conversion pass; `?sparkColorOutput=0` restores the previous path for comparison. The local development viewer accepts `?spark=1` to open its matched Spark WebGL XR comparison with the same scene, camera, and scale parameters.

The diagnostic report records the runtime refresh rate, callback and main-thread
p50/p95/p99, missed deadlines, and worker-sort submission/completion age. Compare
the green cube with the splats: both trailing points to frame pacing; only the
splats trailing points to depth/sort behavior. The depth experiment is never
enabled automatically because compositor use and transparent-tail artifacts
must be verified on the target headset first.

- On the **WebGL XR** path, Three consumes
  `renderer.xr.setFramebufferScaleFactor(...)` before the session starts.
  Three r186 omits that scale from its **WebGPU XR** projection-layer call;
  the viewer passes `xrScale` into `XRGPUBinding.createProjectionLayer` before
  the session starts. A live rescale still needs a session restart.
- `renderer.xr.setFoveation(0..1)`: fixed foveated rendering, the runtime
  headroom lever, and nearly free on Quest. **Set it again on `sessionstart`.**
  three re-applies the stored value itself when it builds a *GL* layer, but
  `_initWebGPUSession` does not, so on a WebGPU-backed session a value set
 before the session is silently dropped. Setting it after the session opens
 works on both paths. (The separate per-frame `foveateBoundTexture`
 post-processing step *is* WebGL-only, but that is not this knob.)
- `performanceProfile: 'smooth'` defaults on for mobile-class profiles, headsets
 included. For **streamed** scenes that profile also defaults `shBands` to 0 -
 view-dependent SH is a poor trade at headset budgets, while a fully loaded mesh
 allocates no SH pool unless asked either way.
- Streamed `.rad` scenes: frontier foveation (`foveationMode: 'frontier'`)
 adapts `foveationLimitPx` from the per-eye viewport automatically. Its
 estimator and the shader must size from the *same* viewport or the feedback
 loop diverges and the scene over-coarsens; `update()` resolves the size once
 and hands it to both.

## Known limitations / future work

- **No depth writes by default** (premultiplied alpha compositing), so the
 compositor's positional reprojection has no depth to work with and fast head
 translation can show slight edge swim. The demo's `?xrDepth=<alpha>` A/B writes
 approximate depth after rejecting low-alpha tails; it can improve reprojection
 but may create holes or incorrect transparent occlusion, so it remains opt-in.
- **Sort popping while strafing** on WebGL2 (worker sort lands 1–3 frames
 late). Keep resident counts near the budget, not the cap.
- **Picking needs a mono camera.** `pick()` throws if handed an XR array
 camera: it has no single frustum to unproject the encoded depth through.
 Pass one eye (`renderer.xr.getCamera().cameras[i]`) with `ndc` in that eye's
 viewport.
- **Library XR input is application-owned.** The [VR interaction example](../site/examples/in-vr.md)
  adds controller teleport and snap turns with three.js. Hand tracking and
  Vision Pro's pinch/gaze `transient-pointer` model are outside that example.
- **No `immersive-ar` passthrough.** Splats compositing over passthrough video
  needs alpha-blend environment handling and a transparent clear path; not
  attempted.
- **The main demo remains view-only.** It parents the camera to an XR rig on
  `sessionstart` so the headset starts at the desktop view. The separate
  [VR interaction example](../site/examples/in-vr.md) demonstrates controller
  teleport and snap turns.
- **Multiview (`OVR_multiview2`)** has an opt-in path in three.js r186's
  WebGL XR manager when the device supports it; its WebGPU XR path still
  disables multiview. VLAM has not validated splat rendering, sorting, or
  picking on that path, so multiview support is not claimed.
- Testing without hardware: Meta's Immersive Web Emulator exercises the session
 lifecycle and the ArrayCamera path. `src/lib/__tests__/xr-view.test.ts`,
  `splat-mesh.xr.test.ts`, `streamed-splat-mesh.xr.test.ts` and
  `unified-splat-mesh.xr.test.ts` pin the contracts above.
