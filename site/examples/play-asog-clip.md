# Play an Animated SOG clip

**What you get:** a 4D Gaussian splat clip in the
[Animated SOG](https://github.com/arrival-space/animated-sog) (`.asog`) format,
played from one file, with its soundtrack kept in step through three.js audio.

<ExampleEmbed slug="play-asog-clip" hint="Add ?src=<url> for your own clip; a clip with sound gets a Play sound button" />

::: warning Experimental
`@voluma/vlam/dynamic` may change in a minor release.
:::

The default clip is synthetic: a ball of splats, a quarter of them still and
the rest each living a fraction of a second while it swings about a point near
the centre (1 MB, written by `scripts/generate-asog-sample.mjs`). It shows the
playback, not what the format can look like, and it has no sound. Add
`?src=<url>` to the live page to play a real capture; the server has to allow
cross-origin reads. The **Play sound** button appears only for a clip that
carries a soundtrack.

## One file

An `.asog` file holds the whole clip: every splat with its SOG v2 attributes,
a rigid-body motion over its short life, and optionally a soundtrack.
`loadAsogClip` fetches it and decodes it in a worker; `loadSplatClip` does the
same from the `.asog` extension, but only `loadAsogClip` hands back the sound.
The mesh plays like a glTF animation, as in the
[Faltwerk example](/examples/play-4dgs-clip): its `animation` is one track on
`mesh.time`, so an `AnimationMixer` drives it.

```ts
const clip = await loadAsogClip(url);
const mesh = new SplatClipMesh(clip, { renderer });
mesh.rotation.x = Math.PI; // .asog is y down
```

Animated SOG clips are in TRiGS/COLMAP orientation, **y down**, and a
`SplatClipMesh` does not reorient a clip, so turn it 180° about X, the same
correction VLAM applies to SOG and PLY captures.

## The soundtrack

VLAM decodes the file but does not play its sound: `clip.audio` is the sound
file's MIME type and bytes, or `null`. Decode it with the Web Audio context of
a `THREE.AudioListener` and give it to a `THREE.Audio`. The sound has to stay
at `mesh.time`: the example restarts it there whenever the two drift more than
60 ms apart, which covers each loop of the clip, a pause and a hitched frame.
Browsers only start audio after a user gesture, hence the button.

## Which path it plays on

On WebGPU a `SplatModifier` evaluates every splat's motion on the GPU from a
texture uploaded once, so a frame costs no CPU work and no upload. On WebGL2
the clip's two workers evaluate whole frames, skipping every splat outside
its short life, and the mesh writes them into its pool (about 27 ms per frame
for 400,000 splats on a desktop CPU).
`mesh.playback` says which one the constructor picked.

## The code

<<< ../../docs/examples/samples/play-asog-clip.ts
