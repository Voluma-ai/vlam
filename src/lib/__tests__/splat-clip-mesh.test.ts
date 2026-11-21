import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SplatClipMesh, SplatClipStagingBudget, type SplatClip } from '../dynamic';
import type { SplatClipFrame } from '../dynamic/splat-clip-playback';
import type { CsgsClipSource } from '../dynamic/csgs-gpu-playback';
import type { SplatData } from '../core/splat-data';
import { splatClipFrameAt } from '../dynamic/splat-clip-mesh';
import { createProceduralClip } from '../../viewer/csgs-procedural';

/** The renderer boundary only: uploads and the mesh lifecycle run normally. */
function fakeRenderer(webgpu = true, maxTextureDimension2D = 8192) {
  const copies: number[] = [];
  const renderer = {
    backend: webgpu
      ? { isWebGPUBackend: true, device: { limits: { maxTextureDimension2D } } }
      : { isWebGPUBackend: false },
    getDrawingBufferSize: (size: THREE.Vector2) => size.set(640, 480),
    copyTextureToTexture: (_s: unknown, _d: unknown, _box: unknown, at: THREE.Vector2) =>
      copies.push(at.y),
  } as unknown as THREE.WebGPURenderer;
  return { renderer, copies };
}

/** A procedural clip whose sections the GPU path refuses. */
const ineligible = (source: CsgsClipSource): CsgsClipSource => ({
  ...source,
  sections: source.sections.map((section) => ({ ...section, gpuEligible: false })),
});

const camera = new THREE.PerspectiveCamera(60, 640 / 480, 0.1, 1000);
/** Lets pending clip replies (promise chains) land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const meshes: SplatClipMesh[] = [];

function makeMesh(
  clip: SplatClip,
  options: Partial<ConstructorParameters<typeof SplatClipMesh>[1]> = {},
  renderer = fakeRenderer().renderer,
): { mesh: SplatClipMesh; step: () => Promise<void> } {
  const mesh = new SplatClipMesh(clip, { renderer, shBands: 3, ...options });
  meshes.push(mesh);
  const step = async () => {
    mesh.update(camera, renderer, { sort: false });
    // Let the clip's (async) replies land.
    await settle();
  };
  return { mesh, step };
}

/** Section the GPU path shows, read from its shown frame. */
function gpuInternals(mesh: SplatClipMesh) {
  return (
    mesh as unknown as {
      strategy: {
        shownSection: number;
        slots: { section: number; staged: boolean; token: number }[];
      };
    }
  ).strategy;
}

afterEach(() => {
  for (const mesh of meshes.splice(0)) mesh.dispose();
});

describe('SplatClipMesh path selection', () => {
  it('plays a GPU-eligible clip on the GPU under WebGPU', () => {
    const clip = createProceduralClip();
    expect(clip.gpuEligible).toBe(true);
    const { mesh } = makeMesh(clip);
    expect(mesh.playback).toBe('gpu');
    // N resident sections of one row each (36 + 2 markers), plus a spare row.
    expect(mesh.capacity).toBe((3 + 1) * 2048);
    expect(mesh.sortDisplacement).toHaveLength(1);
  });

  it('falls back to the frame path on WebGL2, for ineligible clips and a worker sorter', () => {
    const clip = createProceduralClip();
    expect(makeMesh(clip, {}, fakeRenderer(false).renderer).mesh.playback).toBe('frames');
    expect(makeMesh(createProceduralClip({ source: ineligible })).mesh.playback).toBe('frames');
    expect(makeMesh(clip, { sortStrategy: 'worker' }).mesh.playback).toBe('frames');
    const frames = makeMesh(clip, { playback: 'frames' }).mesh;
    expect(frames.playback).toBe('frames');
    expect(frames.capacity).toBe(2 * 2048);
    expect(frames.sortDisplacement).toHaveLength(0);
  });

  it("throws for playback 'gpu' where the GPU path is impossible", () => {
    const clip = createProceduralClip();
    expect(() => makeMesh(clip, { playback: 'gpu' }, fakeRenderer(false).renderer)).toThrow(
      /WebGPU backend/,
    );
    expect(() =>
      makeMesh(createProceduralClip({ source: ineligible }), { playback: 'gpu' }),
    ).toThrow(/half-float/);
  });

  it('clamps resident sections to the device texture size', () => {
    // Three sections; each needs one knot-texture row and one pool row.
    const clip = createProceduralClip({ sections: 5 });
    const all = makeMesh(clip, { residentSections: 'all' }).mesh;
    expect(all.playbackStats.resident).toBe(5);
    const two = makeMesh(clip, { residentSections: 2 }).mesh;
    expect(two.playbackStats.resident).toBe(2);
    // A 4-row texture limit: the pool (N rows + 1 spare) allows 3.
    const clamped = makeMesh(clip, { residentSections: 'all' }, fakeRenderer(true, 4).renderer);
    expect(clamped.mesh.playbackStats.resident).toBe(3);
    // Not even two: the auto path plays on the CPU, 'gpu' throws.
    expect(makeMesh(clip, {}, fakeRenderer(true, 2).renderer).mesh.playback).toBe('frames');
    expect(() => makeMesh(clip, { playback: 'gpu' }, fakeRenderer(true, 2).renderer)).toThrow(
      /maxTextureDimension2D/,
    );
  });

  it('keeps knot texel indices exact in float32, whatever the device allows', () => {
    // Sections of 4097 knot rows each: a 16384-row device would fit three, but
    // texel indices past 2^24 (8192 rows) are not exact in the float32 header.
    const clip = createProceduralClip({
      sections: 4,
      source: (source) => ({
        ...source,
        sections: source.sections.map((s) => ({ ...s, texels: 4097 * 2048 })),
      }),
    });
    const tall = fakeRenderer(true, 16_384).renderer;
    expect(makeMesh(clip, {}, tall).mesh.playback).toBe('frames');
    expect(() => makeMesh(clip, { playback: 'gpu' }, tall)).toThrow(/8192 knot rows/);
  });
});

