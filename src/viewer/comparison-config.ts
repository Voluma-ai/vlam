import { PerspectiveCamera, Vector3 } from 'three';

/** Cached captures the standalone comparison pages can load. */
export const COMPARISON_SCENES = ['Tempel', 'goose', 'hotel'] as const;
export type ComparisonScene = (typeof COMPARISON_SCENES)[number];

/** How the comparison adapters open a cached asset URL. */
export function comparisonAssetKind(url: string): 'lcc2' | 'rad' | 'file' {
  if (/\.lcc2(?:$|\?)/i.test(url)) return 'lcc2';
  if (/\.rad(?:$|\?)/i.test(url)) return 'rad';
  return 'file';
}

/** Parameters shared by the two standalone comparison pages. */
export interface ComparisonConfig {
  engine: 'spark' | 'vlam';
  scene: ComparisonScene;
  preset: 'supplied' | 'proposed' | 'controlled' | 'reference' | 'defaults' | 'matched';
  mode: 'stationary' | 'orbit' | 'rotate' | 'translate' | 'settle';
  shEvaluation: 'auto' | 'vertex' | 'compute';
  projectionStrategy: 'vertex' | 'compute';
  visibilityPose: 'interior' | 'overview' | undefined;
  sortMetric: 'depth' | 'radial' | undefined;
  sortStrategy: 'counting' | 'radix' | 'exact' | 'worker' | undefined;
  /** VLAM-only override; undefined keeps the library's adaptive cadence. */
  sortIntervalMs: number | undefined;
  maxStdDev: number | undefined;
  /** VLAM only: `webgpu` (default) or forced `webgl`. Spark is always WebGL2. */
  backend: 'webgpu' | 'webgl';
  width: number;
  height: number;
  warmup: number;
  seconds: number;
  sh: 0 | 1 | 2 | 3 | undefined;
  msaa: boolean;
  timestamps: boolean;
  position?: [number, number, number];
  target?: [number, number, number];
  label: string;
}

/** Reject malformed camera/config URLs instead of silently changing a comparison. */
export function comparisonConfig(path: string, params: URLSearchParams): ComparisonConfig {
  const positive = (key: string, fallback: number, max: number): number => {
    if (!params.has(key)) return fallback;
    const value = Number(params.get(key));
    if (!Number.isFinite(value) || value <= 0 || value > max)
      throw new Error(`Invalid ${key}: expected a positive number up to ${max}.`);
    return value;
  };
  const nonNegative = (key: string, max: number): number | undefined => {
    if (!params.has(key)) return undefined;
    const value = Number(params.get(key));
    if (!Number.isFinite(value) || value < 0 || value > max)
      throw new Error(`Invalid ${key}: expected a non-negative number up to ${max}.`);
    return value;
  };
  const vector = (key: string): [number, number, number] | undefined => {
    const raw = params.get(key);
    if (raw === null) return undefined;
    if (raw.split(',').some((value) => value.trim() === ''))
      throw new Error(`${key} contains an empty coordinate.`);
    const values = raw.split(',').map(Number);
    if (values.length !== 3 || values.some((value) => !Number.isFinite(value)))
      throw new Error(`${key} must be three comma-separated finite numbers.`);
    return values as [number, number, number];
  };
  const position = vector('position');
  const target = vector('target');
  if (Boolean(position) !== Boolean(target)) throw new Error('Supply both position and target.');
  if (position && target && position.every((value, axis) => value === target[axis]))
    throw new Error('Camera position must differ from target.');
  for (const [key, allowed] of Object.entries({
    preset: ['supplied', 'proposed', 'controlled', 'reference', 'defaults', 'matched'],
    scene: [...COMPARISON_SCENES],
    sh: ['0', '1', '2', '3'],
    gpuTimestamps: ['0', '1'],
    backend: ['webgpu', 'webgl'],
    mode: ['stationary', 'orbit', 'rotate', 'translate', 'settle'],
    shEvaluation: ['auto', 'vertex', 'compute'],
    projectionStrategy: ['vertex', 'compute'],
    visibilityPose: ['interior', 'overview'],
    sortMetric: ['depth', 'radial'],
    sortStrategy: ['counting', 'radix', 'exact', 'worker'],
    msaa: ['0', '1'],
  })) {
    if (params.has(key) && !(allowed as readonly string[]).includes(params.get(key)!))
      throw new Error(`Invalid ${key}.`);
  }
  const engine = path.includes('spark-benchmark') ? 'spark' : 'vlam';
  // Spark's comparison page is WebGL2-only; rejecting webgpu avoids a silent no-op.
  if (engine === 'spark' && params.get('backend') === 'webgpu')
    throw new Error('Spark comparison is WebGL2-only; omit backend or use backend=webgl.');
  const backend = engine === 'spark' || params.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
  const preset = (params.get('preset') ?? 'proposed') as ComparisonConfig['preset'];
  return {
    engine,
    scene: (params.get('scene') ?? 'Tempel') as ComparisonScene,
    preset,
    mode: (params.get('mode') ?? 'stationary') as ComparisonConfig['mode'],
    shEvaluation: (params.get('shEvaluation') ?? 'auto') as ComparisonConfig['shEvaluation'],
    projectionStrategy: (params.get('projectionStrategy') ??
      'vertex') as ComparisonConfig['projectionStrategy'],
    visibilityPose: params.get('visibilityPose') as ComparisonConfig['visibilityPose'],
    sortMetric: params.get('sortMetric') as ComparisonConfig['sortMetric'],
    sortStrategy: params.get('sortStrategy') as ComparisonConfig['sortStrategy'],
    sortIntervalMs: nonNegative('sortIntervalMs', 60_000),
    maxStdDev: params.has('maxStdDev') ? positive('maxStdDev', 3, 8) : undefined,
    backend,
    width: Math.max(1, Math.floor(positive('width', 1280, 4096))),
    height: Math.max(1, Math.floor(positive('height', 720, 4096))),
    warmup: positive('warmup', 5, 120),
    seconds: positive('seconds', 30, 600),
    sh: params.has('sh') ? (Number(params.get('sh')) as 0 | 1 | 2 | 3) : undefined,
    msaa: params.has('msaa') ? params.get('msaa') === '1' : preset === 'supplied',
    timestamps: params.get('gpuTimestamps') !== '0',
    position,
    target,
    label: params.get('label') ?? '',
  };
}

