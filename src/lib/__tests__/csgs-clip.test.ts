import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CsgsWorkerReply, CsgsWorkerRequest } from '../dynamic/csgs-worker-protocol';

/** The clip worker, replaced: replies are scripted by each test. */
class StubWorker {
  static instances: StubWorker[] = [];
  onmessage: ((event: MessageEvent<CsgsWorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: CsgsWorkerRequest[] = [];
  terminated = false;
  constructor() {
    StubWorker.instances.push(this);
  }
  postMessage(message: CsgsWorkerRequest): void {
    this.requests.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(message: CsgsWorkerReply): void {
    this.onmessage?.({ data: message } as MessageEvent<CsgsWorkerReply>);
  }
}

vi.mock('../dynamic/csgs-decode-worker?worker&inline', () => ({ default: StubWorker }));

const { loadCsgsClip, loadSplatClip } = await import('../dynamic');

const SCENE = {
  fps: 30,
  sections: [
    { url: 'female_p44/s0000.csgs', g0: 0, nframes: 32 },
    { url: 'female_p44/s0001.csgs', g0: 32, nframes: 32 },
  ],
};

/** `fetch` serving the scene and sections; section bodies wait for `release`. */
function stubFetch() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fetch = vi.fn(async (url: URL | string, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith('.json')) return new Response(JSON.stringify(SCENE));
    await new Promise<void>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
      void gate.then(resolve);
    });
    return new Response(new ArrayBuffer(16));
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, release };
}

afterEach(() => {
  vi.unstubAllGlobals();
  StubWorker.instances = [];
});

const info = (g0: number, y = 1) => ({
  g0,
  nframes: 32,
  count: 10,
  texels: 130,
  gpuEligible: true,
  bounds: { min: [-1, 0, -1] as const, max: [1, y, 1] as const },
});

/** Answers the decode of a two-section clip; returns the worker. */
async function decodeTwoSections(sections = [info(0), { ...info(32, 2), count: 12 }]) {
  await vi.waitFor(() => expect(StubWorker.instances).toHaveLength(1));
  const worker = StubWorker.instances[0]!;
  sections.forEach((section, index) =>
    worker.reply({ type: 'section', index, info: section, decodeMs: 5 }),
  );
  worker.reply({ type: 'decoded', shRange: { min: [0, 0, 0], max: [1, 1, 1] } });
  return worker;
}

