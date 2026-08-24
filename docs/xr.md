# XR / VR viewing (WebXR)

VLAM renders correctly inside an immersive WebXR session without any special
host code: `SplatMesh.update(camera, renderer)` detects a presenting session on
the renderer and switches itself over, keep passing your application camera.
The demo viewer shows an "Enter VR" button whenever the browser supports
`immersive-vr` (`?xr=0` disables, `?foveation=0..1` overrides).

Two things the host still owns, both one-liners, request the session with
`xrSessionInit(renderer)`, and cap the budget with `resolveXrSplatBudget()`
while presenting. Both are explained under [Devices](#devices).

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
  A host that manages the XR camera itself (`xr.cameraAutoUpdate = false`)
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
| Meta Quest 2/3/Pro | Quest Browser (Chromium) | yes | no. WebGPU is behind a flag, so the backend is WebGL2 | **on hardware** |
| Apple Vision Pro | visionOS Safari | yes | check `XRGPUBinding` at runtime | no |
| Pico | Pico Browser (Chromium) | yes | unlikely, treat as WebGL2 | no |
| HTC Vive / Wolvic | Vive Browser, Wolvic | yes | unlikely, treat as WebGL2 | no |
| Android XR | Chrome | yes | check at runtime | no |
| Desktop + tethered headset | Chrome/Edge | yes | check at runtime | no |

Only the Quest row is verified on hardware; the rest follow from the code paths
above and from vendor documentation, and the runtime handles them without any
per-device branch. **Apple Vision Pro is the case worth calling out:** visionOS
Safari presents as *desktop* Safari, so user-agent detection cannot see it and
it would otherwise take the multi-million desktop splat budget on a mobile-class
GPU driving two high-resolution eyes. The `sessionstart` budget transition is
what saves it, which is the whole argument for keying off presentation.

## Meta Quest 3: what to expect

Quest Browser ships WebGL2 (WebGPU is behind a flag), so the CPU worker sorter
applies. The default WebXR framebuffer is ~1680×1760 **per eye** at scale 1.0 -
about 5.9 Mpix of stereo fill on a phone-class GPU (Adreno 740) that shares the
SoC with the compositor. The limits, in order of pain:

1. **Fill rate / overdraw.** Splats are alpha-blended quads stacked hundreds
   deep in busy views, and stereo doubles it. This, not raw splat count, is
   the ceiling.
2. **CPU sort latency.** Million-splat sorts at head-tracking rates lag by a
   few frames; asynchronous timewarp hides rotation latency but not
   translation, so a stale order reads as popping when you strafe.
3. **Memory** is *not* the binding constraint: 1–2M splats fit comfortably,
   especially with `poolFloatTextures: 'float16'`.

Realistic splat counts at 72 Hz:

| Scenario | Rendered splats |
| --- | --- |
| Comfortable, moderate overdraw | 300k–800k |
| With streamed LOD / `.rad` foveation, `maxStdDev` ≈ 2–2.5, framebuffer scale 0.8, fixed foveation | ~1–1.5M resident |
| Above ~1.5M | dropped frames on dense scenes |

`resolveXrSplatBudget()` caps a presenting session at **1M**, and
`resolveSplatBudget` applies the same ceiling to a headset it recognizes by
user agent. Both are ceilings, not defaults, a low-memory device still scales
below them.

## Tuning knobs

- On three 0.185.x's **WebGL XR** path,
  `recommendedXrFramebufferScale()` →
  `renderer.xr.setFramebufferScaleFactor(...)`, **before the session starts**:
  three warns and ignores the call once presenting, and a live rescale needs a
  session restart. 0.8 on a headset cuts fragment work ~36% for a barely
  visible softening. three's WebGPU XR path creates its `XRGPUBinding`
  projection layer at native scale and does not consume this setting; use the
  presenting splat budget plus fixed foveation there.
- `renderer.xr.setFoveation(0..1)`: fixed foveated rendering, the runtime
  headroom lever, and nearly free on Quest. **Set it again on `sessionstart`.**
  three re-applies the stored value itself when it builds a *GL* layer, but
  `_initWebGPUSession` does not, so on a WebGPU-backed session a value set
 before the session is silently dropped. Setting it after the session opens
 works on both paths. (The separate per-frame `foveateBoundTexture`
 post-processing step *is* WebGL-only, but that is not this knob.)
- `performanceProfile: 'smooth'` defaults on for mobile-class profiles, headsets
 included. For **streamed** scenes that profile also defaults `shBands` to 0 -
 view-dependent SH is a poor trade at headset budgets, while a static mesh
 allocates no SH pool unless asked either way.
- Streamed `.rad` scenes: frontier foveation (`foveationMode: 'frontier'`)
 adapts `foveationLimitPx` from the per-eye viewport automatically. Its
 estimator and the shader must size from the *same* viewport or the feedback
 loop diverges and the scene over-coarsens; `update()` resolves the size once
 and hands it to both.

## Known limitations / future work

- **No depth writes** (premultiplied alpha compositing), so the compositor's
 positional reprojection has no depth to work with, fast head translation can
 show slight edge swim. Accepted for now; an approximate depth write past an
 alpha threshold is a possible future option.
- **Sort popping while strafing** on WebGL2 (worker sort lands 1–3 frames
 late). Keep resident counts near the budget, not the cap.
- **Picking needs a mono camera.** `pick()` throws if handed an XR array
 camera: it has no single frustum to unproject the encoded depth through.
 Pass one eye (`renderer.xr.getCamera().cameras[i]`) with `ndc` in that eye's
 viewport.
- **No XR input.** Controllers, hand tracking and Vision Pro's pinch/gaze
  `transient-pointer` model are not wired up; the scope here is viewing. See
  locomotion below for what that means in the demo.
- **No `immersive-ar` passthrough.** Splats compositing over passthrough video
  needs alpha-blend environment handling and a transparent clear path; not
  attempted.
- **No locomotion in the demo.** It parents the camera to an XR rig on
  `sessionstart` so you enter VR where the 2D view was standing (three derives
 the head pose from the camera's *parent*, so without a rig you would land at
 the reference-space origin, usually inside the capture), but desktop
 controls idle during the session. Teleport and snap turn are future work.
- **Multiview (`OVR_multiview2`)** is not supported by three's WebGPURenderer
 WebGL2 backend; stereo renders in two passes. Multiview would halve
 vertex/draw cost (not fill), so it is a future item, not a blocker.
- Testing without hardware: Meta's Immersive Web Emulator exercises the session
 lifecycle and the ArrayCamera path. `src/lib/__tests__/xr-view.test.ts`,
  `splat-mesh.xr.test.ts`, `streamed-splat-mesh.xr.test.ts` and
  `unified-splat-renderer.xr.test.ts` pin the contracts above.
