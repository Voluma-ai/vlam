/**
 * Viewer-only scene depth for the VLAM! mark's emissive parts. Splats write
 * no depth, so the fire (the ray-marched volume and the glow, embers and pool
 * splats drawn on their own after the scene) stops at the collision proxy
 * plus the mark's stroke instead: this module keeps that depth for the frame.
 *
 * Under the fog effect the fog's lighting pass has already rendered the same
 * proxy, so its depth is borrowed; otherwise the proxy is rendered here,
 * depth only, at reduced resolution.
 */
import * as THREE from 'three/webgpu';
import {
  cameraProjectionMatrix,
  cameraProjectionMatrixInverse,
  float,
  getViewPosition,
  texture,
  uniform,
  vec2,
  vec4,
} from 'three/tsl';
import type { SplatModifier } from '../lib/core';

export interface ProxyDepth {
  /** Depth for this frame, or `null` while there is no proxy yet. */
  readonly texture: THREE.DepthTexture | null;
  /** World-space proxy geometry (owned by the caller); `null` clears. */
  setOccluder(object: THREE.Object3D | null): void;
  /**
   * Per frame, before the main render: renders the proxy's depth, or adopts
   * `sharedDepth` (scene depth already rendered this frame at drawing-buffer
   * size, the fog's) and skips the pass.
   */
  render(camera: THREE.Camera, sharedDepth?: THREE.DepthTexture | null): void;
  /**
   * Hides splats whose center lies behind the proxy, for a standalone splat
   * draw that does not sort with the scene. Per splat, so a large glow
   * splat pops rather than clips; `margin` (metres) keeps splats resting on a
   * surface, such as the light pool on the floor, from flickering.
   */
  occlusionModifier(margin?: number): SplatModifier;
  dispose(): void;
}

export function createProxyDepth(renderer: THREE.WebGPURenderer, downscale = 2): ProxyDepth {
  const occluderScene = new THREE.Scene();
  const occluderMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });
  occluderMaterial.side = THREE.DoubleSide;
  occluderScene.overrideMaterial = occluderMaterial;
  // Only the depth is read; the colour attachment three insists on stays small.
  const target = new THREE.RenderTarget(1, 1, { type: THREE.UnsignedByteType });
  target.depthTexture = new THREE.DepthTexture(1, 1);
  const own = target.depthTexture;
  let occluder: THREE.Object3D | null = null;
  let current: THREE.DepthTexture | null = null;

  // Splat occlusion: one texture node whose value follows `current`.
  const depthNode = texture(own);
  const uActive = uniform(0);
  const drawingSize = new THREE.Vector2();

  return {
    get texture() {
      return current;
    },
    setOccluder(object) {
      if (occluder) occluderScene.remove(occluder);
      occluder = object;
      if (object) occluderScene.add(object);
    },
    render(camera, sharedDepth = null) {
      if (sharedDepth) {
        current = sharedDepth;
      } else if (occluder) {
        renderer.getDrawingBufferSize(drawingSize);
        const width = Math.max(1, Math.ceil(drawingSize.x / downscale));
        const height = Math.max(1, Math.ceil(drawingSize.y / downscale));
        if (target.width !== width || target.height !== height) target.setSize(width, height);
        const previousTarget = renderer.getRenderTarget();
        const previousAutoClear = renderer.autoClear;
        try {
          renderer.autoClear = true;
          renderer.setRenderTarget(target);
          renderer.render(occluderScene, camera);
        } finally {
          renderer.setRenderTarget(previousTarget);
          renderer.autoClear = previousAutoClear;
        }
        current = own;
      } else {
        current = null;
      }
      if (current) depthNode.value = current;
      uActive.value = current ? 1 : 0;
    },
    occlusionModifier(margin = 0.3) {
      return (ctx) => {
        // The splat center's pixel, then the proxy's view-space hit there.
        const clip = cameraProjectionMatrix.mul(vec4(ctx.viewCenter, 1));
        const ndc = clip.xy.div(clip.w);
        const uv = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5));
        const depth = depthNode.sample(uv).level(float(0)).x;
        const hit = getViewPosition(uv, depth, cameraProjectionMatrixInverse);
        // View space looks down -z: behind means further negative. A float
        // mask on alpha rather than `visible`/`select`, which drop splats in
        // a modifier graph.
        const behind = ctx.viewCenter.z
          .lessThan(hit.z.sub(margin))
          .and(depth.lessThan(0.9999))
          .toFloat()
          .mul(uActive);
        return { color: vec4(ctx.color.rgb, ctx.color.a.mul(float(1).sub(behind))) };
      };
    },
    dispose() {
      if (occluder) occluderScene.remove(occluder);
      target.dispose();
      occluderMaterial.dispose();
    },
  };
}
