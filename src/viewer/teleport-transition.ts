import * as THREE from 'three';

/** The complete camera pose for one end of a teleport transition. */
export interface TeleportPose {
  readonly position: THREE.Vector3;
  readonly target: THREE.Vector3;
}

/** State retained while a teleport transition is in flight. */
export interface TeleportTransition {
  readonly startedAt: number;
  readonly duration: number;
  readonly from: TeleportPose;
  readonly to: TeleportPose;
}

/**
 * Samples a teleport using a smoothstep curve and reports whether it finished.
 * The caller owns the output vectors so the render loop does not allocate.
 */
export const sampleTeleportTransition = (
  transition: TeleportTransition,
  now: number,
  position: THREE.Vector3,
  target: THREE.Vector3,
): boolean => {
  const progress = THREE.MathUtils.clamp((now - transition.startedAt) / transition.duration, 0, 1);
  const eased = THREE.MathUtils.smoothstep(progress, 0, 1);
  position.lerpVectors(transition.from.position, transition.to.position, eased);
  target.lerpVectors(transition.from.target, transition.to.target, eased);
  return progress === 1;
};
