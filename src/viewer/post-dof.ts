/**
 * Viewer-only screen-space depth of field for captures that ship a proxy mesh
 * (LCC collision tiles, or a dropped GLB).
 *
 * The core path (`SplatMesh.setDepthOfField`) widens every splat's projected
 * footprint by its circle of confusion. That is faithful, but the fill it
 * generates grows with splat count × CoC², and an 8-million-splat capture
 * spends ~160 ms a frame on it. This pass instead renders the splats
 * unchanged into a colour target, reads the scene's depth off the proxy mesh
 * (splats write no depth - the same trick PlayCanvas's splat DoF example
 * uses, with a depth-only proxy), and blurs in screen space at a cost that
 * does not depend on how many splats there are.
 *
 * Passes, per frame:
 *  1. proxy depth, full resolution (`createProxyDepth`);
 *  2. the scene, into the colour target (the caller renders between
 *     {@link PostDepthOfField.beginFrame} and {@link PostDepthOfField.endFrame});
 *  3. prefilter, half resolution: downsampled colour plus the signed CoC;
 *  4. near dilation, half resolution: the largest near-field CoC around each
 *     pixel, so blurred foreground bleeds over the sharp background behind it;
 *  5. gather blur, half resolution: a Vogel disc whose radius is the pixel's
 *     CoC (or the dilated near CoC), each tap weighted by whether its own CoC
 *     reaches the centre, so sharp pixels do not smear into blurred ones;
 *  6. fill, half resolution: a smaller gather over the first, so the sparse
 *     disc reads as one dense kernel and holds still under camera motion;
 *  7. composite, to the frame: sharp → blurred as the CoC passes a pixel.
 *
 * The CoC is the core path's: `|depth − focus| / depth · focalPx · 0.5·aperture / focus`,
 * capped at {@link MAX_DOF_RADIUS_PX}, so the two paths take the same settings
 * and the focus slider means the same thing under both.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  cameraProjectionMatrixInverse,
  float,
  getViewPosition,
  max,
  mix,
  positionGeometry,
  screenUV,
  smoothstep,
  texture,
  uniform,
  uniformArray,
  vec2,
  vec4,
} from 'three/tsl';
import {
  MAX_DOF_RADIUS_PX,
  clampDepthOfFieldSettings,
  type DepthOfFieldSettings,
} from '../lib/core';
import { createProxyDepth, type ProxyDepth } from './proxy-depth';
import { getRendererMsaaSamples } from './renderer-msaa';

type Node<T extends string> = THREE.Node<T>;

/** Uniform-array elements come back untyped from TSL; the kernel is vec2s. */
function asNode<T extends string>(node: unknown): Node<T> {
  return node as Node<T>;
}

/** Gather taps on the blur disc. */
export const POST_DOF_TAPS = 48;
/**
 * Taps of the second, smaller gather over the first one's output. The first
 * disc is sparse (a tap per ~40 px² at the CoC cap) and its pattern slides
 * over fine splat detail as the camera moves; the fill pass turns the two
 * kernels into one dense one (48 × 16 virtual taps) so the blur holds still.
 */
export const POST_DOF_FILL_TAPS = 16;
/**
 * Pre-blur the core per-splat path keeps applying under the pass, as the CoC
 * (σ, px) a splat at infinity gets. Far splats project below a pixel, and a
 * sub-pixel Gaussian flickers on the pixel grid as the camera pans; every
 * splat in a region flickers in phase with the camera's sub-pixel motion, so
 * no screen-space blur averages it away. A couple of pixels of footprint
 * rasterizes stably, and the quads stay small (≈9 px) so fill stays cheap.
 */
export const POST_DOF_PRE_BLUR_PX = 1.5;

/**
 * Core-path aperture whose CoC reaches `radiusPx` at infinity (inverse of
 * `apertureRadiusPx = focalPx · 0.5 · aperture / focus`), never more than the
 * live aperture so the pre-blur cannot exceed the blur being asked for.
 */
