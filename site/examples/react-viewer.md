# Use it from React

**What you get:** a `<SplatViewer src="…" />` component that creates and
disposes a viewer safely, including in-flight loads.

<ExampleEmbed slug="react-viewer" hint="Toggle the viewer on and off, it survives StrictMode's double mount" />

## VLAM! is not a React library, and does not need to be

`SplatMesh` is a three.js object and the renderer owns its canvas. In React, use
one `useEffect` to create them and its cleanup to dispose them.

## Why cleanup matters more here than usual

A leaked viewer retains a GPU device, splat-pool memory, sorter and picking
resources, and a running animation loop. Browsers do not reclaim these resources
for you.

```ts
return () => {
 renderer.setAnimationLoop(null); // stop first, it touches everything below
 controls.dispose();
 splats.dispose(); // pool textures, sorter buffers, pick resources
 renderer.dispose();
 renderer.domElement.remove();
};
```

Order matters: stop the loop before disposing what the loop reads, or a frame already scheduled can run against freed resources.

## The async setup problem

`createSplatRenderer` and `loadSplatData` are both async. React can, and in development *will*, unmount your component while they are still running. When the promise finally resolves, the effect that started it is long gone, and the code cheerfully appends a canvas to a DOM node nobody is looking at.

Two guards handle it:

**A `disposed` flag,** checked after every `await`. If the effect was cleaned up while you were waiting, throw away whatever you just built instead of attaching it.

**An `AbortController`,** passed to `loadSplatData`. This cancels the download itself rather than letting a hundred-megabyte capture finish arriving for a component that no longer exists. The resulting rejection is an abort, not a failure, `isAbortError` is how you tell them apart, and showing an error state for a cancelled load is a bug users will see as a flash of "something went wrong" during normal navigation.

## StrictMode is doing you a favour

In development, React's `StrictMode` mounts, unmounts, and remounts components.
It is a useful lifecycle test for route changes, conditional rendering, and hot
reloads.

## The code

::: code-group

<<< ../../docs/examples/samples/react-viewer.tsx [SplatViewer.tsx]

<<< ../../docs/examples/samples/react-main.tsx [main.tsx]

:::

## Integration notes

**Keep the mesh out of state.** `useState` on a `SplatMesh` buys nothing. React never renders it, and re-renders that touch it just create work. A `useRef`, or a closure inside the effect as used here, is the right home.

**Do not put the render loop in React.** `setAnimationLoop` already runs at display rate. Driving frames from state updates fights the reconciler for no benefit.

**Size from the container, not the window.** A component does not own the viewport. A `ResizeObserver` on the host element handles sidebars, split panes and layout shifts that a `resize` listener never sees.

**Re-run on `src`, and nothing else.** The dependency array here is `[src]`. Adding an object or a callback that is recreated every render tears down and rebuilds the entire viewer on every parent render, the worst possible outcome, arrived at by a one-character mistake.

## Other frameworks

Nothing above is React-specific in substance. Vue's `onMounted` / `onUnmounted`, Svelte's `onMount` return value, and Angular's `ngOnDestroy` all want the same two things: build after the element exists, and dispose everything, including in-flight loads, when it goes away.

## Next

- [Frame the capture](/examples/frame-the-camera), what a component should do once the capture arrives
- [Your first viewer](/examples/first-viewer), the same app without a framework, for comparison
