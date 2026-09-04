// Example: site/examples/react-viewer.md - a <SplatViewer> component that
// sets up and, more importantly, tears down cleanly.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, createWebGPURenderer } from '@voluma/vlam';
import { isAbortError, loadSplatData } from '@voluma/vlam/loaders';

interface SplatViewerProps {
  src: string;
  className?: string;
}

export function SplatViewer({ src, className }: SplatViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Everything created inside this effect is torn down by its cleanup. Both
    // are needed because setup is async: the effect can be cleaned up while
    // the scene is still downloading, and under StrictMode in development
    // React deliberately mounts, unmounts and remounts to prove it.
    const controller = new AbortController();
    let disposed = false;
    let dispose = () => {};

    void (async () => {
      try {
        const renderer = await createWebGPURenderer();
        // The effect was cleaned up while the renderer was being created:
        // throw away what we just built instead of attaching it to a DOM node
        // React has already discarded.
        if (disposed) {
          renderer.dispose();
          return;
        }

        renderer.setSize(host.clientWidth, host.clientHeight);
        host.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(
          60,
          host.clientWidth / host.clientHeight,
          0.01,
          100,
        );
        camera.position.set(0.9, 0.3, 1.7);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;

        const data = await loadSplatData(src, { signal: controller.signal });
        if (disposed) {
          renderer.dispose();
          controls.dispose();
          return;
        }

        const splats = new SplatMesh(data);
        scene.add(splats);
        setStatus('ready');

        const resize = new ResizeObserver(() => {
          const { clientWidth: w, clientHeight: h } = host;
          if (w === 0 || h === 0) return;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        });
        resize.observe(host);

        renderer.setAnimationLoop(() => {
          controls.update();
          splats.update(camera, renderer);
          renderer.render(scene, camera);
        });

        dispose = () => {
          // Stop the loop first: it touches everything disposed below.
          renderer.setAnimationLoop(null);
          resize.disconnect();
          controls.dispose();
          splats.dispose(); // pool textures, sorter buffers, pick resources
          renderer.dispose();
          renderer.domElement.remove();
        };
      } catch (error) {
        // A cancelled load is the expected outcome of unmounting mid-download,
        // not a failure worth showing the user.
        if (!isAbortError(error)) setStatus('failed');
      }
    })();

    return () => {
      disposed = true;
      controller.abort(); // cancels a load still in flight
      dispose(); // no-op if setup never got that far
    };
  }, [src]);

  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
      {status !== 'ready' && (
        <p style={{ position: 'absolute', top: 12, left: 12, margin: 0, color: '#fff' }}>
          {status === 'loading' ? 'Loading…' : 'Could not load that capture.'}
        </p>
      )}
    </div>
  );
}
