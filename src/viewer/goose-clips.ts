/**
 * Animation clips for the procedural goose, in the form a glTF file carries
 * its skeletal animation: `THREE.AnimationClip`s of sampled keyframe tracks,
 * played and blended by a `THREE.AnimationMixer`.
 *
 * A glTF clip's tracks target bone transforms. The goose's rig (`goose-rig.ts`)
 * is posed by a handful of joint angles instead, so the tracks target those:
 * numbers on a {@link GoosePuppet}, which `rig.setPose(puppet)` shows.
 *
 * Each clip holds one motion and lasts as long as that motion, as a clip
 * exported from an animation tool does:
 *
 *  - `look`: the head and neck turning and the goose breathing; a loop.
 *  - `wag`: one wag of the tail, played five times over as a gesture.
 *  - `flap`: the wings opening, beating and folding again; played once.
 *  - `honk`: the head lifting while the bill opens and shuts; played once,
 *    and additive, so it lifts the head on top of wherever `look` has it.
 *
 * {@link GooseChoreography} plays `look` throughout and fires the others on a
 * {@link GOOSE_CHOREOGRAPHY_PERIOD}-second schedule, so the goose honks while
 * its wings are up.
 */
import * as THREE from 'three/webgpu';
import type { GoosePose } from './goose-procedural';

/** Keyframes per second, as an exporter samples a baked animation. */
const FPS = 30;

type Joint = keyof GoosePose;
type Curve = (seconds: number) => number;

/**
 * The goose's joints as animatable numbers, in the rest pose (standing,
 * wings folded) by default. An `Object3D` so an `AnimationMixer` can bind to
 * it as the root of a scene, as it binds a glTF's nodes.
 */
export class GoosePuppet extends THREE.Object3D implements Required<GoosePose> {
  wingFold = 1;
  wingRaise = 0;
  neckCurl = 0;
  neckTwist = 0;
  neckLean = 0;
  headYaw = 0;
  headPitch = 0;
  billOpen = 0;
  tailWag = 0;
  tailLift = 0;
}

const smoothstep = (lo: number, hi: number, x: number): number => {
  const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
};

/** 1 between `from` and `to`, easing in and out over `ease` seconds. */
const envelope = (from: number, to: number, ease: number, x: number): number =>
  smoothstep(from, from + ease, x) * (1 - smoothstep(to - ease, to, x));

/** A clip of `curves` sampled at {@link FPS} over `duration` seconds. */
function sampledClip(
  name: string,
  duration: number,
  curves: Partial<Record<Joint, Curve>>,
): THREE.AnimationClip {
  const frames = Math.max(2, Math.round(duration * FPS));
  const times = Float32Array.from({ length: frames + 1 }, (_, i) => (i / frames) * duration);
  const tracks = (Object.entries(curves) as [Joint, Curve][]).map(
    ([joint, curve]) =>
      new THREE.NumberKeyframeTrack(`.${joint}`, times, Float32Array.from(times, curve)),
  );
  return new THREE.AnimationClip(name, duration, tracks);
}

/** The gesture clips; `look` is the one that loops. */
export type GooseClipName = 'look' | 'wag' | 'flap' | 'honk';

/** Length of the look loop. */
const LOOK_LENGTH = 9;
/** One wag, a third of a second: three wags a second. */
const WAG_LENGTH = 1 / 3;
const FLAP_LENGTH = 4.1;
const HONK_LENGTH = 1.1;
/** How many wags one `wag` gesture is. */
export const GOOSE_WAGS = 5;

/** The goose's clips, `look` first (see the module comment). */
export function createGooseClips(): THREE.AnimationClip[] {
  const W = (2 * Math.PI) / LOOK_LENGTH;
  const look = (t: number): number => Math.sin(2 * W * t) + 0.4 * Math.sin(5 * W * t + 1);
  const open = (t: number): number => envelope(0, FLAP_LENGTH, 0.95, t);
  const beating = (t: number): number => envelope(0.7, 3.2, 0.4, t);
  const honking = (t: number): number => envelope(0, HONK_LENGTH, 0.2, t);
  const honk = sampledClip('honk', HONK_LENGTH, {
    neckCurl: (t) => -0.06 * honking(t),
    headPitch: (t) => -0.12 * honking(t),
    billOpen: (t) => honking(t) * 0.45 * Math.max(0, Math.sin(2 * Math.PI * 1.6 * t)),
  });
  // The honk's tracks become offsets from its first frame (the rest pose),
  // added on top of the other clips rather than averaged with them.
  THREE.AnimationUtils.makeClipAdditive(honk);
  return [
    sampledClip('look', LOOK_LENGTH, {
      neckTwist: (t) => 0.07 * look(t),
      headYaw: (t) => 0.22 * look(t),
      neckLean: (t) => 0.02 * Math.sin(W * t + 2),
      headPitch: (t) => 0.06 * Math.sin(3 * W * t + 0.5),
      neckCurl: (t) => 0.03 * Math.sin(8 * W * t),
    }),
    sampledClip('wag', WAG_LENGTH, {
      tailWag: (t) => 0.55 * Math.sin(2 * Math.PI * (t / WAG_LENGTH)),
    }),
    sampledClip('flap', FLAP_LENGTH, {
      wingFold: (t) => 1 - open(t),
      wingRaise: (t) =>
        open(t) * (0.12 + beating(t) * (0.2 + 0.5 * Math.sin(2 * Math.PI * 2.4 * (t - 0.7)))),
      tailLift: (t) => 0.12 * open(t),
    }),
    honk,
  ];
}