describe('SplatClipMesh time', () => {
  it('does not collide with SplatMesh members', () => {
    const plain = Object.getOwnPropertyNames(Object.getPrototypeOf(SplatClipMesh.prototype));
    for (const name of ['time', 'frame', 'shownFrame', 'alive', 'animation', 'playback', 'clip']) {
      expect(plain).not.toContain(name);
    }
  });

  it('maps seconds to frames, with duration on the last frame', () => {
    const clip = createProceduralClip(); // 24 frames at 8 fps
    expect(splatClipFrameAt(clip, 0)).toBe(0);
    expect(splatClipFrameAt(clip, 1.5)).toBe(12);
    expect(splatClipFrameAt(clip, clip.duration)).toBe(23);
    expect(splatClipFrameAt(clip, clip.duration + 0.5)).toBe(4);
    expect(splatClipFrameAt(clip, -0.125)).toBe(23);
    // A hair off a whole frame (`frame / fps * fps`) is that frame.
    expect(splatClipFrameAt({ ...clip, fps: 29.97 }, (12 / 29.97) * (1 - 1e-15))).toBe(12);
  });

  it('is driven by an AnimationMixer like a glTF animation', () => {
    const { mesh } = makeMesh(createProceduralClip());
    expect(mesh.animation.duration).toBe(3);
    const mixer = new THREE.AnimationMixer(mesh);
    const action = mixer.clipAction(mesh.animation);
    action.play();
    mixer.update(0.5);
    expect(mesh.time).toBeCloseTo(0.5);
    expect(mesh.frame).toBeCloseTo(4);
    action.paused = true;
    mixer.update(1);
    expect(mesh.time).toBeCloseTo(0.5);
    action.time = 1.25;
    mixer.update(0);
    expect(mesh.time).toBeCloseTo(1.25);
    action.paused = false;
    action.timeScale = 0.5;
    mixer.update(1);
    expect(mesh.time).toBeCloseTo(1.75);
    // LoopRepeat wraps.
    action.timeScale = 1;
    mixer.update(2);
    expect(mesh.time).toBeCloseTo(0.75);
    // LoopOnce, clamped: rests on the last frame, not frame 0.
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.reset().play();
    mixer.update(5);
    expect(mesh.time).toBeCloseTo(3);
    expect(Math.floor(mesh.frame)).toBe(23);
    // LoopPingPong comes back.
    action.setLoop(THREE.LoopPingPong, Infinity);
    action.reset().play();
    mixer.update(2.5);
    expect(mesh.time).toBeCloseTo(2.5);
    mixer.update(1);
    expect(mesh.time).toBeCloseTo(2.5);
    // stop() restores the value bound at the start.
    action.stop();
    expect(mesh.time).toBe(0);
  });
});

