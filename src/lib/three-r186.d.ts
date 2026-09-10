// Remove when @types/three publishes r186 declarations. Runtime r186 adds
// Object3D.dispose(), but the temporarily pinned r185 declarations do not.
import 'three';

declare module 'three' {
  interface Object3D {
    /** Dispatches the Object3D `dispose` event (added by three.js r186). */
    dispose(): void;
  }
}