/** Canonical pose stored with the cached source, before either decoder runs. */
export interface ComparisonPose {
  position: [number, number, number];
  target: [number, number, number];
}

/** Apply an identical, elapsed-time orbit independent of renderer frame rate. */
export function applyComparisonCamera(
  camera: PerspectiveCamera,
  pose: ComparisonPose,
  elapsedMs: number,
  motion: boolean | ComparisonConfig['mode'],
): void {
  const target = new Vector3(...pose.target);
  const offset = new Vector3(...pose.position).sub(target);
  const mode = typeof motion === 'boolean' ? (motion ? 'orbit' : 'stationary') : motion;
  const time = mode === 'settle' ? Math.min(elapsedMs, 5000) : elapsedMs;
  if (mode === 'orbit' || mode === 'settle')
    offset.applyAxisAngle(new Vector3(0, 1, 0), time * 0.00012);
  camera.position.copy(target).add(offset);
  if (mode === 'rotate') {
    const direction = target
      .clone()
      .sub(camera.position)
      .applyAxisAngle(new Vector3(0, 1, 0), time * 0.00012);
    target.copy(camera.position).add(direction);
  } else if (mode === 'translate') {
    const shift = Math.sin(time * 0.00012) * offset.length() * 0.25;
    camera.position.x += shift;
    target.x += shift;
  }
  camera.lookAt(target);
  camera.updateMatrixWorld();
}

/** Retain explicit poses when sharing a run with the other renderer. */
export function comparisonUrl(
  engine: ComparisonConfig['engine'],
  params: URLSearchParams,
  pose: ComparisonPose,
): string {
  const query = new URLSearchParams(params);
  query.set('position', pose.position.join(','));
  query.set('target', pose.target.join(','));
  return `/${engine}-benchmark.html?${query}`;
}

/** Compact default, or the historical 32-run matrix. */
export type ComparisonSuiteDensity = 'compact' | 'full';

export interface ComparisonSuiteOptions {
  /** `undefined` means both proposed and controlled when density is `full`. */
  preset?: 'proposed' | 'controlled';
  density?: ComparisonSuiteDensity;
  /** Compact default is Tempel then hotel so one click covers both captures. */
  scenes?: readonly ComparisonScene[];
}

