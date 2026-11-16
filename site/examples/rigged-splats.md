# Rig and animate splats

**What you get:** a static splat (VLAM's pixel-art goose) bound to a
`THREE.Skeleton` and animated by bone clips under an `AnimationMixer`, the
way a glTF character is: two looping clips you cross-fade between, and an
additive one-shot (a honk) fired on top.

<ExampleEmbed slug="rigged-splats" hint="Look around · Walk (a cross-fade) · Honk on top of either" />

::: warning Experimental
`@voluma/vlam/dynamic` may change in a minor release.
:::

The same recipe animates any splat: a scanned person, a bird, a fish, a
vehicle. Only the skeleton and the weights change.

## 1. Weights: which bones move each splat

A `SkinnedSplatMesh` takes a skin next to the splat data: up to four bone
indices and weights per splat (`bonesPerSplat: 1 | 2 | 4`). Here they come
from where each splat sits on the sprite, with two bones per splat blended up
the neck so it bends instead of tearing. With a rigged glTF, take them from
its mesh instead:

```ts
const proxy = gltf.scene.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
const skin = computeSplatSkinWeights(splats, proxy, { bonesPerSplat: 2 });
```

`computeSplatSkinWeights` gives each splat the weights of the proxy vertex
nearest it. Pass `splatToProxy` (a `Matrix4`) when the scan and the proxy
were not made in the same frame.

## 2. Bind a skeleton

The skeleton is a plain `THREE.Skeleton` of `THREE.Bone`s, built in the
splat's own axes (a `SkinnedSplatMesh` applies no upright correction). Bind it
as you would a `THREE.SkinnedMesh`: without a bind matrix, the current pose
becomes the bind pose.

```ts
const mesh = new SkinnedSplatMesh(data, { skin });
mesh.add(rootBone);
mesh.bind(new THREE.Skeleton(bones));
```

## 3. Animate the bones

Anything that moves the bones moves the splats. Clips are ordinary
`AnimationClip`s of bone tracks, as a glTF carries them, so the mixer's
features all apply: `crossFadeTo` blends the look and walk loops bone by
bone, and the honk is made additive with `AnimationUtils.makeClipAdditive`,
so it lifts the head on top of whichever loop plays. Call
`mesh.update(camera, renderer)` each frame after `mixer.update`: it refreshes
the bone texture from the skeleton.

## How it draws

The splats stay on the GPU as captured. Each frame the mesh writes one 3×4
matrix per bone into a small float texture; a modifier blends a splat's bone
matrices and moves its center and shape. A position-only copy of that
modifier makes the WebGPU sort see the posed splats, and the mesh grows its
sort bounds whenever the pose (or root motion) leaves them.

Two limits: view-dependent SH is evaluated in the bind pose, and the WebGL2
worker sorter sorts the bind pose. The
[dynamic splats guide](https://github.com/Voluma-ai/vlam/blob/main/docs/guide/dynamic-splats.md)
has the details. The <a href="/demo/?scene=procedural:goose" target="_self">full
viewer</a> shows a goose generated in code and rigged the same way, with 78
bones and its own lighting modifier stacked after the skin.

## The whole program

<<< ../../docs/examples/samples/rigged-splats.ts
