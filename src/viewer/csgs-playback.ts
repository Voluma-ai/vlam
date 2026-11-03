/**
 * `.csgs` (Faltwerk 4DGS) clip loading and playback, shared by the playback
 * harness (`csgs-harness.ts`) and the demo viewer's `4dgs` effect.
 *
 * A clip's sections are fetched and decoded once in a worker; each displayed
 * frame is then evaluated on the CPU and swapped into a dynamic-capacity
 * {@link CsgsPlaybackMesh} whole (remove + append), so nothing in the renderer
 * knows about time.
 */
import * as THREE from 'three/webgpu';
import { SplatMesh, type SplatMeshOptions, type SplatRange } from '../lib/core';
import {
  createCsgsFrameBuffers,
  evaluateCsgsFrame,
  type CsgsFrameBuffers,
  type CsgsPlaybackSection,
} from '../lib/formats/csgs';
import type { CsgsDecodeReply, CsgsDecodeRequest } from './csgs-decode-worker';

export interface CsgsSceneSection {
  url: string;
  g0: number;
  nframes: number;
}

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

/** A Faltwerk `scene_*.json`: the clip's sections, frame rate and cameras. */
export interface CsgsSceneFile {
  fps: number;
  sections: CsgsSceneSection[];
  orbit: { center: number[]; up: number[]; front: number[]; dist: number; fovy_deg: number };
  testcams: CsgsTestCamera[];
}

/** A decoded clip, ready for {@link CsgsPlaybackMesh}. */
export interface CsgsClip {
  /** Clip name from the section path (`female`, `male_1`, …). */
  readonly name: string;
  readonly scene: CsgsSceneFile;
  readonly sections: readonly CsgsPlaybackSection[];
  readonly totalFrames: number;
  readonly sectionBytes: number;
  readonly decodeMs: readonly number[];
}

/**
 * The default clip of the harness and the demo's `4dgs` effect, linked from
 * the public Faltwerk demo (GitHub Pages serves it with CORS `*`). The clips
 * have no stated license, so they are linked, not copied, until permission
 * is granted.
 */
export const CSGS_DEMO_SCENE = 'https://jameskane05.github.io/faltwerk-demo/scene_female.json';

/** Pool rows are 2048 splats wide; a range rounds up to whole rows. */
const POOL_ROW = 2048;

