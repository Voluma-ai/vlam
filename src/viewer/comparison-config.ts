import { PerspectiveCamera, Vector3 } from 'three';

/** Parameters shared by the two standalone comparison pages. */
export interface ComparisonConfig {
  engine: 'spark' | 'vlam';
  scene: 'Langenthal-Manola4A' | 'goose';
  preset: 'supplied' | 'proposed' | 'controlled' | 'reference' | 'defaults' | 'matched';
  mode: 'stationary' | 'orbit' | 'rotate' | 'translate' | 'settle';
  shEvaluation: 'auto' | 'vertex' | 'compute';
  sortMetric: 'depth' | 'radial' | undefined;
  sortStrategy: 'counting' | 'radix' | 'exact' | 'worker' | undefined;
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
    scene: ['Langenthal-Manola4A', 'goose'],
    sh: ['0', '1', '2', '3'],
    gpuTimestamps: ['0', '1'],
    backend: ['webgpu', 'webgl'],
    mode: ['stationary', 'orbit', 'rotate', 'translate', 'settle'],
    shEvaluation: ['auto', 'vertex', 'compute'],
    sortMetric: ['depth', 'radial'],
    sortStrategy: ['counting', 'radix', 'exact', 'worker'],
    msaa: ['0', '1'],
  })) {
    if (params.has(key) && !allowed.includes(params.get(key)!)) throw new Error(`Invalid ${key}.`);
  }
  const engine = path.includes('spark-benchmark') ? 'spark' : 'vlam';
  // Spark's comparison page is WebGL2-only; rejecting webgpu avoids a silent no-op.
  if (engine === 'spark' && params.get('backend') === 'webgpu')
    throw new Error('Spark comparison is WebGL2-only; omit backend or use backend=webgl.');
  const backend = engine === 'spark' || params.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
  const preset = (params.get('preset') ?? 'proposed') as ComparisonConfig['preset'];
  return {
    engine,
    scene: params.get('scene') === 'goose' ? 'goose' : 'Langenthal-Manola4A',
    preset,
    mode: (params.get('mode') ?? 'stationary') as ComparisonConfig['mode'],
    shEvaluation: (params.get('shEvaluation') ?? 'auto') as ComparisonConfig['shEvaluation'],
    sortMetric: params.get('sortMetric') as ComparisonConfig['sortMetric'],
    sortStrategy: params.get('sortStrategy') as ComparisonConfig['sortStrategy'],
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

/** Five alternating primary repetitions plus separate one-factor probes. */
export function comparisonSuite(onlyPreset?: 'proposed' | 'controlled'): URLSearchParams[] {
  const runs: URLSearchParams[] = [];
  for (let repeat = 1; repeat <= 5; repeat++) {
    for (const preset of onlyPreset ? [onlyPreset] : ['proposed', 'controlled']) {
      for (const mode of ['stationary', 'orbit']) {
        for (const [width, height] of [
          ['1280', '720'],
          ['2560', '1440'],
        ] as const)
          for (const engine of repeat % 2 ? ['spark', 'vlam'] : ['vlam', 'spark'])
            runs.push(
              new URLSearchParams({
                engine,
                preset,
                mode,
                width,
                height,
                repeat: String(repeat),
                probe: 'primary',
                gpuTimestamps: '0',
              }),
            );
      }
    }
  }
  if (onlyPreset) return runs;
  for (const probe of ['reference', 'sh0', 'timestamps']) {
    for (const mode of ['stationary', 'orbit']) {
      for (const engine of ['spark', 'vlam']) {
        const run = new URLSearchParams({
          engine,
          preset: probe === 'reference' ? 'reference' : 'controlled',
          mode,
          repeat: '1',
          probe,
          gpuTimestamps: probe === 'timestamps' ? '1' : '0',
        });
        if (probe === 'sh0') run.set('sh', '0');
        runs.push(run);
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
