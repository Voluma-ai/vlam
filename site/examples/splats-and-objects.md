# Mix splats with ordinary 3D objects

**What you get:** a lit three.js object parented to, and moving with, a capture.

<ExampleEmbed slug="splats-and-objects" hint="A lit three.js cube parented to the capture, worn as a spinning hat" />

## A SplatMesh is just a three.js object

`SplatMesh` is a normal three.js object: `add`, `remove`, `visible`, and
parenting work as expected.

Per-axis scale is supported end to end, rendering, sorting, picking and spatial queries all account for it. A squashed capture is picked as a squashed capture.

Transforms use matrix uniforms, so moving a capture does not re-upload its data.

## Preserve the mesh orientation correction

Capture tools disagree about which axis is up. VLAM! stands known formats upright for you, and it does that by writing the correction into **the mesh's own rotation**, for this goose, a half turn about X.

Replacing the mesh orientation wholesale removes that correction:

```ts
splats.rotation.set(0, Math.PI / 4, 0); // ✗ upside down, the X term is gone
splats.quaternion.copy(someRotation); // ✗ same
```

Adjusting one axis, or the position and scale, is fine, those leave the correction intact:

```ts
splats.rotation.y += 0.01; // ✓ still upright
splats.position.set(-0.5, 0, 0); // ✓
splats.scale.setScalar(1.5); // ✓
```

The habit that makes the distinction stop mattering is to put the capture in a `Group` and transform the group:

```ts
const goose = new THREE.Group();
goose.add(splats); // the mesh keeps its own correction, whatever you do out here
scene.add(goose);
goose.rotation.set(0, Math.PI / 4, 0); // ✓ your transform, one level up
```

It also gives you a controllable pivot.

(If you would rather own the axes outright, pass `orientation: 'source'` to the `SplatMesh` constructor. Then its rotation is yours alone, and standing the capture up is your job.)

## Parent the object to get it pinned

The hat is added to the same group as the capture, not to the scene. That is what makes it *worn* rather than merely nearby: its position is given in the capture's own frame, and if you later move, spin or scale the group, the hat goes along instead of being left hovering in mid-air.

Only the hat spins in the loop below, the goose stays where it is, and you move the camera yourself by dragging.

Where exactly to put it is a matter of looking. The measurement in this example, head top at `y ≈ 0.5`, around `x ≈ -0.21`, was found by inspecting the capture once and hardcoding it, which is the normal way to do this.

## Two things behave differently, and both are about light

**Lights do not touch the capture.** A capture already has its lighting baked in, that is what was photographed. Adding a `DirectionalLight` brightens your cube and does nothing to the splats. The [lighting preset](/examples/shader-effects) is a stylistic layer. For a moving sun with shadows, see [Relight a capture](/examples/relight).

**Matching the look is on you.** A capture shot on an overcast afternoon and a shiny blue cube lit by a hard sun will not look like they belong together. Match your lights to the capture's own lighting, not the other way around.

## Getting the two to agree on scale

A capture's units come from however the photogrammetry solve turned out. One unit is rarely one metre, and it differs per capture, this goose is about one unit tall, so a 0.17-unit cube reads as a hat. Expect to find your numbers by eye, once, and hardcode them, exactly as this example does.

## The code

::: code-group

<<< ../../docs/examples/samples/splats-and-objects.ts [main.ts]

```html [index.html]
<!doctype html>
<html>
 <head>
 <meta charset="utf-8" />
 <style>
 body {
 margin: 0;
 overflow: hidden;
 }
 </style>
 </head>
 <body>
 <script type="module" src="/main.ts"></script>
 </body>
</html>
```

:::

## Use the node materials

The renderer is a `WebGPURenderer`, so ordinary geometry wants the node materials, `MeshStandardNodeMaterial`, `MeshBasicNodeMaterial`, rather than the classic `MeshStandardMaterial`. They take the same options; only the import name changes. This is a three.js rule, not a VLAM! one, and it applies to everything in the scene except the splats.

## About things overlapping

Splats are transparent, and transparency is order-dependent. The capture is sorted against itself correctly every frame, but a solid object that *intersects* the splat cloud can show a hard seam where the two meet, the cube is either in front of a splat or behind it, with nothing in between.

Objects that sit clearly beside, in front of, or behind the capture look fine. Objects half-buried in it are where you will see artifacts. Design around it rather than fighting it.

## Next

- [Shader effects](/examples/shader-effects): cut a hole in the capture so the object can sit inside it
- [All samples](/examples/all-samples): several captures sorted and blended as one, via the unified renderer
