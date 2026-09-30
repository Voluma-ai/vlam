import * as THREE from 'three/webgpu';
import { sdfEffects } from '@voluma/vlam/effects';

const transform = new THREE.Matrix4().makeScale(2, 1, 0.5);
export const preview = sdfEffects([
  { kind: 'sphere', mode: 'tint', transform, radius: 1, color: [1, 0, 1] },
]);
