import { clamp, mix, sin, uniform, vec3, vec4 } from 'three/tsl';
import type { SplatModifier } from '../lib/core';

/**
 * A pair of demo {@link SplatModifier}s (`?effects=demo`) that exercise the
 * hook contract end to end:
 *
 *  1. a time-driven opacity pulse - reads the running `color`, animates its
 *     alpha from a uniform that changes every frame **without** recompiling;
 *  2. a height tint - reads a derived context field (`worldCenter`) and folds
 *     its color change on top of the pulse.
 *
 * Two modifiers, two different context reads, order-dependent composition -
 * enough to prove the fold, the lazy derived-field graph, and the
 * uniform-animation-is-free property in one glance.
 */
export interface DemoEffects {
  readonly modifiers: readonly SplatModifier[];
  /** Advance the animated uniforms; call once per frame with elapsed seconds. */
  update(elapsedSeconds: number): void;
}

export function createDemoEffects(): DemoEffects {
  const time = uniform(0);

  // Opacity pulse ~2× the original rate between ~0.2 and 1.0 - strong enough
  // to read on dense overdraw, without fully blanking the scene. Animating
  // `time.value` alone must not trigger a recompile.
  const pulse: SplatModifier = (context) => {
    const factor = sin(time.mul(2)).mul(0.4).add(0.6);
    return { color: vec4(context.color.rgb, context.color.a.mul(factor)) };
  };

  // Warm-high / cool-low tint by world height. Reads `worldCenter`, so the
  // fold pulls the model-matrix multiply into the graph only for this effect.
  const heightTint: SplatModifier = (context) => {
    const t = clamp(context.worldCenter.y.mul(0.5).add(0.5), 0, 1);
    const tint = mix(vec3(0.35, 0.6, 1.0), vec3(1.0, 0.65, 0.35), t);
    return { color: vec4(context.color.rgb.mul(tint), context.color.a) };
  };

  return {
    modifiers: [pulse, heightTint],
    update(elapsedSeconds: number): void {
      time.value = elapsedSeconds;
    },
  };
}
