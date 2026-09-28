import * as THREE from 'three';
import type { WebGPURenderer, NodeMaterial } from 'three/webgpu';
import type { UnifiedSplatMesh } from '../lib/unified/unified-splat-mesh';
import type { SparkRenderer } from '@sparkjsdev/spark';

/** Post-sample GPU projection snapshot; continuous areas are raster-work proxies. */
export interface ProjectionEye {
  camera: THREE.Camera;
  width: number;
  height: number;
}

/** Freeze the current native eye transforms before asynchronous readback. */
export function snapshotXrProjectionEyes(
  renderer: WebGPURenderer | THREE.WebGLRenderer,
): ProjectionEye[] {
  if (!renderer.xr.isPresenting)
    throw new Error('Projected coverage requires an active XR session');
  return renderer.xr.getCamera().cameras.map((eye) => {
    const viewport = (eye as THREE.Camera & { viewport: THREE.Vector4 }).viewport;
    if (!(viewport.z > 0 && viewport.w > 0)) throw new Error('XR eye viewport unavailable');
    return {
      camera: frozenEye(
        { camera: eye, width: viewport.z, height: viewport.w },
        viewport.z,
        viewport.w,
      ),
      width: viewport.z,
      height: viewport.w,
    };
  });
}

function eyePose(eye: ProjectionEye) {
  return {
    position: eye.camera.getWorldPosition(new THREE.Vector3()).toArray(),
    forward: eye.camera.getWorldDirection(new THREE.Vector3()).toArray(),
    projectionMatrix: eye.camera.projectionMatrix.toArray(),
  };
}

const columns = 512;

function frozenEye(
  eye: ProjectionEye,
  gridWidth: number,
  gridHeight: number,
  renderer?: WebGPURenderer | THREE.WebGLRenderer,
): THREE.Camera {
  const camera = eye.camera.clone();
  camera.parent = null;
  camera.matrixAutoUpdate = false;
  camera.matrixWorldAutoUpdate = false;
  camera.matrix.copy(eye.camera.matrixWorld);
  camera.matrixWorld.copy(eye.camera.matrixWorld);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  if (renderer) {
    // Native XR matrices are authored directly. The regular offscreen renderer
    // otherwise rebuilds a PerspectiveCamera from its placeholder fov/aspect.
    camera.coordinateSystem = renderer.coordinateSystem;
    (camera as THREE.Camera & { _reversedDepth: boolean })._reversedDepth = Boolean(
      'reversedDepthBuffer' in renderer
        ? renderer.reversedDepthBuffer
        : renderer.capabilities.reversedDepthBuffer,
    );
  }
  (camera as THREE.Camera & { viewport: THREE.Vector4 }).viewport = new THREE.Vector4(
    0,
    0,
    gridWidth,
    gridHeight,
  );
  return camera;
}

function polygonArea(points: number[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 2) {
    const next = (i + 2) % points.length;
    area += points[i]! * points[next + 1]! - points[next]! * points[i + 1]!;
  }
  return Math.abs(area) * 0.5;
}

function clippedQuadArea(points: number[], width: number, height: number): number {
  let polygon = points;
  for (const [axis, bound, greater] of [
    [0, 0, true],
    [0, width, false],
    [1, 0, true],
    [1, height, false],
  ] as const) {
    const next: number[] = [];
    for (let i = 0; i < polygon.length; i += 2) {
      const j = (i + 2) % polygon.length;
      const a = polygon[i + axis]!;
      const b = polygon[j + axis]!;
      const insideA = greater ? a >= bound : a <= bound;
      const insideB = greater ? b >= bound : b <= bound;
      if (insideA) next.push(polygon[i]!, polygon[i + 1]!);
      if (insideA !== insideB) {
        const t = (bound - a) / (b - a);
        next.push(
          polygon[i]! + t * (polygon[j]! - polygon[i]!),
          polygon[i + 1]! + t * (polygon[j + 1]! - polygon[i + 1]!),
        );
      }
    }
    polygon = next;
    if (!polygon.length) return 0;
  }
  return polygonArea(polygon);
}

