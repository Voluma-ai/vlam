import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsogWorkerHandler } from '../dynamic/asog-worker-handler';
import type { AsogWorkerReply, AsogWorkerRequest } from '../dynamic/asog-worker-protocol';
import { evaluateAsogFrame, createAsogFrameBuffers, parseAsog } from '../formats/asog';
import { syntheticAsog } from '../../tools/asog/encode-asog';

/** The clip worker, run in-process on the real handler. */
class InProcessWorker {
  static instances: InProcessWorker[] = [];
  onmessage: ((event: MessageEvent<AsogWorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly requests: AsogWorkerRequest['type'][] = [];
  /** Milliseconds a reply takes, as a real worker's evaluation would. */
  static replyMs = 0;
  private readonly handle = createAsogWorkerHandler((reply) => {
    // Replies arrive asynchronously, as from a real worker.
    const deliver = () => {
      if (!this.terminated) this.onmessage?.({ data: reply } as MessageEvent<AsogWorkerReply>);
    };
    if (InProcessWorker.replyMs > 0) setTimeout(deliver, InProcessWorker.replyMs);
    else queueMicrotask(deliver);
  });
  constructor() {
    InProcessWorker.instances.push(this);
  }
  postMessage(message: AsogWorkerRequest): void {
    this.requests.push(message.type);
    this.handle(message);
  }
  terminate(): void {
    this.terminated = true;
  }
}

vi.mock('../dynamic/asog-decode-worker?worker&inline', () => ({ default: InProcessWorker }));

const { loadAsogClip, loadSplatClip, SplatClipMesh } = await import('../dynamic');

afterEach(() => {
  vi.unstubAllGlobals();
  InProcessWorker.instances = [];
  InProcessWorker.replyMs = 0;
});

function serve(bytes: Uint8Array) {
  const fetch = vi.fn(async () => new Response(bytes.slice()));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/**
 * A response whose body arrives in `size`-byte chunks, one per macrotask,
 * ending at `stopAt`; the last chunk waits for `holdLast`.
 */
function chunked(
  bytes: Uint8Array,
  size: number,
  stopAt = bytes.length,
  holdLast?: Promise<void>,
): Response {
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (holdLast && at + size >= stopAt) await holdLast;
      if (at >= stopAt) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, Math.min(at + size, stopAt)));
      at += size;
    },
  });
  return new Response(body, { headers: { 'content-length': String(bytes.length) } });
}

