import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const execFileAsync = promisify(execFile);

const DEFAULT_TIERS = ['auto', 'high', 'balanced', 'performance'];
const DEFAULT_DPRS = [1, 0.8];
const DEFAULT_MOTIONS = ['stationary', 'fpv'];
const DEFAULT_RELIGHTING = ['off', 'on'];

function usage() {
  console.error(
    'Usage: node scripts/pixel-8a-tempel-benchmark.mjs --url <exact-viewer-url> ' +
      '[--cdp http://127.0.0.1:9222] [--serial <adb-serial>] [--out <directory>] ' +
      '[--tiers auto,balanced,performance] [--dprs 1,0.8] ' +
      '[--shadow-maps near,mid,outer,far] ' +
      '[--factor-scale 0.5] [--seconds 60] [--warmup 10]',
  );
  process.exit(2);
}

function parseQuad(raw, integer) {
  const values = raw.split(',').map((value) => Number(value.trim()));
  if (
    values.length !== 4 ||
    values.some(
      (value) => !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value)),
    )
  ) {
    usage();
  }
  return values;
}

function parseArgs(argv) {
  const options = {
    url: null,
    cdp: 'http://127.0.0.1:9222',
    serial: undefined,
    out: `.tmp/android-pixel-8a/${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}`,
    tiers: DEFAULT_TIERS,
    dprs: DEFAULT_DPRS,
    seconds: 60,
    warmup: 10,
    settleMs: 3000,
    shadowMaps: undefined,
    factorScale: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) usage();
      return value;
    };
    if (arg === '--url') options.url = next();
    else if (arg === '--cdp') options.cdp = next();
    else if (arg === '--serial') options.serial = next();
    else if (arg === '--out') options.out = next();
    else if (arg === '--tiers') options.tiers = next().split(',').filter(Boolean);
    else if (arg === '--dprs') options.dprs = next().split(',').map(Number);
    else if (arg === '--seconds') options.seconds = Number(next());
    else if (arg === '--warmup') options.warmup = Number(next());
    else if (arg === '--settle-ms') options.settleMs = Number(next());
    else if (arg === '--shadow-maps') options.shadowMaps = parseQuad(next(), true);
    else if (arg === '--factor-scale') options.factorScale = Number(next());
    else usage();
  }
  if (!options.url || !Number.isFinite(options.seconds) || options.seconds <= 0) usage();
  if (!Number.isFinite(options.warmup) || options.warmup < 0) usage();
  if (
    options.factorScale !== undefined &&
    (!Number.isFinite(options.factorScale) || options.factorScale <= 0)
  ) {
    usage();
  }
  if (
    options.tiers.some((tier) => !['auto', 'high', 'balanced', 'performance'].includes(tier)) ||
    options.dprs.some((dpr) => !Number.isFinite(dpr) || dpr <= 0)
  ) {
    usage();
  }
  return options;
}

function runLabel({ relighting, motion, dpr, tier, repeat }) {
  return `${relighting}-${motion}-dpr${String(dpr).replace('.', '')}-${tier}-run${repeat}`;
}

function buildRunUrl(
  exactUrl,
  { relighting, motion, dpr, tier, seconds, warmup, shadowMaps, factorScale },
) {
  const url = new URL(exactUrl);
  if (relighting === 'on') url.searchParams.set('effects', 'relight');
  else url.searchParams.delete('effects');
  if (tier === 'auto') url.searchParams.delete('relightTier');
  else url.searchParams.set('relightTier', tier);
  if (shadowMaps) url.searchParams.set('relightShadowMaps', shadowMaps.join(','));
  if (factorScale !== undefined) url.searchParams.set('relightFactorScale', String(factorScale));
  url.searchParams.set('pixelRatio', String(dpr));
  url.searchParams.set('adaptiveDpr', '0');
  url.searchParams.set('refreshHz', '60');
  url.searchParams.set('gpuTimestamps', '1');
  url.searchParams.set('hud', '1');
  url.searchParams.set('benchmarkSeconds', String(seconds));
  url.searchParams.set('warmupSeconds', String(warmup));
  url.searchParams.set('benchmarkStart', 'manual');
  url.searchParams.set('benchmarkMotion', motion);
  if (motion === 'fpv') url.searchParams.set('fpv', '1');
  else url.searchParams.delete('fpv');
  return url.toString();
}

