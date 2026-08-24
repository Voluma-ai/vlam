# Save and share a viewpoint

**What you get:** shareable camera URLs and eased transitions between views.

<ExampleEmbed slug="share-a-viewpoint" hint="Orbit, copy the link, or fly between the saved viewpoints" />

## This is what turns a viewer into a tool

A viewpoint stores the camera position and target as six numbers, compact enough
for a URL without a server or account:

```
?view=0.900,0.300,1.700,0.000,0.000,0.000
```

Read it on load and write it when the user shares a view.

## Validate URL parameters

A URL is user input. Validate it before applying it: `NaN` in a camera matrix
renders a blank screen.

```ts
if (n.length !== 6 || n.some((v) => !Number.isFinite(v))) return null; // fall back
```

Validate, and fall back to your default view. Three decimal places is plenty of precision and keeps the link short enough to paste anywhere.

## Update the address bar, don't navigate

```ts
history.replaceState(null, '', url);
```

Assigning to `location.search` reloads the page, throwing away the capture the user just waited to download, to arrive at the view they were already looking at. `replaceState` changes the URL in place and costs nothing.

## Flying, not teleporting

Interpolating between viewpoints helps users keep their bearings. About one second
is usually enough.

Two things make it feel right:

**Ease in and out.** Linear interpolation starts and stops abruptly and reads as mechanical. A cubic ease makes the same movement feel deliberate.

**Interpolate position and target separately.** Both are just `lerpVectors` between the start and end, and moving the target alongside the position keeps the subject in frame throughout, the camera swings *around* the scene rather than sailing past it.

## The code

::: code-group

<<< ../../docs/examples/samples/share-a-viewpoint.ts [main.ts]

```html [index.html]
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        margin: 0;
        overflow: hidden;
        font: 14px system-ui;
      }
      #ui {
        position: fixed;
        top: 14px;
        left: 14px;
        z-index: 1;
        display: flex;
        gap: 10px;
        align-items: center;
        color: #fff;
        text-shadow: 0 1px 4px #000;
      }
    </style>
  </head>
  <body>
    <div id="ui">
      <button id="copy" type="button">Copy link to this view</button>
      <button id="tour" type="button">Fly to next viewpoint</button>
      <span id="status"></span>
    </div>
    <script type="module" src="/main.ts"></script>
  </body>
</html>
```

:::

Note that the clipboard write has a failure path. `navigator.clipboard` needs a secure context and can be refused by permissions policy; when it fails, the URL is still in the address bar, and saying so is more useful than a copy button that silently does nothing.

## Where this goes next

- **A guided tour.** The same flight, run through a list on a timer, is a walkthrough, a first-run experience that shows the capture off without the user having to learn the controls.
- **Put the scene in the link too.** Add `?scene=` alongside `?view=` and one URL identifies both what to load and where to stand. That is exactly what the [full viewer](/demo/) does.
- **Frame first, then save.** [Frame the capture](/examples/frame-the-camera) gives you the sensible default view that a link-less visitor should land on.

## Next

- [Frame the capture](/examples/frame-the-camera), the view people get when there is no link
- [Annotations pinned to the capture](/examples/annotations), the other half of "look at this bit"