describe('loadAsogClip', () => {
  it('decodes while the file downloads, the same clip as from whole bytes', async () => {
    const bytes = await syntheticAsog({ count: 2000, duration: 2, fps: 30, coeffs: 8 });
    // The last chunk waits for a decoded stream: decoding starts mid-download.
    let firstStream!: () => void;
    const decodedOne = new Promise<void>((resolve) => (firstStream = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunked(bytes, 8192, bytes.length, decodedOne)),
    );
    const events: string[] = [];
    const clip = await loadAsogClip('https://example.test/ball.asog', {
      onProgress: ({ stage, loaded, total }) => {
        events.push(`${stage} ${loaded}/${total}`);
        if (stage === 'decode') firstStream();
      },
    });
    // Per-stream decode progress, the first before the download is done.
    const firstDecode = events.findIndex((e) => e.startsWith('decode'));
    const lastFetch = events.map((e) => e.startsWith('fetch')).lastIndexOf(true);
    expect(firstDecode).toBeGreaterThan(-1);
    expect(firstDecode).toBeLessThan(lastFetch);
    expect(InProcessWorker.instances[0]!.requests[0]).toBe('chunk');
    expect(InProcessWorker.instances[0]!.requests).toContain('end');

    const whole = await loadAsogClip('https://example.test/ball.asog', {
      bytes: bytes.slice().buffer,
    });
    expect(clip.maxCount).toBe(whole.maxCount);
    expect(clip.bounds.equals(whole.bounds)).toBe(true);
    const [a, b] = await Promise.all([clip.frame(11), whole.frame(11)]);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.shPacked!.packed)).toEqual(Array.from(b.shPacked!.packed));
    clip.dispose();
    whole.dispose();
  });

  it('terminates the worker on an abort or a short body during a streaming load', async () => {
    const bytes = await syntheticAsog({ count: 3000, coeffs: 0 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunked(bytes, 1024)),
    );
    const controller = new AbortController();
    const aborted = loadAsogClip('https://example.test/x.asog', {
      signal: controller.signal,
      onProgress: ({ stage, loaded }) => {
        if (stage === 'fetch' && loaded >= 4096) controller.abort();
      },
    });
    await expect(aborted).rejects.toThrow(/abort/i);
    expect(InProcessWorker.instances[0]!.requests).toContain('chunk');
    expect(InProcessWorker.instances.every((worker) => worker.terminated)).toBe(true);

    InProcessWorker.instances = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunked(bytes, 4096, bytes.length - 100)),
    );
    await expect(loadAsogClip('https://example.test/x.asog')).rejects.toThrow(/truncated/);
    expect(InProcessWorker.instances.every((worker) => worker.terminated)).toBe(true);
  });

  it('loads a clip through loadSplatClip by its extension', async () => {
    const bytes = await syntheticAsog({ count: 3000, duration: 2, fps: 30, coeffs: 8 });
    serve(bytes);
    const progress: string[] = [];
    const clip = await loadSplatClip('https://example.test/clips/ball.asog', {
      onProgress: ({ stage }) => progress.push(stage),
    });
    expect(clip.format).toBe('asog');
    expect(clip.name).toBe('ball');
    expect(clip.fps).toBe(30);
    expect(clip.totalFrames).toBe(60);
    expect(clip.duration).toBe(2);
    expect(clip.maxCount).toBe(3000);
    expect(clip.shBands).toBe(2);
    expect(progress).toContain('decode');
    expect(clip.bounds.isEmpty()).toBe(false);

    // frame(): the visible splats only, the same as a direct evaluation.
    const data = await parseAsog(bytes);
    const reference = createAsogFrameBuffers(data.count);
    const expected = evaluateAsogFrame(data, 17 / 30, reference, { compact: true });
    const frame = await clip.frame(17);
    expect(frame.count).toBe(expected.count);
    expect(Array.from(frame.positions)).toEqual(
      Array.from(reference.positions.subarray(0, expected.count * 3)),
    );
    expect(frame.shPacked?.bands).toBe(2);
    expect(frame.shPacked?.packed.length).toBe(expected.count * 8);
    for (let i = 0; i < frame.count; i++) {
      expect(
        clip.bounds.containsPoint({
          x: frame.positions[i * 3]!,
          y: frame.positions[i * 3 + 1]!,
          z: frame.positions[i * 3 + 2]!,
        } as never),
      ).toBe(true);
    }
    await expect(clip.frame(60)).rejects.toThrow(/outside 0\.\.59/);
    clip.dispose();
    expect(InProcessWorker.instances[0]!.terminated).toBe(true);
    await expect(clip.frame(0)).rejects.toThrow(/disposed/);
  });

  it('names a clip from a file name with a stray % and releases its workers on a failed load', async () => {
    const bytes = await syntheticAsog({ count: 300, coeffs: 0 });
    const clip = await loadAsogClip('https://example.test/50%.asog', {
      bytes: bytes.slice().buffer,
    });
    expect(clip.name).toBe('50%');
    clip.dispose();

    InProcessWorker.instances = [];
    const failing = loadAsogClip('https://example.test/ball.asog', {
      bytes: bytes.slice().buffer,
      onProgress: ({ stage, loaded }) => {
        if (stage === 'decode' && loaded === 1) throw new Error('progress handler failed');
      },
    });
    await expect(failing).rejects.toThrow(/progress handler failed/);
    expect(InProcessWorker.instances.length).toBeGreaterThan(0);
    expect(InProcessWorker.instances.every((worker) => worker.terminated)).toBe(true);
  });

  it('starts the second worker only when the frame path asks for frames', async () => {
    serve(await syntheticAsog({ count: 1500, coeffs: 0 }));
    // Frames take longer than the clip's frame interval below (20 ms), so a
    // second evaluation starts while the first is still running.
    InProcessWorker.replyMs = 50;
    const clip = await loadAsogClip('https://example.test/x.asog');
    await clip.frame(3);
    // Snapshots use the first worker; nothing else has started.
    expect(InProcessWorker.instances).toHaveLength(1);
    const host = {
      clip,
      renderer: {},
      reserveInactiveRange: () => ({}),
      overwriteRangeData: () => undefined,
      overwriteRangeCore: () => undefined,
      setRangeActivePrefix: () => undefined,
      invalidateSort: () => undefined,
      sortInFlight: () => false,
      fail: (error: unknown) => {
        throw error;
      },
    };
    const webgl = { backend: { isWebGPUBackend: false } } as never;
    const plan = clip.driver!.plan({
      renderer: webgl,
      playback: 'frames',
      residentSections: 'auto',
      sortStrategy: undefined,
    });
    const playback = plan.create(host as never);
    playback.apply(0, 1, false);
    expect(InProcessWorker.instances).toHaveLength(2);
    expect(InProcessWorker.instances[1]!.requests).toEqual(['decode']);
    for (let i = 0; i < 20 && playback.shownFrame < 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      playback.apply(0, 1, false);
    }
    expect(playback.shownFrame).toBe(0);
    // Once decoded, the second worker takes frames too.
    for (let f = 1; f < 40 && !InProcessWorker.instances[1]!.requests.includes('frame'); f++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      playback.apply(f / 2, 1, false);
    }
    expect(InProcessWorker.instances[1]!.requests).toContain('frame');
    playback.dispose();
    clip.dispose();
    expect(InProcessWorker.instances.every((w) => w.terminated)).toBe(true);
  });

  it("honours format: 'asog' and reports a broken file", async () => {
    serve(new Uint8Array(128));
    await expect(loadSplatClip('https://example.test/api/42', { format: 'asog' })).rejects.toThrow(
      /not an \.asog file/,
    );
  });

  it('plans the frame path off WebGPU and evaluates fixed slots', async () => {
    const bytes = await syntheticAsog({ count: 2500, coeffs: 0 });
    serve(bytes);
    const clip = await loadAsogClip('https://example.test/x.asog');
    const webgl = { backend: { isWebGPUBackend: false } } as never;
    const plan = clip.driver!.plan({
      renderer: webgl,
      playback: 'auto',
      residentSections: 'auto',
      sortStrategy: undefined,
    });
    expect(plan.path).toBe('frames');
    expect(() =>
      clip.driver!.plan({
        renderer: webgl,
        playback: 'gpu',
        residentSections: 'auto',
        sortStrategy: undefined,
      }),
    ).toThrow(/needs the WebGPU backend/);
    const webgpu = { backend: { isWebGPUBackend: true } } as never;
    const gpuPlan = clip.driver!.plan({
      renderer: webgpu,
      playback: 'auto',
      residentSections: 'auto',
      sortStrategy: undefined,
    });
    expect(gpuPlan.path).toBe('gpu');
    expect(gpuPlan.capacity).toBeGreaterThanOrEqual(2500);
    expect(
      clip.driver!.plan({
        renderer: webgpu,
        playback: 'auto',
        residentSections: 'auto',
        sortStrategy: 'worker',
      }).path,
    ).toBe('frames');
    expect(typeof SplatClipMesh).toBe('function');
    clip.dispose();
  });
});