export function preBlurAperture(options: {
  radiusPx: number;
  focusDistance: number;
  focalPx: number;
  aperture: number;
}): number {
  if (!(options.focalPx > 0) || !(options.aperture > 0)) return 0;
  const focus = Math.max(1e-4, options.focusDistance);
  return Math.min(options.aperture, (2 * options.radiusPx * focus) / options.focalPx);
}
/** Fill-pass radius as a fraction of the pixel's CoC. */
const FILL_RADIUS = 0.5;
/** Whether the scene target multisamples like the frame (see its comment). */
const SCENE_TARGET_MSAA = false;
/** Dilation and blur run at this fraction of the drawing buffer. */
const HALF = 2;
/** Near-field dilation footprint (taps per axis); spans the CoC cap. */
const DILATE_TAPS = 5;
/** Where a pixel starts to take the blurred colour (CoC radius, px). */
const BLEND_START_PX = 0.5;
const BLEND_FULL_PX = 2;

/**
 * Signed circle-of-confusion radius in pixels for a view-space depth.
 * Negative in front of the focus plane. `depth = Infinity` (sky, no proxy
 * hit) blurs as the far background. Zero aperture is off.
 */
export function postDofCocPx(options: {
  depth: number;
  focusDistance: number;
  aperture: number;
  focalPx: number;
  maxRadiusPx?: number;
}): number {
  const aperture = Math.max(0, options.aperture);
  if (aperture <= 0 || !(options.focalPx > 0)) return 0;
  const focus = Math.max(1e-4, options.focusDistance);
  const depth = Math.max(1e-4, options.depth);
  const focusBlur = Number.isFinite(depth) ? (depth - focus) / depth : 1;
  const apertureRadiusPx = (options.focalPx * 0.5 * aperture) / focus;
  const maxRadius = options.maxRadiusPx ?? MAX_DOF_RADIUS_PX;
  return Math.min(maxRadius, Math.max(-maxRadius, focusBlur * apertureRadiusPx));
}

/**
 * Vogel's method: `count` points evenly covering the unit disc along a golden
 * spiral, so a blur gathered over them reads as a lens disc rather than a box.
 */
export function vogelDisc(count: number): THREE.Vector2[] {
  const GOLDEN_ANGLE = 2.39996323;
  const points: THREE.Vector2[] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt((i + 0.5) / count);
    const theta = i * GOLDEN_ANGLE;
    points.push(new THREE.Vector2(r * Math.cos(theta), r * Math.sin(theta)));
  }
  return points;
}

export interface PostDepthOfField {
  readonly focusDistance: number;
  readonly aperture: number;
  /** Proxy depth for this frame (drawing-buffer size), once an occluder is set. */
  readonly depthTexture: THREE.DepthTexture | null;
  /** World-space proxy geometry (owned by the caller); `null` clears. */
  setOccluder(object: THREE.Object3D | null): void;
  setDepthOfField(settings: Partial<DepthOfFieldSettings>): void;
  /**
   * Renders the proxy depth and binds the colour target. Everything the
   * caller renders until {@link endFrame} lands in it.
   */
  beginFrame(camera: THREE.Camera): void;
  /** Blurs the colour target and writes the result to the frame. */
  endFrame(camera: THREE.Camera): void;
  dispose(): void;
}

