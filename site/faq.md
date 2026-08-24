# FAQ

<details class="faq">
<summary>What splat formats are supported?</summary>

Files: `.sog`, `.ply`, `.spz`, `.rad`, `.splat`, `.ksplat`.

Folders: streamed **SOG**, **LCC** / **LCC2**, **RADC**.

</details>

<details class="faq">
<summary>Why won't my externally hosted splat file load?</summary>

The server hosting the file has to allow cross-origin requests
(`Access-Control-Allow-Origin`), and for streamed formats also allow the
`Range` header and expose `Content-Range`. Your browser blocks the read
otherwise, nothing the viewer can work around.

Download the file and <a href="/demo/" target="_self">drop it into the demo</a> instead.

</details>

<details class="faq">
<summary>How do I use VLAM! in my project?</summary>

See [Get started](/get-started) for install and a minimal three.js example.

</details>

<details class="faq">
<summary>Is VLAM! ready for production?</summary>

Not yet. VLAM! is a **pre-release**: the API can still change in breaking ways
before v1.0, so an upgrade may require edits to your code.

Use it for prototypes, demos and experiments today. If you do ship it, pin an
exact version and read the release notes before you upgrade.

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