/** Length of the {@link GooseChoreography} schedule, in seconds. */
export const GOOSE_CHOREOGRAPHY_PERIOD = 9;

/** When each gesture starts within the schedule. */
const SCHEDULE: readonly { readonly clip: Exclude<GooseClipName, 'look'>; readonly at: number }[] =
  [
    { clip: 'wag', at: 1.2 },
    { clip: 'flap', at: 2.5 },
    { clip: 'honk', at: 3.3 },
    { clip: 'honk', at: 4.6 },
    { clip: 'wag', at: 6.6 },
  ];

/**
 * Plays the goose's clips the way a game plays a character's: `look` loops
 * underneath, and the gestures are one-shot actions fired on top, here on a
 * repeating {@link GOOSE_CHOREOGRAPHY_PERIOD}-second schedule. Call
 * {@link start} to fire a gesture yourself.
 *
 * Speed and pause are the mixer's `timeScale`, which the schedule follows.
 */
export class GooseChoreography {
  readonly mixer: THREE.AnimationMixer;
  readonly actions: Readonly<Record<GooseClipName, THREE.AnimationAction>>;
  /** Seconds into the schedule, 0 up to {@link GOOSE_CHOREOGRAPHY_PERIOD}. */
  time = 0;

  constructor(puppet: GoosePuppet) {
    this.mixer = new THREE.AnimationMixer(puppet);
    const actions = Object.fromEntries(
      createGooseClips().map((clip) => [clip.name, this.mixer.clipAction(clip)]),
    ) as Record<GooseClipName, THREE.AnimationAction>;
    for (const name of ['wag', 'flap', 'honk'] as const) {
      // A finished gesture holds its last frame, which is the rest pose.
      actions[name].clampWhenFinished = true;
      actions[name].setLoop(THREE.LoopOnce, 1);
    }
    actions.look.play();
    this.actions = actions;
    this.seek(0);
  }

  /**
   * Starts a gesture from its beginning, or `offset` seconds into it. A wag
   * gesture repeats the one-wag clip {@link GOOSE_WAGS} times.
   */
  start(name: Exclude<GooseClipName, 'look'>, offset = 0): void {
    const action = this.actions[name];
    action.reset();
    if (name === 'wag') {
      const done = Math.floor(offset / WAG_LENGTH);
      action.setLoop(THREE.LoopRepeat, GOOSE_WAGS - done);
      action.time = offset - done * WAG_LENGTH;
    } else {
      action.time = offset;
    }
    action.play();
  }

  /** Advances the mixer and the schedule by `delta` seconds of wall time. */
  update(delta: number): void {
    const step = delta * this.mixer.timeScale;
    const from = this.time;
    const to = from + step;
    this.mixer.update(delta);
    if (step <= 0) return;
    let fired = false;
    for (const cue of SCHEDULE) {
      // The cue's start, counted from `from`, within the step just taken.
      const at = cue.at > from ? cue.at : cue.at + GOOSE_CHOREOGRAPHY_PERIOD;
      if (at <= to) {
        this.start(cue.clip, to - at);
        fired = true;
      }
    }
    // Show a gesture from the frame it starts, not the next one.
    if (fired) this.mixer.update(0);
    this.time = to % GOOSE_CHOREOGRAPHY_PERIOD;
  }

  /**
   * Jumps to `time` seconds into the schedule: `look` to its matching moment,
   * each gesture to where its latest cue has it (or stopped, in the rest
   * pose, when none is playing then), and shows the result.
   */
  seek(time: number): void {
    const period = GOOSE_CHOREOGRAPHY_PERIOD;
    this.time = ((time % period) + period) % period;
    this.actions.look.time = this.time % this.actions.look.getClip().duration;
    for (const name of ['wag', 'flap', 'honk'] as const) {
      const length =
        name === 'wag' ? GOOSE_WAGS * WAG_LENGTH : this.actions[name].getClip().duration;
      let elapsed = Infinity;
      for (const cue of SCHEDULE) {
        if (cue.clip === name && cue.at <= this.time) elapsed = this.time - cue.at;
      }
      if (elapsed < length) this.start(name, elapsed);
      else this.actions[name].stop();
    }
    this.mixer.update(0);
  }
}
