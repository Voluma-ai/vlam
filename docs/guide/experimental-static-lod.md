# Static LOD generation

`@voluma/vlam/static-lod` builds a merged LOD hierarchy for a fully decoded
capture. `StaticLodSplatMesh`, its options, and its progress types follow the
semantic-versioning guarantee; the worker-side build functions are internal.

`StaticLodSplatMesh.load()` decodes the entire capture before it can build a
merged hierarchy. Construction also needs temporary hierarchy structures and
array copies. It is therefore not bounded-memory streaming and is unsuitable
for the normal large-scene path.

When it reduces a capture, the builder uses deterministic Morton-local
similarity pairing. It ranks compatible pairs by Gaussian distribution, RGB,
and opacity rather than blindly merging adjacent spatial entries, then packs
each selected pair into the contiguous child ranges required for traversal.
This better preserves separate thin surfaces, but it does not retain source
detail that was merged away.

For production large scenes, prefer prebuilt streamed captures with
`StreamedSplatMesh` (SOG, LCC/LCC2, or RAD). Static LOD is retained unchanged
for evaluation and small fully decoded captures; it is not an offline
conversion tool.