export function summarizeProjectedQuads(
  data: Float32Array,
  count: number,
  gridWidth: number,
  eye: Pick<ProjectionEye, 'width' | 'height'>,
  backend: 'WebGPU' | 'WebGL2',
) {
  let vertexRejected = 0,
    depthRejected = 0,
    degenerate = 0,
    viewportMiss = 0,
    positiveViewportQuads = 0;
  let sumUnclippedQuadAreaPx = 0,
    sumClippedQuadAreaPx = 0;
  const radii: number[] = [];
  const radiusBounds = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, Infinity];
  const radiusCounts = radiusBounds.map(() => 0);
  const largest: {
    drawIndex: number;
    clippedQuadAreaPx: number;
    majorRadiusPx: number;
    minorRadiusPx: number;
  }[] = [];
  for (let index = 0; index < count; index++) {
    const x = (index % columns) * 2,
      y = Math.floor(index / columns) * 2;
    const offsets = [
      4 * (y * gridWidth + x),
      4 * (y * gridWidth + x + 1),
      4 * ((y + 1) * gridWidth + x),
      4 * ((y + 1) * gridWidth + x + 1),
    ];
    const p = offsets.map((offset) => Array.from(data.subarray(offset, offset + 4)));
    if (p.some((v) => v.length !== 4 || v.some((value) => !Number.isFinite(value))))
      throw new Error('Non-finite/incomplete GPU projection');
    if (p.every((v) => v[3] === 0) || p.every((v) => v[0] === 0 && v[1] === 0 && v[2] === 2)) {
      vertexRejected++;
      continue;
    }
    if (p.some((v) => v[3] !== 1))
      throw new Error('GPU projection cell was only partially written');
    const centerX = p.reduce((sum, v) => sum + v[0]!, 0) / 4;
    const centerY = p.reduce((sum, v) => sum + v[1]!, 0) / 4;
    const depth = p.reduce((sum, v) => sum + v[2]!, 0) / 4;
    if (depth < (backend === 'WebGPU' ? 0 : -1) || depth > 1) {
      depthRejected++;
      continue;
    }
    const mx = (((p[1]![0]! + p[3]![0]! - p[0]![0]! - p[2]![0]!) / 2) * eye.width) / 2;
    const my = (((p[1]![1]! + p[3]![1]! - p[0]![1]! - p[2]![1]!) / 2) * eye.height) / 2;
    const nx = (((p[2]![0]! + p[3]![0]! - p[0]![0]! - p[1]![0]!) / 2) * eye.width) / 2;
    const ny = (((p[2]![1]! + p[3]![1]! - p[0]![1]! - p[1]![1]!) / 2) * eye.height) / 2;
    const area = 4 * Math.abs(mx * ny - my * nx);
    if (area <= 1e-9) {
      degenerate++;
      continue;
    }
    const cx = ((centerX + 1) * eye.width) / 2,
      cy = ((centerY + 1) * eye.height) / 2;
    const bx = Math.abs(mx) + Math.abs(nx),
      by = Math.abs(my) + Math.abs(ny);
    if (cx + bx <= 0 || cx - bx >= eye.width || cy + by <= 0 || cy - by >= eye.height) {
      viewportMiss++;
      continue;
    }
    const clipped =
      cx - bx >= 0 && cx + bx <= eye.width && cy - by >= 0 && cy + by <= eye.height
        ? area
        : clippedQuadArea(
            [
              cx - mx - nx,
              cy - my - ny,
              cx + mx - nx,
              cy + my - ny,
              cx + mx + nx,
              cy + my + ny,
              cx - mx + nx,
              cy - my + ny,
            ],
            eye.width,
            eye.height,
          );
    if (clipped <= 1e-9) {
      viewportMiss++;
      continue;
    }
    const major = Math.hypot(mx, my),
      minor = Math.hypot(nx, ny),
      radius = Math.max(major, minor);
    positiveViewportQuads++;
    sumUnclippedQuadAreaPx += area;
    sumClippedQuadAreaPx += clipped;
    radii.push(radius);
    radiusCounts[radiusBounds.findIndex((bound) => radius <= bound)]!++;
    if (largest.length < 16 || clipped > largest[largest.length - 1]!.clippedQuadAreaPx) {
      largest.push({
        drawIndex: index,
        clippedQuadAreaPx: clipped,
        majorRadiusPx: major,
        minorRadiusPx: minor,
      });
      largest.sort((a, b) => b.clippedQuadAreaPx - a.clippedQuadAreaPx);
      if (largest.length > 16) largest.pop();
    }
  }
  radii.sort((a, b) => a - b);
  const percentile = (p: number) => radii[Math.floor((radii.length - 1) * p)] ?? null;
  return {
    backend,
    viewport: { width: eye.width, height: eye.height },
    inputDrawCount: count,
    vertexRejected,
    depthRejected,
    degenerate,
    viewportMiss,
    positiveViewportQuads,
    sumUnclippedQuadAreaPx,
    sumClippedQuadAreaPx,
    meanQuadOverdraw: sumClippedQuadAreaPx / (eye.width * eye.height),
    radiusPx: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
    radiusHistogram: radiusBounds.map((bound, index) => ({
      maxRadiusPx: Number.isFinite(bound) ? bound : null,
      count: radiusCounts[index],
    })),
    largestClippedQuads: largest,
  };
}