export function createPostDepthOfField(
  renderer: THREE.WebGPURenderer,
  settings: Partial<DepthOfFieldSettings> = {},
  options: {
    /**
     * Receives the core-path settings for the pixel-scale pre-blur whenever
     * they change (see {@link POST_DOF_PRE_BLUR_PX}); apply them to the mesh.
     */
    preBlur?: (settings: DepthOfFieldSettings) => void;
  } = {},
): PostDepthOfField {
  let current = clampDepthOfFieldSettings(settings);
  let lastPreBlur = { aperture: -1, focus: -1 };
  const proxyDepth: ProxyDepth = createProxyDepth(renderer, 1);

  // --- Targets -----------------------------------------------------------------
  // The scene target skips the renderer's MSAA: a splat's quad edge sits at
  // 3σ where the Gaussian is already transparent, so extra samples change
  // nothing visible there, while every blended fragment would write all of
  // them. Only hard-edged meshes in the scene (the mark's stroke) lose
  // antialiasing, and the blur softens most of that. `SCENE_TARGET_MSAA`
  // restores the renderer's count (rebuilt when the HD/SD toggle changes it).
  const sceneSamples = (): number => (SCENE_TARGET_MSAA ? getRendererMsaaSamples(renderer) : 0);
  let sceneTarget = makeSceneTarget(sceneSamples());
  const halfTarget = (format?: THREE.PixelFormat) =>
    new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      ...(format ? { format } : {}),
    });
  // The prefilter keeps a mip chain: a wide disc's taps are several texels
  // apart, and a point sample there lets the detail between taps slip in and
  // out as the camera moves. Each tap reads the mip whose texel matches the
  // tap spacing instead, so it integrates the patch it stands for.
  const prefilterTarget = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const nearTarget = halfTarget(THREE.RedFormat);
  const blurTarget = halfTarget();
  const fillTarget = halfTarget();
  for (const target of [prefilterTarget, nearTarget, blurTarget, fillTarget]) {
    target.texture.colorSpace = THREE.LinearSRGBColorSpace;
  }

  // --- Uniforms ----------------------------------------------------------------
  const uFocus = uniform(current.focusDistance);
  const uApertureRadiusPx = uniform(0);
  const uInvFull = uniform(new THREE.Vector2(1, 1));
  const uInvHalf = uniform(new THREE.Vector2(1, 1));
  const uDepthActive = uniform(0);

  // Texture nodes follow the live targets; `sceneTarget` can be rebuilt.
  const sceneColor = texture(sceneTarget.texture);
  const depthNode = texture(proxyDepth.texture ?? new THREE.DepthTexture(1, 1));
  const prefilterNode = texture(prefilterTarget.texture);
  const nearNode = texture(nearTarget.texture);
  const blurNode = texture(blurTarget.texture);
  const fillNode = texture(fillTarget.texture);

  /** Signed CoC (px) at a screen uv from the proxy depth under it. */
  const cocAt = (uv: Node<'vec2'>): Node<'float'> => {
    // Implicit level, not `.level(0)`: three's GLSL builder does not narrow a
    // depth texture's `textureLod()` to a float (see proxy-depth.ts).
    const d = depthNode.sample(uv).x;
    const view = getViewPosition(uv, d, cameraProjectionMatrixInverse);
    // No hit (sky) or no proxy at all: the far background.
    const hit = d.lessThan(0.9999).and(uDepthActive.greaterThan(0));
    const depth = hit.select(view.z.negate().max(1e-4), float(1e6));
    const focusBlur = depth.sub(uFocus).div(depth);
    return focusBlur.mul(uApertureRadiusPx).clamp(-MAX_DOF_RADIUS_PX, MAX_DOF_RADIUS_PX);
  };

  // --- Passes ------------------------------------------------------------------
  // Four bilinear taps a pixel out from the half-res centre: a 4×4 box over the
  // scene rather than the 2×2 a single tap gives, so fine splat detail does
  // not alias into the blur's source as the camera moves.
  const prefilter = Fn(() => {
    const uv = screenUV;
    const box = sceneColor
      .sample(uv.add(uInvFull.mul(vec2(-1, -1))))
      .rgb.add(sceneColor.sample(uv.add(uInvFull.mul(vec2(1, -1)))).rgb)
      .add(sceneColor.sample(uv.add(uInvFull.mul(vec2(-1, 1)))).rgb)
      .add(sceneColor.sample(uv.add(uInvFull.mul(vec2(1, 1)))).rgb)
      .mul(0.25);
    return vec4(box, cocAt(uv));
  });

  // Largest near-field CoC in the neighbourhood, so the blur radius (and the
  // composite's blend) reach past a foreground object's silhouette.
  const nearDilate = Fn(() => {
    const uv = screenUV;
    const reach = (MAX_DOF_RADIUS_PX / HALF) * (2 / (DILATE_TAPS - 1));
    const best = float(0).toVar();
    for (let y = 0; y < DILATE_TAPS; y++) {
      for (let x = 0; x < DILATE_TAPS; x++) {
        const offset = vec2(
          (x - (DILATE_TAPS - 1) / 2) * reach,
          (y - (DILATE_TAPS - 1) / 2) * reach,
        );
        const coc = prefilterNode.sample(uv.add(uInvHalf.mul(offset))).a;
        best.assign(max(best, coc.negate()));
      }
    }
    return vec4(best, 0, 0, 1);
  });

  const kernel = uniformArray(vogelDisc(POST_DOF_TAPS));
  const blur = Fn(() => {
    const uv = screenUV;
    const centre = prefilterNode.sample(uv).toVar();
    const radius = max(centre.a.abs(), nearNode.sample(uv).r).toVar();
    const acc = centre.rgb.toVar();
    const weight = float(1).toVar();
    If(radius.greaterThan(BLEND_START_PX), () => {
      const step = uInvFull.mul(radius);
      // Tap spacing in half-res texels → the mip whose texel is that wide.
      const spacing = radius.mul(2 / (HALF * Math.sqrt(POST_DOF_TAPS)));
      const lod = spacing.max(1).log2();
      Loop(POST_DOF_TAPS, ({ i }) => {
        const offset = asNode<'vec2'>(kernel.element(i));
        const tap = prefilterNode.sample(uv.add(step.mul(offset))).level(lod);
        const distance = radius.mul(offset.length());
        // A tap belongs in this pixel's disc when its own CoC reaches back
        // here: sharp neighbours stay out of a blurred pixel's average, and
        // a blurred foreground spreads over everything within its CoC.
        const reach = tap.a.abs().sub(distance).mul(0.5).add(1).clamp(0, 1);
        // Signed CoC grows with depth, so a tap with a larger one lies behind
        // this pixel: the background never bleeds over a nearer object (a
        // blurred pillar keeps its own colour), while nearer taps always may.
        const behind = tap.a.sub(centre.a).sub(2).div(6).oneMinus().clamp(0, 1);
        const w = reach.mul(behind);
        acc.addAssign(tap.rgb.mul(w));
        weight.addAssign(w);
      });
    });
    return vec4(acc.div(weight), radius);
  });

  // Second gather over the first, at half its radius, with the same reach
  // test on the stored radius so sharp neighbours still stay out.
  const fillKernel = uniformArray(vogelDisc(POST_DOF_FILL_TAPS));
  const fill = Fn(() => {
    const uv = screenUV;
    const centre = blurNode.sample(uv).toVar();
    const radius = centre.a.toVar();
    const acc = centre.rgb.toVar();
    const weight = float(1).toVar();
    If(radius.greaterThan(BLEND_START_PX), () => {
      const step = uInvFull.mul(radius.mul(FILL_RADIUS));
      Loop(POST_DOF_FILL_TAPS, ({ i }) => {
        const offset = asNode<'vec2'>(fillKernel.element(i));
        const tap = blurNode.sample(uv.add(step.mul(offset)));
        const distance = radius.mul(FILL_RADIUS).mul(offset.length());
        const w = tap.a.sub(distance).mul(0.5).add(1).clamp(0, 1);
        acc.addAssign(tap.rgb.mul(w));
        weight.addAssign(w);
      });
    });
    return vec4(acc.div(weight), radius);
  });

  const composite = Fn(() => {
    const uv = screenUV;
    const sharp = sceneColor.sample(uv);
    const blurred = fillNode.sample(uv).rgb;
    const radius = max(cocAt(uv).abs(), nearNode.sample(uv).r);
    const blend = smoothstep(BLEND_START_PX, BLEND_FULL_PX, radius);
    return vec4(mix(sharp.rgb, blurred, blend), sharp.a);
  });

  const fullScreenPass = (colorNode: Node<'vec4'>) => {
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: false,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    material.vertexNode = vec4(positionGeometry.xy, 0, 1);
    material.colorNode = colorNode;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    return { scene, material, quad };
  };
  const passes = {
    prefilter: fullScreenPass(prefilter()),
    near: fullScreenPass(nearDilate()),
    blur: fullScreenPass(blur()),
    fill: fullScreenPass(fill()),
    composite: fullScreenPass(composite()),
  };

  const bufferSize = new THREE.Vector2();
  let previousTarget: THREE.RenderTarget | null = null;
  let inFrame = false;

  const renderPass = (
    pass: { scene: THREE.Scene },
    target: THREE.RenderTarget | null,
    camera: THREE.Camera,
  ): void => {
    renderer.setRenderTarget(target);
    renderer.render(pass.scene, camera);
  };

  return {
    get focusDistance() {
      return current.focusDistance;
    },
    get aperture() {
      return current.aperture;
    },
    get depthTexture() {
      return proxyDepth.texture;
    },
    setOccluder(object) {
      proxyDepth.setOccluder(object);
    },
    setDepthOfField(next) {
      current = clampDepthOfFieldSettings(next, current);
      uFocus.value = current.focusDistance;
    },
    beginFrame(camera) {
      proxyDepth.render(camera);
      if (proxyDepth.texture) depthNode.value = proxyDepth.texture;
      uDepthActive.value = proxyDepth.texture ? 1 : 0;

      renderer.getDrawingBufferSize(bufferSize);
      const width = Math.max(1, bufferSize.x);
      const height = Math.max(1, bufferSize.y);
      const samples = sceneSamples();
      if (sceneTarget.samples !== samples) {
        sceneTarget.dispose();
        sceneTarget = makeSceneTarget(samples);
        sceneColor.value = sceneTarget.texture;
      }
      if (sceneTarget.width !== width || sceneTarget.height !== height) {
        sceneTarget.setSize(width, height);
      }
      const halfWidth = Math.max(1, Math.ceil(width / HALF));
      const halfHeight = Math.max(1, Math.ceil(height / HALF));
      for (const target of [prefilterTarget, nearTarget, blurTarget, fillTarget]) {
        if (target.width !== halfWidth || target.height !== halfHeight) {
          target.setSize(halfWidth, halfHeight);
        }
      }
      uInvFull.value.set(1 / width, 1 / height);
      uInvHalf.value.set(1 / halfWidth, 1 / halfHeight);

      // Vertical focal length in pixels, as the splat material derives it.
      const focalPx = (camera.projectionMatrix.elements[5] * height) / 2;
      uApertureRadiusPx.value =
        current.aperture > 0 && focalPx > 0
          ? (focalPx * 0.5 * current.aperture) / Math.max(1e-4, current.focusDistance)
          : 0;
      if (options.preBlur) {
        const aperture = preBlurAperture({
          radiusPx: POST_DOF_PRE_BLUR_PX,
          focusDistance: current.focusDistance,
          focalPx,
          aperture: current.aperture,
        });
        if (aperture !== lastPreBlur.aperture || current.focusDistance !== lastPreBlur.focus) {
          lastPreBlur = { aperture, focus: current.focusDistance };
          options.preBlur({ focusDistance: current.focusDistance, aperture });
        }
      }

      previousTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(sceneTarget);
      inFrame = true;
    },
    endFrame(camera) {
      if (!inFrame) return;
      inFrame = false;
      const autoClear = renderer.autoClear;
      try {
        // Every texel of each pass is written; no clears needed.
        renderer.autoClear = false;
        renderPass(passes.prefilter, prefilterTarget, camera);
        renderPass(passes.near, nearTarget, camera);
        renderPass(passes.blur, blurTarget, camera);
        renderPass(passes.fill, fillTarget, camera);
        renderPass(passes.composite, previousTarget, camera);
      } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.autoClear = autoClear;
        previousTarget = null;
      }
    },
    dispose() {
      if (inFrame) {
        renderer.setRenderTarget(previousTarget);
        inFrame = false;
      }
      proxyDepth.dispose();
      sceneTarget.dispose();
      for (const target of [prefilterTarget, nearTarget, blurTarget, fillTarget]) {
        target.dispose();
      }
      for (const pass of Object.values(passes)) {
        pass.material.dispose();
        pass.quad.geometry.dispose();
      }
    },
  };
}

function makeSceneTarget(samples: number): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    samples,
  });
  // Scene colour is working-space; the composite's output transform (the
  // renderer's `outputColorSpace`) runs once, on the way to the frame.
  target.texture.colorSpace = THREE.LinearSRGBColorSpace;
  return target;
}
