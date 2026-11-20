# Animate a rigged splat

**What you get:** a rigged splat character, Santa Claus, loaded from a glTF
with its skeleton and six bone clips, and played under an `AnimationMixer` the
way any glTF character is: three loops you cross-fade between (idle, walk,
run), a jump and a laugh played once in their place, and a wave added on top
of whichever loop plays.

<ExampleEmbed slug="rigged-splats" hint="Idle · Walk · Run (cross-fades) · Jump or Laugh once · Wave on top of any of them" />

::: warning Experimental
`@voluma/vlam/dynamic` may change in a minor release.
:::

## 1. Load the rigged splat

`loadSplatGltf` reads Gaussian splats from a glTF under the
`KHR_gaussian_splatting` extension. A splat primitive with `JOINTS_0` and
`WEIGHTS_0` on a skinned node becomes a `SkinnedSplatMesh` bound to the file's
skeleton, in place in the glTF's scene. This file stores its splats under
`EXT_meshopt_compression` (20 MB for 1,433,223 splats), so the loader is given
a meshopt decoder:

```ts
const model = await loadSplatGltf('https://storage.voluma.ai/shared/avatars/santa.glb', {
  loader: new GLTFLoader().setMeshoptDecoder(MeshoptDecoder),
});
scene.add(model.scene);
```

The splats keep the file's axes (glTF is y up), so nothing needs turning.

## 2. Play its clips

`model.animations` are the file's clips, ordinary `AnimationClip`s of bone
tracks for a mixer rooted at `model.scene`, so the mixer's features all apply:

- **Loops.** `idle`, `walk` and `run` are three actions; `crossFadeTo` blends
  from one to the next bone by bone.
- **One-shots in their place.** `jump` and `laugh` move the whole body, so
  each is cross-faded in like a loop, set to `LoopOnce` and clamped: it holds
  its last frame until the mixer's `finished` event fades the loop back in.
- **A one-shot on top.** `wave` keys only the right arm, the spine, the neck
  and the head. The loops key those bones too, and a mixer averages actions
  that share a bone, so the sample makes the wave additive with
  `AnimationUtils.makeClipAdditive`: Santa waves while the legs keep
  walking.

A clip may also say how it is meant to be played, in `clip.userData.vlam`
(`loop: 'repeat' | 'once'`, `additive`); this file marks `jump`, `laugh` and
`wave` as `'once'`.

Call `mesh.update(camera, renderer)` each frame after `mixer.update`: it
refreshes the bone texture from the skeleton.

## 3. Rig a splat of your own

A scanned person, a bird or a vehicle is rigged the same way without a splat
glTF. A `SkinnedSplatMesh` takes a skin next to the splat data: up to four
bone indices and weights per splat (`bonesPerSplat: 1 | 2 | 4`). Take them
from a rigged proxy mesh:

```ts
const proxy = gltf.scene.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
const skin = computeSplatSkinWeights(splats, proxy, { bonesPerSplat: 2 });
```

`computeSplatSkinWeights` gives each splat the weights of the proxy vertex
nearest it. Pass `splatToProxy` (a `Matrix4`) when the scan and the proxy
were not made in the same frame. Then bind as you would a
`THREE.SkinnedMesh`, in the splat's own axes (a `SkinnedSplatMesh` applies no
upright correction):

```ts
const mesh = new SkinnedSplatMesh(splats, { skin });
proxy.add(mesh); // the proxy's frame is the bind space
mesh.bind(proxy.skeleton, proxy.bindMatrix);
```

Without a proxy, compute the skin from where the splats sit and build the
bones yourself. Both routes are in the type-checked guide sample
[`rigged-splats.ts`](https://github.com/Voluma-ai/vlam/blob/main/docs/guide/samples/rigged-splats.ts).

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
viewer</a> shows a goose generated in code and rigged live, with 78 bones and
its own lighting modifier stacked after the skin.

## The code

<<< ../../docs/examples/samples/rigged-splats.ts