export async function captureVlamProjectedCoverage(
  renderer: WebGPURenderer,
  mesh: UnifiedSplatMesh,
  eyes: ProjectionEye[],
) {
  const { Fn, varying, vec4, instanceIndex, positionGeometry } = await import('three/tsl');
  const count = (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;
  if (count < 1 || !eyes.length) throw new Error('No live unified draw/eyes for coverage capture');
  const width = columns * 2,
    height = Math.ceil(count / columns) * 2;
  const target = new THREE.RenderTarget(width, height, {
    type: THREE.FloatType,
    depthBuffer: false,
  });
  const material = (mesh.material as NodeMaterial).clone();
  if (!material.vertexNode) throw new Error('Unified vertex graph unavailable');
  const originalVertex = material.vertexNode;
  const projected = varying(vec4(0), 'vBenchmarkProjectedQuad');
  material.vertexNode = Fn(() => {
    projected.assign(originalVertex);
    const x = instanceIndex.mod(columns).toFloat().mul(2).add(1).add(positionGeometry.x);
    const y = instanceIndex.div(columns).toUint().toFloat().mul(2).add(1).add(positionGeometry.y);
    return vec4(x.div(width).mul(2).sub(1), y.div(height).mul(-2).add(1), 0, 1);
  })();
  material.fragmentNode = projected;
  material.transparent = false;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  material.toneMapped = false;
  const draw = new THREE.Mesh(mesh.geometry, material);
  draw.frustumCulled = false;
  draw.matrixAutoUpdate = false;
  const scene = new THREE.Scene();
  scene.add(draw);
  // Uniforms remain the eye's real projection size, independently of the diagnostic grid.
  const adapter = mesh as unknown as {
    viewport: { value: THREE.Vector2 };
    focal: { value: THREE.Vector2 };
    antialias: { value: number };
    projectedLowPassVariance: { value: number };
    compensateProjectedLowPass: { value: number };
  };
  const oldViewport = adapter.viewport.value.clone(),
    oldFocal = adapter.focal.value.clone();
  const oldTarget = renderer.getRenderTarget(),
    oldXrEnabled = renderer.xr.enabled;
  const oldClear = renderer.getClearColor(new THREE.Color()),
    oldAlpha = renderer.getClearAlpha();
  const result = [];
  try {
    renderer.xr.enabled = false;
    renderer.setClearColor(0, 0);
    for (const eye of eyes) {
      adapter.viewport.value.set(eye.width, eye.height);
      adapter.focal.value.set(
        (eye.camera.projectionMatrix.elements[0] * eye.width) / 2,
        (eye.camera.projectionMatrix.elements[5] * eye.height) / 2,
      );
      renderer.setRenderTarget(target);
      renderer.clear();
      const diagnosticEye = frozenEye(eye, width, height, renderer);
      renderer.render(scene, diagnosticEye);
      if (
        diagnosticEye.projectionMatrix.elements.some(
          (value, index) => value !== eye.camera.projectionMatrix.elements[index],
        )
      )
        throw new Error('Native eye projection changed during coverage draw');
      const data = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
      if (!(data instanceof Float32Array))
        throw new Error('Float32 projection readback unavailable');
      result.push({
        ...summarizeProjectedQuads(data, count, width, eye, 'WebGPU'),
        pose: eyePose(eye),
      });
    }
  } finally {
    adapter.viewport.value.copy(oldViewport);
    adapter.focal.value.copy(oldFocal);
    renderer.setRenderTarget(oldTarget);
    renderer.setClearColor(oldClear, oldAlpha);
    renderer.xr.enabled = oldXrEnabled;
    material.dispose();
    target.dispose();
  }
  return {
    scope: 'post-sample-gpu-projected-quad-snapshot',
    projectionProtocol: 'preserve-native-eye-matrices-v2',
    capturedAtMs: performance.now(),
    collectedAfterFpsSample: true,
    continuousAreaOnly: true,
    excludesFragmentFalloffAndAlphaDiscard: true,
    eyes: result,
    filter: {
      antialias: adapter.antialias.value,
      projectedLowPassVariance: adapter.projectedLowPassVariance.value,
      compensateProjectedLowPass: adapter.compensateProjectedLowPass.value,
    },
  };
}

export async function captureSparkProjectedCoverage(
  renderer: THREE.WebGLRenderer,
  spark: SparkRenderer,
  eyes: ProjectionEye[],
) {
  const oldAutoUpdate = spark.autoUpdate;
  const oldSortDirty = spark.sortDirty;
  spark.autoUpdate = false;
  if (spark.updateTimeoutId !== -1) {
    clearTimeout(spark.updateTimeoutId);
    spark.updateTimeoutId = -1;
  }
  if (spark.sortTimeoutId !== -1) {
    clearTimeout(spark.sortTimeoutId);
    spark.sortTimeoutId = -1;
  }
  spark.sortDirty = false;
  try {
    const deadline = performance.now() + 10000;
    while (spark.sorting) {
      if (performance.now() > deadline) throw new Error('Spark sort did not settle for coverage');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return await captureSettledSparkProjectedCoverage(renderer, spark, eyes);
  } finally {
    spark.autoUpdate = oldAutoUpdate;
    spark.sortDirty ||= oldSortDirty;
  }
}

async function captureSettledSparkProjectedCoverage(
  renderer: THREE.WebGLRenderer,
  spark: SparkRenderer,
  eyes: ProjectionEye[],
) {
  const count = spark.activeSplats;
  if (count < 0 || !eyes.length) throw new Error('No live Spark draw/eyes for coverage capture');
  if (count === 0)
    return {
      scope: 'post-sample-gpu-projected-quad-snapshot',
      projectionProtocol: 'preserve-native-eye-matrices-v2',
      capturedAtMs: performance.now(),
      collectedAfterFpsSample: true,
      continuousAreaOnly: true,
      excludesFragmentFalloffAndAlphaDiscard: true,
      eyes: eyes.map((eye) => summarizeProjectedQuads(new Float32Array(), 0, 2, eye, 'WebGL2')),
    };
  const width = columns * 2,
    height = Math.ceil(count / columns) * 2;
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.FloatType,
    depthBuffer: false,
  });
  const original = spark.material;
  const vertex = original.vertexShader;
  const lastBrace = vertex.lastIndexOf('}');
  if (!vertex.includes('void main()') || lastBrace < 0)
    throw new Error('Spark projection shader unavailable');
  const diagnosticVertex =
    vertex
      .replace('void main()', 'out vec4 vBenchmarkProjectedQuad;\nvoid main()')
      .slice(
        0,
        vertex
          .replace('void main()', 'out vec4 vBenchmarkProjectedQuad;\nvoid main()')
          .lastIndexOf('}'),
      ) +
    `
    vBenchmarkProjectedQuad = vec4(gl_Position.xyz / gl_Position.w, 1.0);
    int column = gl_InstanceID % ${columns};
    int row = gl_InstanceID / ${columns};
    vec2 grid = vec2(float(column * 2 + 1), float(row * 2 + 1)) + position.xy;
    gl_Position = vec4(grid / vec2(${width}.0, ${height}.0) * 2.0 - 1.0, 0.0, 1.0);
}`;
  const material = original.clone();
  material.vertexShader = diagnosticVertex;
  material.fragmentShader =
    'precision highp float;\nin vec4 vBenchmarkProjectedQuad;\nout vec4 fragColor;\nvoid main() { fragColor = vBenchmarkProjectedQuad; }';
  material.uniforms = spark.uniforms;
  material.transparent = false;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  material.toneMapped = false;
  // Spark constructs SplatGeometry, an InstancedBufferGeometry, despite the broader declaration.
  const geometry = spark.geometry.clone() as THREE.InstancedBufferGeometry;
  geometry.instanceCount = count;
  const draw = new THREE.Mesh(geometry, material);
  draw.frustumCulled = false;
  draw.matrixAutoUpdate = false;
  const scene = new THREE.Scene();
  scene.add(draw);
  const oldTarget = renderer.getRenderTarget(),
    oldXrEnabled = renderer.xr.enabled;
  const oldClear = renderer.getClearColor(new THREE.Color()),
    oldAlpha = renderer.getClearAlpha();
  const result = [];
  const signature = () =>
    `${spark.activeSplats}/${spark.display.version}/${spark.display.mappingVersion}/${spark.orderingTexture?.uuid}`;
  try {
    renderer.setClearColor(0, 0);
    const serial = signature();
    for (const eye of eyes) {
      renderer.xr.enabled = oldXrEnabled;
      renderer.setRenderTarget(oldTarget);
      spark.onBeforeRender(renderer, scene, eye.camera);
      spark.uniforms.renderSize.value.set(eye.width, eye.height);
      renderer.xr.enabled = false;
      renderer.setRenderTarget(target);
      renderer.clear();
      const diagnosticEye = frozenEye(eye, width, height, renderer);
      renderer.render(scene, diagnosticEye);
      if (
        diagnosticEye.projectionMatrix.elements.some(
          (value, index) => value !== eye.camera.projectionMatrix.elements[index],
        )
      )
        throw new Error('Native eye projection changed during coverage draw');
      const data = new Float32Array(width * height * 4);
      await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height, data);
      if (signature() !== serial)
        throw new Error('Spark publication changed during GPU coverage capture');
      result.push({
        ...summarizeProjectedQuads(data, count, width, eye, 'WebGL2'),
        pose: eyePose(eye),
      });
    }
  } finally {
    renderer.setRenderTarget(oldTarget);
    renderer.setClearColor(oldClear, oldAlpha);
    renderer.xr.enabled = oldXrEnabled;
    material.dispose();
    geometry.dispose();
    target.dispose();
  }
  return {
    scope: 'post-sample-gpu-projected-quad-snapshot',
    projectionProtocol: 'preserve-native-eye-matrices-v2',
    capturedAtMs: performance.now(),
    collectedAfterFpsSample: true,
    continuousAreaOnly: true,
    excludesFragmentFalloffAndAlphaDiscard: true,
    eyes: result,
    filter: {
      preBlurAmount: spark.preBlurAmount,
      blurAmount: spark.blurAmount,
      minAlpha: spark.minAlpha,
      maxStdDev: spark.maxStdDev,
      focalAdjustment: spark.focalAdjustment,
    },
  };
}
