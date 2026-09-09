import { performance } from 'node:perf_hooks';
import * as THREE from 'three/webgpu';
import { selectBrushStrokeInData } from '../dist/selection.js';

const counts = process.argv.slice(2).map(Number);
const sizes = counts.length > 0 ? counts : [100_000, 1_000_000];
const runs = 5;
const stroke = {
  paths: [
    [
      { point: new THREE.Vector3(-2, 0, 0), radius: 0.15 },
      { point: new THREE.Vector3(2, 0, 0), radius: 0.15 },
    ],
  ],
};

function fixture(count) {
  const side = Math.ceil(Math.sqrt(count));
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const covariances = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (i % side) * (10 / side) - 5;
    positions[i * 3 + 1] = Math.floor(i / side) * (10 / side) - 5;
    covariances[i * 6] = 0.0001;
    covariances[i * 6 + 3] = 0.0001;
    covariances[i * 6 + 5] = 0.0001;
  }
  return { count, positions, colors, covariances };
}

function retainedEditHeapBytes(indices) {
  if (globalThis.gc === undefined) return null;
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  const edits = new Map();
  for (const global of indices) {
    const file = Math.floor(global / 65_536);
    const local = global - file * 65_536;
    const chunk = edits.get(file) ?? new Map();
    chunk.set(local, 255);
    edits.set(file, chunk);
  }
  globalThis.gc();
  return { bytes: Math.max(0, process.memoryUsage().heapUsed - before), edits };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const results = [];
for (const count of sizes) {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`Invalid splat count: ${count}`);
  const data = fixture(count);
  selectBrushStrokeInData(data, stroke, { depth: 'through', footprint: 'center' });
  const samples = [];
  let selected = new Uint32Array(0);
  for (let run = 0; run < runs; run++) {
    const startedAt = performance.now();
    selected = selectBrushStrokeInData(data, stroke, { depth: 'through', footprint: 'center' });
    samples.push(performance.now() - startedAt);
  }
  const retainedEdits = retainedEditHeapBytes(selected);
  results.push({
    splats: count,
    selected: selected.length,
    medianMs: Number(median(samples).toFixed(2)),
    samplesMs: samples.map((sample) => Number(sample.toFixed(2))),
    sourceBytes: data.positions.byteLength + data.colors.byteLength + data.covariances.byteLength,
    transientHitBytes: count * Uint32Array.BYTES_PER_ELEMENT,
    retainedResultBytes: selected.byteLength,
    retainedEditHeapBytes: retainedEdits?.bytes ?? null,
    pageTableIdentityBytesAtSameCapacity: count * Uint32Array.BYTES_PER_ELEMENT,
  });
}

console.log(JSON.stringify({ node: process.version, runs, results }, null, 2));