/** Decodes every section in the worker, resolving once all have arrived. */
function decodeSections(
  buffers: ArrayBuffer[],
  onSection: (index: number, section: CsgsPlaybackSection, decodeMs: number) => void,
): Promise<void> {
  const worker = new Worker(new URL('./csgs-decode-worker.ts', import.meta.url), {
    type: 'module',
  });
  return new Promise((resolve, reject) => {
    let remaining = buffers.length;
    worker.onmessage = (event: MessageEvent<CsgsDecodeReply>) => {
      const reply = event.data;
      if ('error' in reply) {
        worker.terminate();
        reject(new Error(reply.error));
        return;
      }
      onSection(reply.index, reply.section, reply.decodeMs);
      if (--remaining === 0) {
        worker.terminate();
        resolve();
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    const request: CsgsDecodeRequest = { id: 1, sections: buffers };
    worker.postMessage(request, buffers);
  });
}

/** Fetches a Faltwerk `scene_*.json`. */
export async function fetchCsgsScene(sceneUrl: URL): Promise<CsgsSceneFile> {
  const response = await fetch(sceneUrl);
  if (!response.ok) throw new Error(`${sceneUrl.href}: HTTP ${response.status}`);
  return (await response.json()) as CsgsSceneFile;
}

/**
 * Fetches a Faltwerk `scene_*.json` (unless already given) and its sections
 * and decodes them in a worker. `onProgress` reports each step for a status
 * line.
 */
export async function loadCsgsClip(
  sceneUrl: URL,
  onProgress?: (message: string) => void,
  sceneFile?: CsgsSceneFile,
): Promise<CsgsClip> {
  const scene = sceneFile ?? (await fetchCsgsScene(sceneUrl));
  onProgress?.(`Fetching ${scene.sections.length} sections…`);
  const buffers = await Promise.all(
    scene.sections.map(async (section) => {
      const url = new URL(section.url, sceneUrl);
      const sectionResponse = await fetch(url);
      if (!sectionResponse.ok) throw new Error(`${url.href}: HTTP ${sectionResponse.status}`);
      return sectionResponse.arrayBuffer();
    }),
  );
  const sectionBytes = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const sections: (CsgsPlaybackSection | null)[] = scene.sections.map(() => null);
  const decodeMs: number[] = [];
  onProgress?.(`Decoding ${(sectionBytes / 1e6).toFixed(1)} MB in a worker…`);
  await decodeSections(buffers, (index, section, ms) => {
    sections[index] = section;
    decodeMs[index] = ms;
    onProgress?.(
      `Decoded section ${index + 1}/${sections.length}: ${section.count} splats in ${ms.toFixed(0)} ms`,
    );
  });
  return {
    name: scene.sections[0]!.url.split('/').slice(-2, -1)[0]!.replace(/_p44$/, ''),
    scene,
    sections: sections as CsgsPlaybackSection[],
    totalFrames: Math.max(...scene.sections.map((s) => s.g0 + s.nframes)),
    sectionBytes,
    decodeMs,
  };
}

/** The section holding integer frame `frame`, if any. */
export function csgsSectionAt(clip: CsgsClip, frame: number): CsgsPlaybackSection | undefined {
  return clip.sections.find((s) => frame >= s.g0 && frame < s.g0 + s.nframes);
}

/**
 * A dynamic-capacity {@link SplatMesh} that shows one frame of a clip at a
 * time, sized for the clip's largest section.
 *
 * A swap waits while the previous frame's GPU sort is in flight
 * ({@link showFrame} returns false): the mesh keeps drawing that sort's order
 * until it completes, and the swap rewrites the very pool rows the order
 * indexes, so the frame in between would draw the new splats in the old order
 * (a one-frame unsorted flash). `StreamedSplatMesh` holds its swaps on the
 * same gate.
 */
export class CsgsPlaybackMesh extends SplatMesh {
  readonly clip: CsgsClip;
  /** Splats alive in the shown frame. */
  alive = 0;
  /** Integer frame shown, or -1 before the first swap. */
  shownFrame = -1;
  /** CPU curve evaluation of the last swap. */
  evalMs = 0;
  /** `removeRange` + `appendRange` of the last swap. */
  swapMs = 0;
  /** Swaps deferred because the previous frame's sort was still in flight. */
  heldSwaps = 0;
  private readonly frameBuffers: CsgsFrameBuffers;
  private range: SplatRange | null = null;

  constructor(clip: CsgsClip, options: SplatMeshOptions = {}) {
    const maxCount = Math.max(...clip.sections.map((s) => s.count));
    // One spare row: a range rounds up to whole rows.
    super({ capacity: Math.ceil(maxCount / POOL_ROW) * POOL_ROW + POOL_ROW }, options);
    this.clip = clip;
    this.frameBuffers = createCsgsFrameBuffers(maxCount);
  }

  /** Whether a GPU sort still owns the draw order (a swap now would flash). */
  get sortInFlight(): boolean {
    return this.hasInFlightSortSubmission();
  }

  /**
   * Evaluates frame time `t` and swaps it into the pool. Returns false, and
   * leaves the shown frame in place, while the previous sort is in flight.
   */
  showFrame(t: number): boolean {
    if (this.sortInFlight) {
      this.heldSwaps++;
      return false;
    }
    const frame = Math.floor(t);
    const section = csgsSectionAt(this.clip, frame);
    if (!section) return true;
    const t0 = performance.now();
    const data = evaluateCsgsFrame(section, t, this.frameBuffers);
    const t1 = performance.now();
    if (this.range) this.removeRange(this.range);
    this.range = data.count > 0 ? this.appendRange(data) : null;
    this.swapMs = performance.now() - t1;
    this.evalMs = t1 - t0;
    this.alive = data.count;
    this.shownFrame = frame;
    return true;
  }

  /**
   * Local bounds of the clip's first frame, ignoring the 1 % most outlying
   * splats per axis (stray floaters would otherwise set the floor).
   */
  frameBounds(frame = 0): THREE.Box3 {
    const section = csgsSectionAt(this.clip, frame) ?? this.clip.sections[0]!;
    const data = evaluateCsgsFrame(section, frame, this.frameBuffers);
    const box = new THREE.Box3();
    if (data.count === 0) return box;
    for (let axis = 0; axis < 3; axis++) {
      const values = new Float32Array(data.count);
      for (let i = 0; i < data.count; i++) values[i] = data.positions[i * 3 + axis]!;
      values.sort();
      const low = values[Math.floor(data.count * 0.01)]!;
      const high = values[Math.min(data.count - 1, Math.floor(data.count * 0.99))]!;
      box.min.setComponent(axis, low);
      box.max.setComponent(axis, high);
    }
    // The shown frame's buffers were just overwritten; force the next swap.
    this.shownFrame = -1;
    return box;
  }

  override dispose(): void {
    if (this.range) this.removeRange(this.range);
    this.range = null;
    super.dispose();
  }
}
