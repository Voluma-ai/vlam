# Rendering benchmark

Run `npm run dev`, then open `/render-benchmark.html` on the printed server URL.
Use the same benchmark files in both checkouts when comparing a baseline with
the optimized library. The baseline needs the benchmark harness backported;
an older checkout without this page cannot run these comparisons.

Start each checkout separately with the same command and browser. These URLs
pin the same 800×600 drawing buffer, no MSAA, source SH and 3σ extent:

```text
/render-benchmark.html?scene=/goose.sog&mode=stationary&width=800&height=600&pixelRatio=1&msaa=0&profile=quality&maxStdDev=3&warmup=5&seconds=15&gpuTimestamps=1&label=baseline
/render-benchmark.html?scene=/goose.sog&mode=stationary&width=800&height=600&pixelRatio=1&msaa=0&profile=quality&maxStdDev=3&warmup=5&seconds=15&gpuTimestamps=1&label=optimized
```

Replace `/goose.sog` with the same whole-file scene in both runs. Streamed RAD
must be tested in the main viewer; this harness loads an ordinary `SplatMesh`.
Keep the label descriptive (include the commit if useful). JSON records the
package version, Three revision, actual backend, drawing buffer and resolved SH.

## Modes and measurements

- `mode=stationary` is the default: the camera settles before measurement, so
  frame times do not include continuous re-sorting.
- `mode=orbit` runs the same camera path from elapsed benchmark time. Use it
  for motion and end-to-end frame pacing, not isolated draw performance.
- `backend=webgl` forces the fallback; omission requests WebGPU. Read the
  actual backend in the result. `msaa=0` disables MSAA; omission enables it.
- Switching away invalidates all measurements and restarts the entire warm-up
  on return. Keep the window visible and avoid resizing or interacting.
- GPU queries drain every 30 frames, including warm-up, with one readback batch
  in flight. GPU statistics describe sampled frames, not every rendered frame.
  Samples from warm-up or an interrupted run are excluded. No fresh compute
  queries during a stationary sample means compute timing is unavailable, not
  zero. Unsupported timestamps are also explicitly unavailable.
- Total draw calls include Three's output pass. `splatDrawCallsMedian` counts
  only actual submissions for the splat mesh; one splat draw can therefore
  coexist with two total draws.
- Average FPS is interval count divided by total elapsed interval time. Read
  p95/p99 alongside it; neither callback cadence nor GPU submission proves
  physical display presentation. Vsync-capped FPS can hide a real GPU saving.

Download JSON and the final PNG after each run. The PNG is captured inside the
last render callback and retained independently of the disposed renderer.

## Device validation

For a small, redistributable pixel regression check, open
`/unified-harness.html?effects-check=1` (WebGPU) or append `&backend=webgl`.
The check compares an SH1 fixture with mirrored placement, antialiasing off/on,
relighting off/on, softness changes, and depth-of-field/focus transitions.
It requires disabling effects to restore the original pixels exactly and
checks standalone/unified parity on WebGPU. Retained thumbnails allow inspection.

Verified on Windows Chromium with Three revision 185: both effect checks passed;
standalone/unified WebGPU pixels matched exactly. Normal 5-second warm-up plus
15-second stationary and orbit WebGPU runs completed without timestamp-pool
warnings. The orbit run collected 31 render and 31 compute samples. These are
correctness checks, not a baseline-versus-optimized performance claim. Synthetic
fixtures do not replace visual checks on dense captures or physical Mac testing.
The normal-length WebGL2 run also completed without warnings. Both backends
retained a decoded 800×600 PNG after disposal. Both download buttons completed
(WebGPU needed one retry). The automated browser did not expose saved download
files, so opening the downloaded PNGs from disk still needs a manual check.

On the M3 MacBook Air, run three warmed comparisons per mode on the same
browser, resolution and power configuration. Test Chrome and Safari where
supported, then run `seconds=600` on sparse and dense scenes to check thermal
behavior. Record macOS version, GPU configuration and commit labels with the
exported files. M3 Air results do not establish Pro / Max performance; Apple
Silicon still classifies as a single `integrated` tier today (see
[capabilities § Apple Silicon GPU tiers](capabilities.md#apple-silicon-gpu-tiers-design-not-shipped)).

Compare standalone and unified output with an SH-bearing capture, relighting
off/on (including softness), and depth of field off/on. Orbit around overlap
and silhouette edges; verify switching effects back off restores the image.
Finally repeat Veersetoren in the host viewer with its corrected FPS counter
and record a performance trace if motion still appears uneven. Do not change
quality defaults based on average FPS alone.
