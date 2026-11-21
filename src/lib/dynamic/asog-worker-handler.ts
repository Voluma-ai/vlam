/**
 * The `.asog` clip worker's message handling (`asog-decode-worker.ts` binds
 * it to the worker scope): decodes a file once, keeps it, and evaluates
 * frames on request. A factory, so tests can run it in-process.
 */
import { packPaletteSh } from '../core/sh-pack';
import type { SplatPackedShData } from '../core/splat-data';
import {
  asogMotionBounds,
  evaluateAsogFrame,
  writeAsogCanonical,
} from '../formats/asog/asog-motion';
import { parseAsog, type AsogData } from '../formats/asog/parse-asog';
import type { AsogWorkerReply, AsogWorkerRequest } from './asog-worker-protocol';
import type { SplatFrameBuffers } from './splat-clip-playback';

/** Posts a reply, transferring `transfer`. */
export type AsogWorkerPost = (reply: AsogWorkerReply, transfer?: Transferable[]) => void;

/** A handler of {@link AsogWorkerRequest}s that answers through `post`. */
export function createAsogWorkerHandler(
  post: AsogWorkerPost,
): (request: AsogWorkerRequest) => void {
  let data: AsogData | null = null;
  let shPacked: SplatPackedShData | null = null;
  /** Packed SH words per splat (0 without SH). */
  let shWords = 0;
  /** Splat index of each slot of a compact frame. */
  let sources: Uint32Array | null = null;

  async function decode(bytes: ArrayBuffer): Promise<void> {
    const started = performance.now();
    data = await parseAsog(bytes);
    shPacked = data.sh ? packPaletteSh(data.sh, data.count, data.shBands as 1 | 2 | 3) : null;
    shWords = shPacked ? shPacked.packed.length / Math.max(data.count, 1) : 0;
    const { manifest } = data;
    const reply: AsogWorkerReply = {
      type: 'decoded',
      info: {
        count: data.count,
        shBands: shPacked ? data.shBands : 0,
        fps: manifest.timeline.frameRate,
        durationSeconds: manifest.timeline.durationSeconds,
        clipCount: manifest.clips.length,
        clips: data.clips,
        bounds: asogMotionBounds(data),
        sourceFormat: manifest.source?.format ?? null,
        decodeMs: performance.now() - started,
      },
      shRange: shPacked?.range ?? { min: [0, 0, 0], max: [0, 0, 0] },
      audio: data.audio,
    };
    post(reply);
  }

  function createBuffers(count: number): SplatFrameBuffers {
    return {
      positions: new Float32Array(count * 3),
      colors: new Uint8Array(count * 4),
      covariances: new Float32Array(count * 6),
      shPacked: new Uint32Array(Math.max(count * shWords, 1)),
    };
  }

  function transfers(buffers: SplatFrameBuffers): Transferable[] {
    return [
      buffers.positions.buffer,
      buffers.colors.buffer,
      buffers.covariances.buffer,
      buffers.shPacked.buffer,
    ];
  }

  function evaluate(
    id: number,
    frame: number,
    sh: boolean,
    recycled: SplatFrameBuffers | undefined,
    compact: boolean,
  ): void {
    if (!data) throw new Error('ASOG: no decoded clip.');
    const buffers =
      recycled && recycled.positions.length >= data.count * 3
        ? recycled
        : createBuffers(data.count);
    // Fresh playback buffers start in the canonical pose, so every slot holds
    // a real pose of its own splat and invisible splats can keep theirs.
    if (buffers !== recycled && !compact) writeAsogCanonical(data, buffers);
    const started = performance.now();
    const t = frame / data.manifest.timeline.frameRate;
    if (compact) sources ??= new Uint32Array(data.count);
    const { count, alive } = evaluateAsogFrame(
      data,
      t,
      buffers,
      compact ? { compact, sources: sources! } : { keepInvisible: true },
    );
    if (sh && shPacked) {
      if (compact) {
        for (let slot = 0; slot < count; slot++) {
          const i = sources![slot]!;
          buffers.shPacked.set(
            shPacked.packed.subarray(i * shWords, (i + 1) * shWords),
            slot * shWords,
          );
        }
      } else {
        buffers.shPacked.set(shPacked.packed);
      }
    }
    const reply: AsogWorkerReply = {
      type: 'frame',
      id,
      frame,
      count,
      alive,
      sh: sh && shPacked !== null,
      buffers,
      evalMs: performance.now() - started,
    };
    post(reply, transfers(buffers));
  }

  function packGpu(id: number): void {
    if (!data) throw new Error('ASOG: no decoded clip.');
    const pool = createBuffers(data.count);
    writeAsogCanonical(data, pool);
    if (shPacked) pool.shPacked.set(shPacked.packed);
    const motion = data.motion.slice();
    const reply: AsogWorkerReply = {
      type: 'gpu',
      id,
      data: {
        pool: {
          count: data.count,
          positions: pool.positions,
          colors: pool.colors,
          covariances: pool.covariances,
          ...(shPacked ? { shPacked: { ...shPacked, packed: pool.shPacked } } : {}),
        },
        motion,
      },
    };
    post(reply, [...transfers(pool), motion.buffer]);
  }

  return (request: AsogWorkerRequest): void => {
    const report = (error: unknown): void => {
      const reply: AsogWorkerReply = {
        type: 'error',
        ...(request.type !== 'decode' ? { id: request.id } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
      post(reply);
    };
    try {
      if (request.type === 'decode') decode(request.bytes).catch(report);
      else if (request.type === 'gpu') packGpu(request.id);
      else
        evaluate(request.id, request.frame, request.sh, request.buffers, request.compact === true);
    } catch (error) {
      report(error);
    }
  };
}
