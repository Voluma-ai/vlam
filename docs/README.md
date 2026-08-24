# Documentation

Start with the [user guides](guide/README.md). The public docs and demo live at
[https://vlam.voluma.ai](https://vlam.voluma.ai). The generated API reference is
available under `/api/` there and locally with `npm run dev`; it is generated
from public JSDoc and is deliberately not checked in.

| Document | Purpose |
| --- | --- |
| [Getting started](guide/getting-started.md) | Install, render, resize, and dispose |
| [Loading scenes](guide/loading-scenes.md) | Formats, URLs, local files, and errors |
| [Streaming and LOD](guide/streaming-and-lod.md) | Large-scene loading and budgets |
| [Effects](guide/effects-and-modifiers.md) | Built-in and custom TSL effects |
| [Proxy-mesh relighting](guide/relighting.md) | Screen-space lit-proxy modulate |
| [Picking and queries](guide/picking-and-queries.md) | GPU picking and spatial queries |
| [Unified rendering](guide/unified-rendering.md) | Correct ordering across splat meshes |
| [Troubleshooting](guide/troubleshooting.md) | Common integration failures |
| [Capabilities](capabilities.md) | Supported formats and platforms |
| [XR](xr.md) | WebXR integration |
| [Architecture](architecture.md) | Contributor constraints and source map |
| [Roadmap](../ROADMAP.md) | Open work only |

The files under `formats/` document byte layouts and interoperability details
that are not evident from the parsers. Keep them synchronized with format code.
Historical implementation diaries, superseded designs, and generated TypeDoc
pages are intentionally omitted: Git history and source are authoritative.
