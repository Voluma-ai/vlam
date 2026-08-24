// Example: site/examples/react-viewer.md - mounting the component. StrictMode
// is on deliberately: it double-mounts in development, which is exactly the
// pressure the component's cleanup has to survive.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SplatViewer } from './react-viewer';

function App() {
  const [shown, setShown] = useState(true);

  return (
    <>
      <button type="button" className="toggle" onClick={() => setShown((v) => !v)}>
        {shown ? 'Unmount the viewer' : 'Mount the viewer'}
      </button>
      {/* Toggle it a few times: without the cleanup, every mount would leak a
          renderer and a splat pool, and the page would slow to a crawl. */}
      {shown && <SplatViewer src="/goose.sog" />}
    </>
  );
}

createRoot(document.querySelector('#root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
