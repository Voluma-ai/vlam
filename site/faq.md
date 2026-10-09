# FAQ

<details class="faq">
<summary>What splat formats are supported?</summary>

Files: `.sog`, `.ply`, `.spz`, `.rad`, `.splat`, `.ksplat`.

Folders: streamed **SOG**, **LCC** / **LCC2**, **RAD**.

</details>

<details class="faq">
<summary>Why won't my externally hosted splat file load?</summary>

The server hosting the file has to allow cross-origin requests
(`Access-Control-Allow-Origin`), and for streamed formats also allow the
`Range` header. A streamed endpoint must answer byte requests with `206 Partial
Content`; exposing `Content-Range` also lets VLAM validate the returned offset.
Without that exposure, VLAM accepts a response of exactly the requested length.

Download the file and <a href="/demo/" target="_self">drop it into the demo</a> instead.

</details>

<details class="faq">
<summary>How do I use VLAM! in my project?</summary>

See [Get started](/get-started) for install and a minimal three.js example.

</details>

<details class="faq">
<summary>Is VLAM! ready for production?</summary>

Yes. From v1.0.0 the public API follows semantic versioning: breaking changes
only land in a major version and come with a [migration guide](/migration).
Anything marked `@experimental` in the API reference (the `static-lod`,
`sorting/radix` and `projection/compute` entries, `MergedSplatMesh` and the
flagged mesh options) and the diagnostic surfaces (streaming performance
events, console traces, fallback reason strings) are outside that guarantee
and may change in a minor release.

Check the [capability matrix](https://github.com/Voluma-ai/vlam/blob/main/docs/capabilities.md)
for the devices and browsers that have been validated, and read the release
notes before a major upgrade.

</details>

<details class="faq">
<summary>What happens when a device does not support WebGPU?</summary>

VLAM! uses **WebGPU** when available and falls back to **WebGL2** otherwise.
Loading and viewing scenes work on both.

WebGPU is faster in most areas, especially sorting, and a few extras like some visual effects and the smoothest
playback of large streamed scenes, require it.

</details>

<details class="faq">
<summary>Whoa, this tech-talk is melting my brain, please explain it like I'm Bill and Ted!</summary>

**Volumetric:**
"Listen up, this is heavy math bro! But like, totally righteous math that makes
endless worlds appear outta nowhere!"

**Luminescent:**
"Dude, it renders so fast it practically travels back in time to 1988!"

**Astral:**
"Because these radical little 3D splat-clouds shine brighter than Eddie Van Halen's
guitar solos!"

**Matrix-Viewer:**
"The ultimate, most cosmic portal for exploring infinite, totally bogus-free
cyber-realms!"

</details>