async function adb(serial, args) {
  const command = serial ? ['-s', serial, ...args] : args;
  try {
    const result = await execFileAsync('adb', command, { maxBuffer: 2 * 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

function batteryTemperature(output) {
  const match = output?.match(/temperature:\s*(\d+)/i);
  return match ? Number(match[1]) / 10 : null;
}

async function sampleDevice(serial) {
  const [battery, thermal, gpu] = await Promise.all([
    adb(serial, ['shell', 'dumpsys', 'battery']),
    adb(serial, ['shell', 'dumpsys', 'thermalservice']),
    adb(serial, [
      'shell',
      'sh',
      '-c',
      'for f in /sys/class/devfreq/*/cur_freq /sys/class/kgsl/kgsl-3d0/gpuclk; do ' +
        'test -r "$f" && echo "$f=$(cat "$f")"; done',
    ]),
  ]);
  return {
    at: new Date().toISOString(),
    batteryTemperatureC: batteryTemperature(battery),
    battery: battery ?? null,
    thermalService: thermal ?? null,
    gpuFrequency: gpu ?? null,
  };
}

async function settle(page, settleMs) {
  await page.waitForFunction(
    () => {
      const viewer = window.__voluma;
      const mesh = viewer?.splats;
      return Boolean(
        mesh &&
          mesh.activeSplatCount > 0 &&
          (!('isStreaming' in mesh) || mesh.isStreaming === false),
      );
    },
    undefined,
    { timeout: 10 * 60 * 1000 },
  );
  await page.waitForTimeout(settleMs);
}

async function readBenchmark(page, timeoutMs) {
  const handle = await page.waitForFunction(
    () => {
      const element = document.querySelector('#benchmark-json');
      const text = element?.textContent ?? '';
      if (!text || text === 'resolving') return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    undefined,
    { timeout: timeoutMs },
  );
  const value = await handle.jsonValue();
  await handle.dispose();
  return value;
}

async function runOne(page, options, configuration, outputDirectory) {
  const label = runLabel(configuration);
  const url = buildRunUrl(options.url, {
    ...configuration,
    seconds: options.seconds,
    warmup: options.warmup,
    shadowMaps: options.shadowMaps,
    factorScale: options.factorScale,
  });
  console.log(`Loading ${label}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await settle(page, options.settleMs);
  const deviceSamples = [await sampleDevice(options.serial)];
  await page.locator('canvas').focus();
  await page.keyboard.press('b');
  let report;
  const moving = configuration.motion === 'fpv';
  if (moving) await page.keyboard.down('KeyW');
  try {
    const reportPromise = readBenchmark(page, (options.warmup + options.seconds + 30) * 1000);
    let done = false;
    while (!done) {
      const result = await Promise.race([
        reportPromise.then((value) => ({ done: true, value })),
        new Promise((resolve) => setTimeout(() => resolve({ done: false }), 5000)),
      ]);
      if (result.done) {
        report = result.value;
        done = true;
      } else {
        deviceSamples.push(await sampleDevice(options.serial));
      }
    }
  } finally {
    if (moving) await page.keyboard.up('KeyW');
  }
  deviceSamples.push(await sampleDevice(options.serial));

  const screenshotPath = `${outputDirectory}/${label}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: false });
  return {
    label,
    url,
    report,
    relighting: await page.evaluate(() => window.__voluma?.relighting ?? { enabled: false }),
    deviceSamples,
    screenshot: screenshotPath,
  };
}

const options = parseArgs(process.argv.slice(2));
await mkdir(options.out, { recursive: true });
const browser = await chromium.connectOverCDP(options.cdp);
const pages = browser.contexts().flatMap((context) => context.pages());
const page = pages.find((candidate) => !candidate.isClosed()) ?? pages[0];
if (!page) throw new Error('No browser page is available through the supplied CDP endpoint.');

const configurations = [];
for (const relighting of DEFAULT_RELIGHTING) {
  const tiers = relighting === 'on' ? options.tiers : ['auto'];
  for (const tier of tiers) {
    for (const motion of DEFAULT_MOTIONS) {
      for (const dpr of options.dprs) {
        for (let repeat = 1; repeat <= 3; repeat++) {
          configurations.push({ relighting, motion, dpr, tier, repeat });
        }
      }
    }
  }
}

const runs = [];
try {
  for (const configuration of configurations) {
    runs.push(await runOne(page, options, configuration, options.out));
  }
} finally {
  await browser.close();
}

const result = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  exactSuppliedUrl: options.url,
  assumptions: {
    refreshHz: 60,
    adaptiveDpr: false,
    repeats: 3,
    warmupSeconds: options.warmup,
    sampleSeconds: options.seconds,
    relightingOverrides: {
      shadowMaps: options.shadowMaps ?? null,
      factorScale: options.factorScale ?? null,
    },
  },
  runs,
};
await writeFile(`${options.out}/results.json`, JSON.stringify(result, null, 2));
console.log(`Saved ${runs.length} runs to ${options.out}/results.json`);