/** Preserve the requested suite scope independently of each run's scene. */
export function comparisonSuiteOptions(params: URLSearchParams): ComparisonSuiteOptions {
  const preset = params.get('suitePreset');
  if (preset !== null && preset !== 'proposed' && preset !== 'controlled')
    throw new Error('Invalid suitePreset.');
  const density = params.get('suiteDensity') ?? 'compact';
  if (density !== 'compact' && density !== 'full') throw new Error('Invalid suiteDensity.');
  const scene = params.get('suiteScene') ?? params.get('scene');
  if (scene !== null && scene !== 'all' && !COMPARISON_SCENES.includes(scene as ComparisonScene))
    throw new Error('Invalid suite scene.');
  return {
    preset: preset ?? undefined,
    density,
    ...(scene === null || scene === 'all' ? {} : { scenes: [scene as ComparisonScene] }),
  };
}

/** Build a navigation URL without changing the matrix on the next page load. */
export function comparisonSuiteUrl(params: URLSearchParams, step: number, suiteId: string): string {
  const options = comparisonSuiteOptions(params);
  const runs = comparisonSuite(options);
  const run = runs[step];
  if (!Number.isInteger(step) || !run) throw new Error('Invalid suite step.');
  const query = new URLSearchParams(params);
  for (const key of [
    'engine',
    'preset',
    'mode',
    'repeat',
    'probe',
    'sh',
    'width',
    'height',
    'gpuTimestamps',
    'scene',
    'seconds',
  ])
    query.delete(key);
  run.forEach((value, key) => query.set(key, value));
  query.set('suiteScene', options.scenes?.[0] ?? 'all');
  query.set('suite', '1');
  query.set('step', String(step));
  query.set('suiteId', params.get('suiteId') ?? suiteId);
  return `/${run.get('engine')}-benchmark.html?${query}`;
}

/** Sequential comparison matrix. Compact is the default; `density: 'full'` is the old 32-run protocol. */
export function comparisonSuite(
  presetOrOptions?: 'proposed' | 'controlled' | ComparisonSuiteOptions,
): URLSearchParams[] {
  const options: ComparisonSuiteOptions =
    typeof presetOrOptions === 'object' && presetOrOptions !== null
      ? presetOrOptions
      : {
          preset: presetOrOptions,
          // A bare preset argument is the historical 16-run half-matrix.
          density: presetOrOptions ? 'full' : 'compact',
        };
  const density = options.density ?? 'compact';
  const presets = options.preset
    ? [options.preset]
    : density === 'compact'
      ? ['proposed']
      : ['proposed', 'controlled'];
  const scenes =
    options.scenes ??
    (density === 'compact' ? (['Tempel', 'hotel'] as const) : (['Tempel'] as const));
  const repeats = density === 'full' ? 3 : 1;
  const seconds = density === 'compact' ? '15' : undefined;
  const runs: URLSearchParams[] = [];
  const push = (
    scene: ComparisonScene,
    preset: string,
    mode: string,
    engine: string,
    probe: 'primary' | 'qhd',
    repeat: number,
  ): void => {
    const width = probe === 'qhd' ? '2560' : '1280';
    const height = probe === 'qhd' ? '1440' : '720';
    runs.push(
      new URLSearchParams({
        engine,
        preset,
        mode,
        scene,
        width,
        height,
        repeat: String(repeat),
        probe,
        gpuTimestamps: '0',
        ...(seconds === undefined ? {} : { seconds }),
      }),
    );
  };
  for (const scene of scenes) {
    const includeQhd = density === 'full' || scene === 'Tempel';
    for (let repeat = 1; repeat <= repeats; repeat++) {
      for (const preset of presets) {
        for (const mode of ['stationary', 'orbit']) {
          const engines =
            density === 'full' && repeat % 2 === 0 ? ['vlam', 'spark'] : ['spark', 'vlam'];
          for (const engine of engines) push(scene, preset, mode, engine, 'primary', repeat);
        }
      }
    }
    if (!includeQhd) continue;
    for (const preset of presets) {
      for (const mode of ['stationary', 'orbit']) {
        for (const engine of ['spark', 'vlam']) push(scene, preset, mode, engine, 'qhd', 1);
      }
    }
  }
  return runs;
}

/** Percentiles of observed samples, with missing data distinct from zero. */
export function summarize(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? null;
  return {
    sampleCount: values.length,
    meanMs: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}
