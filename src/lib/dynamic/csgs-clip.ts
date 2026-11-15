/**
 * `.csgs` (Faltwerk 4DGS) clip loading: fetches a Faltwerk `scene_*.json`
 * and its sections, and decodes them in a per-clip worker
 * (`csgs-decode-worker.ts`) that keeps them and evaluates or packs frames on
 * request, so neither the rANS decode nor the curve evaluation runs on the
 * page's main thread.
 */
import type { SplatPackedShData } from '../core/splat-data';
import type { CsgsGpuSection } from '../formats/csgs/csgs-gpu-layout';
import CsgsWorker from './csgs-decode-worker?worker&inline';
import { csgsClipDriver, unionCsgsBounds, type CsgsSectionInfo } from './csgs-gpu-playback';
import type { CsgsWorkerReply, CsgsWorkerRequest } from './csgs-worker-protocol';
import type { SplatClip, SplatClipLoadOptions } from './splat-clip';
import type { SplatClipFrame } from './splat-clip-playback';

/**
 * One section entry of a {@link CsgsSceneFile}.
 *
 * @experimental
 */
export interface CsgsSceneSection {
  /** `.csgs` section file, relative to the scene file. */
  url: string;
  /** First frame of the section. */
  g0: number;
  /** Frames the section spans. */
  nframes: number;
}

/**
 * One of a {@link CsgsSceneFile}'s test cameras: an OpenCV pose and pinhole
 * intrinsics, as Faltwerk renders its reference views.
 *
 * @experimental
 */
