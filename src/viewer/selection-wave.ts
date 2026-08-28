import * as THREE from 'three/webgpu';
import { abs, length, max, min, sin, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import type { SplatModifier } from '../lib';
import type { SelectionVolumeKind } from '../lib/selection';

/** Animated wind-like displacement confined to a committed selection volume. */
export interface SelectionWave {
  readonly modifier: SplatModifier;
  update(elapsedSeconds: number): void;
}

/**
 * Builds a travelling ripple whose displacement fades across the outer 10% of
 * a selection. `dataToVolume` maps source-data centers into the unit selection
 * shape, keeping the feather attached to the cut boundary after separation.
 */
export function createSelectionWave(
  kind: SelectionVolumeKind,
  dataToVolume: THREE.Matrix4,
  amplitude: number,
): SelectionWave {
  const time = uniform(0);
  const transform = uniform(dataToVolume.clone());

  const modifier: SplatModifier = (context) => {
    const p = transform.mul(vec4(context.sourceCenter, 1)).xyz;
    const edgeDistance =
      kind === 'box'
        ? max(abs(p.x), max(abs(p.y), abs(p.z))).oneMinus()
        : kind === 'sphere'
          ? length(p).oneMinus()
          : min(length(vec3(p.x, 0, p.z)).oneMinus(), abs(p.y).oneMinus());
    // Unit shapes end at 1, so 0.1 is exactly the requested outer 10%.
    const feather = smoothstep(0, 0.1, edgeDistance);
    const phase = p.x.mul(3.1).add(p.z.mul(4.7)).sub(time.mul(2.2));
    const gust = sin(phase).add(sin(phase.mul(0.43).add(time.mul(0.7))).mul(0.35));
    const sourceOffset = vec3(gust, sin(phase.add(1.2)).mul(0.22), gust.mul(0.16)).mul(
      feather.mul(amplitude),
    );
    return { offset: context.offset.add(context.sourceToLocal.mul(sourceOffset)) };
  };

  return {
    modifier,
    update(elapsedSeconds): void {
      time.value = elapsedSeconds;
    },
  };
}
