/**
 * Clip worker of `.csgs` playback: decodes a clip's sections once, keeps
 * them, and evaluates frames on request, so neither the rANS decode (several
 * hundred ms per 100k-splat section) nor the per-frame curve evaluation
 * (~20 ms per 60k splats) runs on the page's main thread.
 *
 * Sections stay here; the page only learns their counts and frame spans.
 * A frame reply transfers its buffers, and the page hands them back with a
 * later request, so steady playback allocates nothing.
 */
import {
  CsgsDecoder,
  createCsgsFrameBuffers,
  csgsShExtent,
  evaluateCsgsFrame,
  parseCsgsHeader,
  prepareCsgsSection,
  type CsgsFrameBuffers,
  type CsgsPlaybackSection,
} from '../formats/csgs';
import {
  csgsGpuHalfSafe,
  csgsGpuTexels,
  csgsSectionBounds,
  packCsgsGpuSection,
} from '../formats/csgs/csgs-gpu-layout';
import type { CsgsWorkerReply, CsgsWorkerRequest } from './csgs-worker-protocol';

const scope = self as unknown as Worker;
let sections: CsgsPlaybackSection[] = [];

function decode(buffers: readonly ArrayBuffer[]): void {
  // One packed-SH range for the whole stream, so the pool never requantizes
  // a later section against the first one's range.
  let shExtent = 0;
  for (const bytes of buffers) {
    shExtent = Math.max(shExtent, csgsShExtent(parseCsgsHeader(new Uint8Array(bytes)).params));
  }
  const decoder = new CsgsDecoder();
  sections = [];
  buffers.forEach((bytes, index) => {
    const started = performance.now();
    const decoded = decoder.decode(new Uint8Array(bytes));
    const section = prepareCsgsSection(decoded, decoder.params!, shExtent);
    sections.push(section);
    const reply: CsgsWorkerReply = {
      type: 'section',
      index,
      info: {
        g0: section.g0,
        nframes: section.nframes,
        count: section.count,
        texels: csgsGpuTexels(section),
        gpuEligible: csgsGpuHalfSafe(section),
        bounds: csgsSectionBounds(section),
      },
      decodeMs: performance.now() - started,
    };
    scope.postMessage(reply);
  });
  const reply: CsgsWorkerReply = {
    type: 'decoded',
    shRange: sections[0]?.shPacked.range ?? { min: [0, 0, 0], max: [0, 0, 0] },
  };
  scope.postMessage(reply);
}

function evaluate(
  id: number,
  frame: number,
  sh: boolean,
  recycled: CsgsFrameBuffers | undefined,
  compact: boolean,
): void {
  const index = sections.findIndex((s) => frame >= s.g0 && frame < s.g0 + s.nframes);
  const section = sections[index];
  if (!section) throw new Error(`CSGS: no section holds frame ${frame}.`);
  const maxCount = Math.max(...sections.map((s) => s.count));
  // Handed-back buffers fit any section; fresh ones are sized for the largest.
  const buffers =
    recycled && recycled.positions.length >= maxCount * 3
      ? recycled
      : createCsgsFrameBuffers(maxCount);
  const started = performance.now();
  const data = evaluateCsgsFrame(section, frame, buffers, { allSlots: !compact });
  // With every slot written the result is the section's own packed SH, which
  // must stay here; copy it into the transferable buffer when asked.
  if (sh && data.shPacked && data.shPacked.packed.buffer !== buffers.shPacked.buffer) {
    buffers.shPacked.set(data.shPacked.packed);
  }
  let alive = 0;
  for (let i = 0; i < section.count; i++) {
    if (frame >= section.birthFrame[i]! && frame < section.deathFrame[i]!) alive++;
  }
  const reply: CsgsWorkerReply = {
    type: 'frame',
    id,
    frame,
    section: index,
    count: data.count,
    alive,
    sh,
    buffers,
    evalMs: performance.now() - started,
  };
  scope.postMessage(reply, [
    buffers.positions.buffer,
    buffers.colors.buffer,
    buffers.covariances.buffer,
    buffers.shPacked.buffer,
  ]);
}

function packGpu(id: number, index: number): void {
  const section = sections[index];
  if (!section) throw new Error(`CSGS: no section ${index}.`);
  const packed = packCsgsGpuSection(section);
  const reply: CsgsWorkerReply = { type: 'gpuSection', id, section: packed };
  scope.postMessage(reply, [
    packed.knots.buffer,
    packed.base.buffer,
    packed.k.buffer,
    packed.life.buffer,
    packed.pool.positions.buffer,
    packed.pool.colors.buffer,
    packed.pool.covariances.buffer,
    packed.pool.shPacked!.packed.buffer,
  ]);
}

scope.onmessage = (event: MessageEvent<CsgsWorkerRequest>): void => {
  const request = event.data;
  try {
    if (request.type === 'decode') decode(request.sections);
    else if (request.type === 'gpuSection') packGpu(request.id, request.index);
    else evaluate(request.id, request.frame, request.sh, request.buffers, request.compact === true);
  } catch (error) {
    const reply: CsgsWorkerReply = {
      type: 'error',
      ...(request.type !== 'decode' ? { id: request.id } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(reply);
  }
};
