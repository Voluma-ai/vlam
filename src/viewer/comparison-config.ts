import { PerspectiveCamera, Vector3 } from 'three';

/** Parameters shared by the two standalone comparison pages. */
export interface ComparisonConfig {
  engine: 'spark' | 'vlam';
  scene: 'Langenthal-Manola4A' | 'goose';
  preset: 'defaults' | 'matched';
  mode: 'stationary' | 'orbit';
  /** VLAM only: `webgpu` (default) or forced `webgl`. Spark is always WebGL2. */
  backend: 'webgpu' | 'webgl';
  width: number;
  height: number;
  warmup: number;
  seconds: number;
  sh: 0 | undefined;
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
    preset: ['defaults', 'matched'],
    mode: ['stationary', 'orbit'],
    scene: ['Langenthal-Manola4A', 'goose'],
    sh: ['0'],
    gpuTimestamps: ['0', '1'],
    backend: ['webgpu', 'webgl'],
  })) {
    if (params.has(key) && !allowed.includes(params.get(key)!)) throw new Error(`Invalid ${key}.`);
  }
  const engine = path.includes('spark-benchmark') ? 'spark' : 'vlam';
  // Spark's comparison page is WebGL2-only; rejecting webgpu avoids a silent no-op.
  if (engine === 'spark' && params.get('backend') === 'webgpu')
    throw new Error('Spark comparison is WebGL2-only; omit backend or use backend=webgl.');
  const backend =
    engine === 'spark' || params.get('backend') === 'webgl' ? 'webgl' : 'webgpu';
  return {
    engine,
    scene: params.get('scene') === 'goose' ? 'goose' : 'Langenthal-Manola4A',
    preset: params.get('preset') === 'matched' ? 'matched' : 'defaults',
    mode: params.get('mode') === 'orbit' ? 'orbit' : 'stationary',
    backend,
    width: Math.max(1, Math.floor(positive('width', 1280, 4096))),
    height: Math.max(1, Math.floor(positive('height', 720, 4096))),
    warmup: positive('warmup', 5, 120),
    seconds: positive('seconds', 15, 600),
    sh: params.get('sh') === '0' ? 0 : undefined,
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
  orbit: boolean,
): void {
  const target = new Vector3(...pose.target);
  const offset = new Vector3(...pose.position).sub(target);
  if (orbit) offset.applyAxisAngle(new Vector3(0, 1, 0), elapsedMs * 0.00012);
  camera.position.copy(target).add(offset);
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

/** Alternating renderer order for three baselines and separate one-factor probes. */
export function comparisonSuite(): URLSearchParams[] {
  const runs: URLSearchParams[] = [];
  for (let repeat = 1; repeat <= 3; repeat++) {
    for (const preset of ['defaults', 'matched']) {
      for (const mode of ['stationary', 'orbit']) {
        for (const engine of repeat % 2 ? ['spark', 'vlam'] : ['vlam', 'spark'])
          runs.push(
            new URLSearchParams({
              engine,
              preset,
              mode,
              repeat: String(repeat),
              probe: 'baseline',
            }),
          );
      }
    }
  }
  for (const probe of ['half-resolution', 'sh0']) {
    for (const mode of ['stationary', 'orbit']) {
      for (const engine of ['spark', 'vlam']) {
        const run = new URLSearchParams({ engine, preset: 'matched', mode, repeat: '1', probe });
        if (probe === 'sh0') run.set('sh', '0');
        else {
          run.set('width', '640');
          run.set('height', '360');
        }
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