describe('SplatClipMesh GPU playback', () => {
  it('shows the first section whole, then plays and crosses boundaries both ways', async () => {
    const { mesh, step } = makeMesh(createProceduralClip());
    expect(mesh.shownFrame).toBe(-1);
    // The first apply asks for the section; its reply lands before the next.
    await step();
    await step();
    expect(mesh.shownFrame).toBe(0);
    await mesh.whenShown();
    expect(mesh.alive).toBeGreaterThan(0);
    // Every section ends up resident ('all' by default), so steps never hold.
    for (let i = 0; i < 6; i++) await step();
    expect(mesh.playbackStats.staged).toBe(3);
    for (let frame = 1; frame < 24; frame++) {
      mesh.time = frame / 8;
      await step();
      expect(mesh.shownFrame, `forward ${frame}`).toBe(frame);
    }
    // Reverse across 16 → 15 and 8 → 7, and across the loop point 0 → 23.
    for (let frame = 22; frame >= -1; frame--) {
      mesh.time = frame / 8;
      await step();
      expect(mesh.shownFrame, `reverse ${frame}`).toBe((frame + 24) % 24);
    }
  });

  it('interpolates between frames on the GPU', async () => {
    const { mesh, step } = makeMesh(createProceduralClip());
    await step();
    await step();
    mesh.time = 2.5 / 8;
    await step();
    expect(mesh.frame).toBeCloseTo(2.5);
    expect(mesh.shownFrame).toBe(2);
    let shown = false;
    void mesh.whenShown().then(() => (shown = true));
    await step();
    expect(shown).toBe(true);
  });

  it('holds the drawn frame for a jump to a section that is not staged, then shows it', async () => {
    const clip = createProceduralClip({ sections: 5 });
    const { mesh, step } = makeMesh(clip, {
      residentSections: 2,
      staging: new SplatClipStagingBudget(1),
    });
    await step();
    await step();
    mesh.time = 3 / 8;
    await step();
    expect(mesh.shownFrame).toBe(3);
    // Section 3 (frames 24..31) is not resident: the drawn frame holds.
    mesh.time = 26 / 8;
    let shown = false;
    void mesh.whenShown().then(() => (shown = true));
    await step();
    expect(mesh.shownFrame).toBe(3);
    expect(shown).toBe(false);
    // A 1-byte budget stages one chunk per frame; it arrives within a few.
    for (let i = 0; i < 8 && !shown; i++) await step();
    expect(shown).toBe(true);
    expect(mesh.shownFrame).toBe(26);
  });

  it('lets a newer jump supersede a staging one', async () => {
    const clip = createProceduralClip({ sections: 6 });
    const { mesh, step } = makeMesh(clip, {
      residentSections: 2,
      staging: new SplatClipStagingBudget(0),
    });
    await step();
    await step();
    const gpu = gpuInternals(mesh);
    // A zero budget stages nothing, so the jump target stays unstaged…
    mesh.time = 26 / 8;
    await step();
    expect(gpu.slots.map((slot) => slot.section).sort()).toEqual([0, 3]);
    // …until a newer jump takes its slot: the shown section is never evicted.
    mesh.time = 42 / 8;
    await step();
    expect(gpu.slots.map((slot) => slot.section).sort()).toEqual([0, 5]);
    expect(mesh.shownFrame).toBe(0);
  });

  it('stages ahead in the direction of play and evicts the section left behind', async () => {
    const clip = createProceduralClip({ sections: 4 });
    const { mesh, step } = makeMesh(clip, { residentSections: 2 });
    await step();
    await step();
    for (let i = 0; i < 4; i++) await step();
    const gpu = gpuInternals(mesh);
    // Forward from section 0: section 1 is staged next.
    expect(gpu.slots.map((slot) => slot.section).sort()).toEqual([0, 1]);
    // Playing backwards from frame 0 wraps to section 3, which takes section 1's slot.
    mesh.time = -1 / 8;
    await step();
    for (let i = 0; i < 4; i++) await step();
    expect(mesh.shownFrame).toBe(31);
    // Still going backwards: section 2 is staged next, evicting section 0 (left behind).
    expect(gpu.slots.map((slot) => slot.section).sort()).toEqual([2, 3]);
    // So playing on backwards crosses 24 → 23 without holding a frame.
    for (let frame = 30; frame >= 20; frame--) {
      mesh.time = frame / 8;
      await step();
      expect(mesh.shownFrame, `reverse ${frame}`).toBe(frame);
    }
  });

  it('ignores a stale packed-section reply and survives dispose mid-stage', async () => {
    const replies: (() => void)[] = [];
    const clip = createProceduralClip({
      sections: 4,
      source: (base) => ({
        ...base,
        gpuSection: (index) =>
          new Promise((resolve) => replies.push(() => void base.gpuSection(index).then(resolve))),
      }),
    });
    const { renderer, copies } = fakeRenderer();
    const { mesh, step } = makeMesh(clip, { residentSections: 2 }, renderer);
    await step();
    replies.shift()!();
    await step();
    await step();
    expect(mesh.shownFrame).toBe(0);
    // Section 1 is requested; a jump to section 3 restages that slot first.
    const gpu = gpuInternals(mesh);
    mesh.time = 26 / 8;
    await step();
    const slot = gpu.slots.find((s) => s.section === 3)!;
    expect(slot).toBeDefined();
    // Section 1's (stale) reply lands, then section 3's.
    replies.shift()!();
    await step();
    expect(slot.staged).toBe(false);
    replies.shift()!();
    for (let i = 0; i < 3; i++) await step();
    expect(mesh.shownFrame).toBe(26);
    // Dispose while the next section's reply is outstanding.
    mesh.time = 9 / 8;
    await step();
    const copiesBefore = copies.length;
    mesh.dispose();
    for (const reply of replies.splice(0)) reply();
    await step();
    expect(copies.length).toBe(copiesBefore);
    await expect(mesh.whenShown()).rejects.toThrow(/disposed/);
  });

  it('reports packing failures as error events and keeps the last frame', async () => {
    const clip = createProceduralClip({
      source: (base) => ({
        ...base,
        gpuSection: (index) =>
          index === 1 ? Promise.reject(new Error('pack failed')) : base.gpuSection(index),
      }),
    });
    const { mesh, step } = makeMesh(clip);
    const errors: unknown[] = [];
    mesh.addEventListener('error', ({ error }) => errors.push(error));
    await step();
    await step();
    mesh.time = 10 / 8;
    // Settled into a value at once, so the rejection is never unhandled.
    const waiting = mesh.whenShown().then(
      () => 'shown',
      (error: unknown) => error,
    );
    for (let i = 0; i < 4; i++) await step();
    expect(errors).toHaveLength(1);
    // Played into a section that never arrives: held at the shown one's edge…
    expect(mesh.shownFrame).toBe(7);
    // …and a wait for it gives up with the error instead of hanging.
    expect(String(await waiting)).toMatch(/pack failed/);
    await expect(mesh.whenShown()).rejects.toThrow(/pack failed/);
  });

  it('logs a failure when nobody listens for errors', async () => {
    const clip = createProceduralClip({
      source: (base) => ({
        ...base,
        gpuSection: (index) =>
          index === 1 ? Promise.reject(new Error('pack failed')) : base.gpuSection(index),
      }),
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { mesh, step } = makeMesh(clip);
      await step();
      await step();
      mesh.time = 10 / 8;
      for (let i = 0; i < 4; i++) await step();
      expect(logged).toHaveBeenCalledOnce();
      expect(String(logged.mock.calls[0]![0])).toMatch(/SplatClipMesh "procedural"/);
    } finally {
      logged.mockRestore();
    }
  });
});

describe('SplatClipMesh CPU playback', () => {
  /** A clip whose frames resolve when the test says so. */
  function manualClip() {
    const pending: { frame: number; resolve: () => void }[] = [];
    const clip = createProceduralClip({
      source: (base) => ({
        ...base,
        evaluate: (frame, recycle, sh) =>
          new Promise<SplatClipFrame>((resolve) =>
            pending.push({
              frame,
              resolve: () => void base.evaluate(frame, recycle, sh).then(resolve),
            }),
          ),
      }),
    });
    return { clip, pending };
  }

  it('prefetches in the direction of play and shows late frames', async () => {
    const { clip, pending } = manualClip();
    const { mesh, step } = makeMesh(clip, { playback: 'frames' });
    await step();
    expect(pending.map((p) => p.frame)).toEqual([0]);
    pending.shift()!.resolve();
    await settle();
    await step();
    expect(mesh.shownFrame).toBe(0);
    // Playing: the next frame is asked for ahead of time.
    mesh.time = 0.5 / 8;
    await step();
    expect(pending.map((p) => p.frame)).toEqual([1]);
    pending.shift()!.resolve();
    await settle();
    mesh.time = 2 / 8;
    await step();
    // Frame 1 arrived a frame late: it still shows while time advances.
    expect(mesh.shownFrame).toBe(1);
    expect(pending.map((p) => p.frame)).toEqual([2]);
    pending.shift()!.resolve();
    await settle();
    mesh.time = 2.5 / 8;
    await step();
    expect(mesh.shownFrame).toBe(2);
    expect(pending.map((p) => p.frame)).toEqual([3]);
    // Reversing: the forward prefetch is stale, and the next one goes the other way.
    pending.shift()!.resolve();
    await settle();
    mesh.time = 2.2 / 8;
    await step();
    expect(mesh.shownFrame).toBe(2);
    expect(pending.map((p) => p.frame)).toEqual([1]);
  });

  it('keeps the evaluator busy: the next frame is asked for while one waits', async () => {
    const { clip, pending } = manualClip();
    const { mesh, step } = makeMesh(clip, { playback: 'frames' });
    await step();
    pending.shift()!.resolve();
    await settle();
    await step();
    expect(mesh.shownFrame).toBe(0);
    mesh.time = 0.5 / 8;
    await step();
    expect(pending.map((p) => p.frame)).toEqual([1]);
    pending.shift()!.resolve();
    await settle();
    // Still playing through frame 0 (a time that stands still is a pause).
    mesh.time = 0.75 / 8;
    await step();
    // Frame 1 is evaluated but not due yet; frame 2 is already being evaluated.
    expect(mesh.shownFrame).toBe(0);
    expect(pending.map((p) => p.frame)).toEqual([2]);
    mesh.time = 1 / 8;
    await step();
    expect(mesh.shownFrame).toBe(1);
    pending.shift()!.resolve();
    await settle();
    mesh.time = 1.5 / 8;
    await step();
    // Two ahead at most: frame 3 is asked for, not 4.
    expect(pending.map((p) => p.frame)).toEqual([3]);
    mesh.time = 2 / 8;
    await step();
    expect(mesh.shownFrame).toBe(2);
    // A jump drops the queued prefetch and asks for the frame jumped to.
    pending.shift()!.resolve();
    await settle();
    mesh.time = 10 / 8;
    await step();
    expect(mesh.shownFrame).toBe(2);
    expect(pending.map((p) => p.frame)).toEqual([10]);
    pending.shift()!.resolve();
    await settle();
    await step();
    expect(mesh.shownFrame).toBe(10);
  });

  it('discards a stale frame after a jump', async () => {
    const { clip, pending } = manualClip();
    const { mesh, step } = makeMesh(clip, { playback: 'frames' });
    await step();
    pending.shift()!.resolve();
    await settle();
    await step();
    mesh.time = 0.5 / 8;
    await step();
    // Frame 1 is in flight when time jumps to frame 20.
    mesh.time = 20 / 8;
    await step();
    pending.shift()!.resolve();
    await settle();
    await step();
    expect(mesh.shownFrame).toBe(0);
    expect(pending.map((p) => p.frame)).toEqual([20]);
    pending.shift()!.resolve();
    await settle();
    await step();
    expect(mesh.shownFrame).toBe(20);
    await mesh.whenShown();
  });

  it.each([2.5, 3, 10])(
    'keeps showing frames when time moves %s frames per update',
    async (framesPerUpdate) => {
      // Fast play, or a renderer slower than the clip: every update steps
      // further than a jump's threshold, and must still count as playback.
      const clip = createProceduralClip(); // 24 frames at 8 fps
      const { mesh, step } = makeMesh(clip, { playback: 'frames' });
      let asked = -1;
      for (let i = 0; i < 30; i++) {
        mesh.time = (i * framesPerUpdate) / clip.fps;
        await step();
        // Once playing, each update shows the frame the one before asked for.
        if (i >= 2) expect(mesh.shownFrame).toBe(asked);
        asked = Math.floor(mesh.frame);
      }
    },
  );
});

describe('SplatClipMesh with a clip of any format', () => {
  /** A clip an app could write itself: metadata and `frame()`, no driver. */
  function appClip(frames = 6): SplatClip & { asked: number[] } {
    const asked: number[] = [];
    return {
      asked,
      format: 'my-format',
      name: 'app clip',
      fps: 2,
      totalFrames: frames,
      duration: frames / 2,
      maxCount: 4,
      bounds: new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 3, 1)),
      shBands: 0,
      async frame(index): Promise<SplatData> {
        asked.push(index);
        const count = 2 + (index % 3);
        return {
          count,
          positions: Float32Array.from({ length: count * 3 }, (_, i) =>
            i % 3 === 1 ? index / 2 : 0,
          ),
          colors: new Uint8Array(count * 4).fill(200),
          covariances: Float32Array.from({ length: count * 6 }, (_, i) =>
            i % 6 === 0 || i % 6 === 3 || i % 6 === 5 ? 0.01 : 0,
          ),
        };
      },
      dispose() {},
    };
  }

  it('plays a driver-less clip on the frame path, even on WebGPU', async () => {
    const clip = appClip();
    const { mesh, step } = makeMesh(clip, { shBands: undefined });
    expect(mesh.playback).toBe('frames');
    // Pool sized for maxCount, SH bands from the clip, bounds declared.
    expect(mesh.capacity).toBe(2 * 2048);
    expect(mesh.displacementBounds?.max.toArray()).toEqual([1, 3, 1]);
    for (let i = 0; i < 3; i++) await step();
    expect(mesh.shownFrame).toBe(0);
    mesh.time = 2;
    for (let i = 0; i < 4; i++) await step();
    await mesh.whenShown();
    expect(mesh.shownFrame).toBe(4);
    expect(mesh.alive).toBe(3);
    expect(clip.asked).toContain(4);
  });

  it("throws for playback 'gpu' on a clip without a GPU path", () => {
    expect(() => makeMesh(appClip(), { playback: 'gpu' })).toThrow(
      /my-format clip has no GPU path/,
    );
  });

  it('reports a frame larger than maxCount as an error', async () => {
    const clip = appClip();
    const oversized: SplatClip = { ...clip, maxCount: 1 };
    const { mesh, step } = makeMesh(oversized);
    const errors: unknown[] = [];
    mesh.addEventListener('error', ({ error }) => errors.push(error));
    for (let i = 0; i < 3; i++) await step();
    expect(String(errors[0])).toMatch(/more than its maxCount/);
    await expect(mesh.whenShown()).rejects.toThrow(/maxCount/);
  });

  it('reports a frame without the SH its clip declares as an error', async () => {
    const clip = appClip();
    const declaresSh: SplatClip = { ...clip, shBands: 1 };
    const { mesh, step } = makeMesh(declaresSh, { shBands: undefined });
    const errors: unknown[] = [];
    mesh.addEventListener('error', ({ error }) => errors.push(error));
    for (let i = 0; i < 5; i++) await step();
    // Asked once, failed once: not evaluated again on every update.
    expect(clip.asked).toEqual([0]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/frame 0 carries no SH.*shBands 1/);
    expect(mesh.shownFrame).toBe(-1);
    await expect(mesh.whenShown()).rejects.toThrow(/carries no SH/);
  });
});

describe('SplatClipStagingBudget', () => {
  it('serves one budget per frame, starting with a different member each frame', () => {
    const budget = new SplatClipStagingBudget(10);
    const log: string[] = [];
    const member = (name: string) => ({
      stageWithin: (bytes: number) => {
        log.push(`${name}:${bytes}`);
        return Math.min(bytes, 6);
      },
    });
    const a = member('a');
    const b = member('b');
    const c = member('c');
    for (let frame = 0; frame < 4; frame++) {
      budget.request(a);
      budget.request(b);
      budget.request(c);
    }
    // Frames 0..2 were served when their next frame began.
    expect(log).toEqual(['a:10', 'b:4', 'b:10', 'c:4', 'c:10', 'a:4']);
  });

  it('drops a removed member', () => {
    const budget = new SplatClipStagingBudget(10);
    const stageWithin = vi.fn(() => 0);
    const member = { stageWithin };
    budget.request(member);
    budget.remove(member);
    budget.request(member);
    budget.request(member);
    expect(stageWithin).toHaveBeenCalledOnce();
  });
});
