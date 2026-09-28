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
  const [loadState, setLoadState] = useState<{
    src: string;
    status: 'loading' | 'ready' | 'failed';
  }>({ src, status: 'loading' });
  const status = loadState.src === src ? loadState.status : 'loading';

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const controller = new AbortController();
    let disposed = false;
    let renderer: THREE.WebGPURenderer | undefined;
    let controls: OrbitControls | undefined;
    let splats: SplatMesh | undefined;
    let resize: ResizeObserver | undefined;
    const dispose = () => {
      renderer?.setAnimationLoop(null);
      resize?.disconnect();
      controls?.dispose();
      splats?.dispose();
      renderer?.dispose();
      renderer?.domElement.remove();
      renderer = undefined;
      controls = undefined;
      splats = undefined;
      resize = undefined;
    };
    setLoadState({ src, status: 'loading' });

    void (async () => {
      try {
        const activeRenderer = await createWebGPURenderer();
        if (disposed) {
          activeRenderer.dispose();
          return;
        }
        renderer = activeRenderer;
        activeRenderer.setSize(host.clientWidth, host.clientHeight);
        host.appendChild(activeRenderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(
          60,
          host.clientWidth / host.clientHeight,
          0.01,
          100,
        );
        camera.position.set(0.9, 0.3, 1.7);
        const activeControls = new OrbitControls(camera, activeRenderer.domElement);
        controls = activeControls;
        activeControls.enableDamping = true;

        const data = await loadSplatData(src, { signal: controller.signal });
        if (disposed) return;

        const activeSplats = new SplatMesh(data);
        splats = activeSplats;
        scene.add(activeSplats);
        const activeResize = new ResizeObserver(() => {
          const { clientWidth: w, clientHeight: h } = host;
          if (w === 0 || h === 0) return;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          activeRenderer.setSize(w, h);
        });
        resize = activeResize;
        activeResize.observe(host);

        activeRenderer.setAnimationLoop(() => {
          activeControls.update();
          activeSplats.update(camera, activeRenderer);
          activeRenderer.render(scene, camera);
        });
        setLoadState({ src, status: 'ready' });
      } catch (error) {
        if (!disposed) {
          dispose();
          if (!isAbortError(error)) setLoadState({ src, status: 'failed' });
        }
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      dispose();
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