describe('loadCsgsClip', () => {
  it('fetches, decodes in the worker and describes the clip', async () => {
    const { release } = stubFetch();
    const progress: string[] = [];
    const loading = loadCsgsClip('https://example.test/scene_female.json', {
      onProgress: (event) => progress.push(`${event.stage} ${event.loaded}/${event.total}`),
    });
    release();
    await vi.waitFor(() => expect(StubWorker.instances).toHaveLength(1));
    const worker = StubWorker.instances[0]!;
    expect(worker.requests[0]!.type).toBe('decode');
    worker.reply({ type: 'section', index: 0, info: info(0), decodeMs: 5 });
    worker.reply({ type: 'section', index: 1, info: { ...info(32, 2), count: 12 }, decodeMs: 6 });
    worker.reply({ type: 'decoded', shRange: { min: [0, 0, 0], max: [1, 1, 1] } });
    const clip = await loading;
    expect(clip.name).toBe('female');
    expect(clip.fps).toBe(30);
    expect(clip.totalFrames).toBe(64);
    expect(clip.duration).toBeCloseTo(64 / 30);
    expect(clip.maxCount).toBe(12);
    expect(clip.gpuEligible).toBe(true);
    expect(clip.format).toBe('csgs');
    expect(clip.shBands).toBe(3);
    // One box around every section's position knots.
    expect(clip.bounds.min.toArray()).toEqual([-1, 0, -1]);
    expect(clip.bounds.max.toArray()).toEqual([1, 2, 1]);
    expect(progress).toEqual([
      'fetch 0/2',
      'fetch 1/2',
      'fetch 2/2',
      'decode 0/2',
      'decode 1/2',
      'decode 2/2',
    ]);
    clip.dispose();
    expect(worker.terminated).toBe(true);
    await expect(clip.frame(0)).rejects.toThrow(/disposed/);
  });

  it('snapshots a frame as compact, alive-only data', async () => {
    const { release } = stubFetch();
    const loading = loadCsgsClip('https://example.test/scene_female.json');
    release();
    const worker = await decodeTwoSections();
    const clip = await loading;
    const snapshot = clip.frame(40);
    const request = worker.requests.at(-1)!;
    expect(request).toMatchObject({ type: 'frame', frame: 40, sh: true, compact: true });
    const buffers = {
      positions: new Float32Array(12 * 3),
      colors: new Uint8Array(12 * 4),
      covariances: new Float32Array(12 * 6),
      shPacked: new Uint32Array(12 * 15),
    };
    worker.reply({
      type: 'frame',
      id: (request as { id: number }).id,
      frame: 40,
      section: 1,
      count: 7,
      alive: 7,
      sh: true,
      buffers,
      evalMs: 1,
    });
    const data = await snapshot;
    expect(data.count).toBe(7);
    expect(data.positions).toHaveLength(21);
    expect(data.shPacked?.bands).toBe(3);
    await expect(clip.frame(64)).rejects.toThrow(RangeError);
    clip.dispose();
  });

  it('rejects sections that leave a gap', async () => {
    const { release } = stubFetch();
    const loading = loadCsgsClip('https://example.test/scene_female.json');
    release();
    const worker = await decodeTwoSections([info(0), info(40)]);
    await expect(loading).rejects.toThrow(/section 1 spans frames 40\.\.71, but frame 32/);
    expect(worker.terminated).toBe(true);
  });

  it('aborts the section fetches without starting a worker', async () => {
    stubFetch();
    const controller = new AbortController();
    const loading = loadCsgsClip('https://example.test/scene_female.json', {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(loading).rejects.toHaveProperty('name', 'AbortError');
    expect(StubWorker.instances).toHaveLength(0);
  });

  it('terminates the worker when aborted during the decode', async () => {
    const { release } = stubFetch();
    const controller = new AbortController();
    const loading = loadCsgsClip('https://example.test/scene_female.json', {
      signal: controller.signal,
    });
    release();
    await vi.waitFor(() => expect(StubWorker.instances).toHaveLength(1));
    controller.abort();
    await expect(loading).rejects.toHaveProperty('name', 'AbortError');
    expect(StubWorker.instances[0]!.terminated).toBe(true);
  });

  it('rejects a file that is not a scene', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"hello":1}')),
    );
    await expect(loadCsgsClip('https://example.test/other.json')).rejects.toThrow(
      /not a Faltwerk scene/,
    );
  });
});

describe('loadSplatClip', () => {
  it('reads a Faltwerk scene file as a .csgs clip', async () => {
    const { release, fetch } = stubFetch();
    const loading = loadSplatClip('https://example.test/scene_female.json');
    release();
    await decodeTwoSections();
    const clip = await loading;
    expect(clip.format).toBe('csgs');
    expect(clip.totalFrames).toBe(64);
    // The scene file is fetched once: the .csgs loader reuses it.
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('.json'))).toHaveLength(1);
    clip.dispose();
  });

  it("honours format: 'csgs' for a URL that does not say what it is", async () => {
    const { release } = stubFetch();
    const loading = loadSplatClip('https://example.test/clips/42.json', { format: 'csgs' });
    release();
    await decodeTwoSections();
    expect((await loading).format).toBe('csgs');
  });

  it('names the supported formats for anything else', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"hello":1}')),
    );
    await expect(loadSplatClip('https://example.test/other.json')).rejects.toThrow(
      /not a clip description.*Faltwerk \.csgs/,
    );
    await expect(loadSplatClip('https://example.test/clip.mp4')).rejects.toThrow(
      /not a recognised clip URL/,
    );
    await expect(loadSplatClip('https://example.test/s0000.csgs')).rejects.toThrow(
      /single \.csgs section/,
    );
  });

  it('aborts before fetching', async () => {
    const { fetch } = stubFetch();
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadSplatClip('https://example.test/scene_female.json', { signal: controller.signal }),
    ).rejects.toHaveProperty('name', 'AbortError');
    expect(fetch).not.toHaveBeenCalled();
  });
});