export interface CsgsTestCamera {
  name: string;
  /** World → camera rotation, OpenCV axes (x right, y down, z forward). */
  R: number[][];
  t: number[];
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/**
 * A Faltwerk `scene_*.json`: the clip's sections, frame rate, a default
 * orbit view and test cameras.
 *
 * @experimental
 */
export interface CsgsSceneFile {
  fps: number;
  sections: CsgsSceneSection[];
  /** A default orbit view; `front` points from the subject toward its front camera. */
  orbit?: { center: number[]; up: number[]; front: number[]; dist: number; fovy_deg: number };
  testcams?: CsgsTestCamera[];
}

/**
 * A decoded `.csgs` clip: a {@link SplatClip} plus what only this format has.
 *
 * @experimental
 */
export interface CsgsClip extends SplatClip {
  readonly format: 'csgs';
  /** The scene file the clip was loaded from. */
  readonly scene: CsgsSceneFile;
  /** The clip's sections, in frame order: spans of frames played by one set of splats. */
  readonly sections: readonly CsgsSectionInfo[];
  /** Whether the GPU path can play every section (see {@link CsgsSectionInfo.gpuEligible}). */
  readonly gpuEligible: boolean;
  /**
   * Worker decode time per section, in ms.
   *
   * @internal
   */
  readonly decodeMs: readonly number[];
}

/**
 * Options of {@link loadCsgsClip}: progress counts sections fetched, then
 * sections decoded.
 *
 * @experimental
 */
export interface LoadCsgsClipOptions extends SplatClipLoadOptions {
  /** An already-fetched scene file (a host that reads test cameras first). */
  scene?: CsgsSceneFile;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The .csgs load was aborted.', 'AbortError');
}

/**
 * Fetches a Faltwerk `scene_*.json`.
 *
 * @experimental
 */
export async function fetchCsgsScene(
  url: URL | string,
  signal?: AbortSignal,
): Promise<CsgsSceneFile> {
  const href = new URL(url, globalThis.location?.href).href;
  const response = await fetch(href, signal ? { signal } : {});
  if (!response.ok) throw new Error(`${href}: HTTP ${response.status}`);
  const scene: unknown = await response.json();
  if (!isCsgsSceneFile(scene)) {
    throw new Error(`${href}: not a Faltwerk scene file (needs fps and sections).`);
  }
  return scene;
}

/**
 * Whether parsed JSON is a Faltwerk scene file: a frame rate and a non-empty
 * list of `.csgs` sections, each with a URL and its frame span.
 */
export function isCsgsSceneFile(value: unknown): value is CsgsSceneFile {
  if (typeof value !== 'object' || value === null) return false;
  const { fps, sections } = value as Partial<CsgsSceneFile>;
  return (
    typeof fps === 'number' &&
    fps > 0 &&
    Array.isArray(sections) &&
    sections.length > 0 &&
    sections.every(
      (section) =>
        typeof section?.url === 'string' &&
        Number.isInteger(section.g0) &&
        Number.isInteger(section.nframes),
    )
  );
}

/** Clip name: the sections' directory (`female_p44/…` → `female`), else the scene file's. */
function clipName(scene: CsgsSceneFile, sceneUrl: URL): string {
  const directory = scene.sections[0]!.url.split('/').slice(-2, -1)[0];
  if (directory) return directory.replace(/_p44$/, '');
  const file = sceneUrl.pathname.split('/').pop() ?? 'clip';
  return file.replace(/^scene_/, '').replace(/(\.scene)?\.json$/, '') || 'clip';
}

/**
 * Loads a `.csgs` clip: fetches its Faltwerk `scene_*.json` (unless
 * `options.scene` is given) and every section, and decodes them in the
 * clip's own worker, which keeps them for playback. Play the result with a
 * `SplatClipMesh`; {@link CsgsClip.dispose} terminates the worker.
 *
 * Every section is fetched and decoded up front (0.4 to 0.8 s per section of
 * 60k to 110k splats). Only version-1 containers are supported.
 *
 * @example
 * ```ts
 * import { loadCsgsClip, SplatClipMesh } from '@voluma/vlam/dynamic';
 *
 * const clip = await loadCsgsClip('https://example.com/scene_female.json', {
 *   onProgress: ({ message }) => (status.textContent = message),
 * });
 * const mesh = new SplatClipMesh(clip, { renderer, orientation: 'source', shBands: 3 });
 * ```
 *
 * @experimental The API may change in a minor release.
 */
export async function loadCsgsClip(
  url: URL | string,
  options: LoadCsgsClipOptions = {},
): Promise<CsgsClip> {
  const { onProgress, signal } = options;
  signal?.throwIfAborted();
  const sceneUrl = new URL(url, globalThis.location?.href);
  const scene = options.scene ?? (await fetchCsgsScene(sceneUrl, signal));
  const total = scene.sections.length;
  let fetched = 0;
  onProgress?.({
    stage: 'fetch',
    loaded: 0,
    total,
    message: `Fetching ${total} sections…`,
  });
  const buffers = await Promise.all(
    scene.sections.map(async (section) => {
      const sectionUrl = new URL(section.url, sceneUrl);
      const response = await fetch(sectionUrl, signal ? { signal } : {});
      if (!response.ok) throw new Error(`${sectionUrl.href}: HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      fetched++;
      onProgress?.({
        stage: 'fetch',
        loaded: fetched,
        total,
        message: `Fetched section ${fetched}/${total}`,
      });
      return bytes;
    }),
  );
  signal?.throwIfAborted();
  const sectionBytes = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  onProgress?.({
    stage: 'decode',
    loaded: 0,
    total,
    message: `Decoding ${(sectionBytes / 1e6).toFixed(1)} MB in a worker…`,
  });

  const worker = new CsgsWorker();
  const sections: CsgsSectionInfo[] = [];
  const decodeMs: number[] = [];
  /** Requests awaiting their reply, by id. */
  const pending = new Map<
    number,
    { resolve: (value: never) => void; reject: (error: Error) => void }
  >();
  let disposed = false;
  let failure: Error | null = null;
  const ask = <T>(message: CsgsWorkerRequest, transfer: Transferable[] = []): Promise<T> => {
    if (failure !== null) return Promise.reject(failure);
    return new Promise<T>((resolve, reject) => {
      pending.set(message.type === 'decode' ? 0 : message.id, { resolve, reject });
      worker.postMessage(message, transfer);
    });
  };
  let nextId = 1;
  let shRange: SplatPackedShData['range'] | null = null;
  let failDecode: ((error: Error) => void) | null = null;
  const fail = (error: Error): void => {
    failure = error;
    worker.terminate();
    failDecode?.(error);
    failDecode = null;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const onAbort = (): void => fail(abortReason(signal!));
  signal?.addEventListener('abort', onAbort, { once: true });
  const settle = (id: number) => {
    const request = pending.get(id);
    pending.delete(id);
    return request;
  };
  const decoded = new Promise<void>((resolve, reject) => {
    failDecode = reject;
    worker.onmessage = (event: MessageEvent<CsgsWorkerReply>) => {
      const reply = event.data;
      if (reply.type === 'section') {
        sections[reply.index] = reply.info;
        decodeMs[reply.index] = reply.decodeMs;
        onProgress?.({
          stage: 'decode',
          loaded: reply.index + 1,
          total,
          message:
            `Decoded section ${reply.index + 1}/${total}: ` +
            `${reply.info.count} splats in ${reply.decodeMs.toFixed(0)} ms`,
        });
      } else if (reply.type === 'decoded') {
        shRange = reply.shRange;
        failDecode = null;
        resolve();
      } else if (reply.type === 'frame') {
        settle(reply.id)?.resolve(frameFromReply(reply, shRange!) as never);
      } else if (reply.type === 'gpuSection') {
        settle(reply.id)?.resolve(reply.section as never);
      } else if (reply.id !== undefined) {
        settle(reply.id)?.reject(new Error(reply.error));
      } else {
        fail(new Error(reply.error));
      }
    };
    worker.onerror = (event) => fail(new Error(event.message || 'CSGS: the clip worker failed.'));
  });
  const request: CsgsWorkerRequest = { type: 'decode', sections: buffers };
  worker.postMessage(request, buffers);
  try {
    await decoded;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  let totalFrames: number;
  try {
    totalFrames = checkSectionSpans(sections, sceneUrl.href);
  } catch (error) {
    fail(error as Error);
    throw error;
  }
  const fps = scene.fps;
  const maxCount = Math.max(...sections.map((s) => s.count));
  const source = {
    sections,
    evaluate(frame: number, recycle?: SplatClipFrame['buffers'], sh = true) {
      return ask<SplatClipFrame>(
        { type: 'frame', id: nextId++, frame, sh, buffers: recycle },
        recycle
          ? [
              recycle.positions.buffer,
              recycle.colors.buffer,
              recycle.covariances.buffer,
              recycle.shPacked.buffer,
            ]
          : [],
      );
    },
    gpuSection(index: number) {
      return ask<CsgsGpuSection>({ type: 'gpuSection', id: nextId++, index });
    },
  };
  return {
    format: 'csgs',
    name: clipName(scene, sceneUrl),
    scene,
    fps,
    totalFrames,
    duration: totalFrames / fps,
    maxCount,
    bounds: unionCsgsBounds(sections),
    shBands: 3,
    sections,
    gpuEligible: sections.every((s) => s.gpuEligible),
    decodeMs,
    driver: csgsClipDriver({ maxCount }, source),
    async frame(index) {
      if (!Number.isInteger(index) || index < 0 || index >= totalFrames) {
        throw new RangeError(`CSGS: frame ${index} is outside 0..${totalFrames - 1}.`);
      }
      const evaluated = await ask<SplatClipFrame>({
        type: 'frame',
        id: nextId++,
        frame: index,
        sh: true,
        compact: true,
      });
      return evaluated.data;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      fail(new Error('CSGS: the clip was disposed.'));
    },
  };
}

/**
 * Checks that decoded sections cover frames `0..total` without a gap or an
 * overlap, as playback assumes, and returns `total`.
 */
function checkSectionSpans(sections: readonly CsgsSectionInfo[], label: string): number {
  let next = 0;
  for (const [index, section] of sections.entries()) {
    if (section.g0 !== next || !(section.nframes > 0)) {
      throw new Error(
        `${label}: section ${index} spans frames ${section.g0}..${section.g0 + section.nframes - 1}, ` +
          `but frame ${next} comes next. Sections must follow each other from frame 0.`,
      );
    }
    next += section.nframes;
  }
  return next;
}

/** Views a frame reply's buffers as `SplatData` of its section's slots. */
function frameFromReply(
  reply: Extract<CsgsWorkerReply, { type: 'frame' }>,
  range: SplatPackedShData['range'],
): SplatClipFrame {
  const { count, buffers } = reply;
  // Packed SH words per splat, as the worker sized the buffers.
  const shWords = buffers.shPacked.length / (buffers.positions.length / 3);
  return {
    frame: reply.frame,
    section: reply.section,
    alive: reply.alive,
    buffers,
    evalMs: reply.evalMs,
    data: {
      count,
      positions: buffers.positions.subarray(0, count * 3),
      colors: buffers.colors.subarray(0, count * 4),
      covariances: buffers.covariances.subarray(0, count * 6),
      ...(reply.sh
        ? {
            shPacked: {
              bands: 3 as const,
              packed: buffers.shPacked.subarray(0, count * shWords),
              range,
            },
          }
        : {}),
    },
  };
}
