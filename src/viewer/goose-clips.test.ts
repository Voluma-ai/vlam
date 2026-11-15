import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  GOOSE_CHOREOGRAPHY_PERIOD,
  GOOSE_WAGS,
  GooseChoreography,
  GoosePuppet,
  createGooseClips,
} from './goose-clips';

const JOINTS = [
  'wingFold',
  'wingRaise',
  'neckCurl',
  'neckTwist',
  'neckLean',
  'headYaw',
  'headPitch',
  'billOpen',
  'tailWag',
  'tailLift',
] as const;

type Pose = Record<(typeof JOINTS)[number], number>;
const pose = (puppet: GoosePuppet): Pose =>
  Object.fromEntries(JOINTS.map((joint) => [joint, puppet[joint]])) as Pose;
const REST = pose(new GoosePuppet());

/** The pose after playing the schedule for `seconds` at 60 frames a second. */
function played(seconds: number) {
  const puppet = new GoosePuppet();
  const choreography = new GooseChoreography(puppet);
  for (let frame = 0; frame < Math.round(seconds * 60); frame++) choreography.update(1 / 60);
  return { puppet, choreography };
}

describe('goose-clips', () => {
  const clips = Object.fromEntries(createGooseClips().map((clip) => [clip.name, clip]));

  it('gives each clip one motion, as long as that motion', () => {
    expect(Object.keys(clips)).toEqual(['look', 'wag', 'flap', 'honk']);
    expect(clips.wag!.duration).toBeCloseTo(1 / 3);
    expect(clips.flap!.duration).toBeLessThan(5);
    expect(clips.honk!.duration).toBeLessThan(1.5);
    expect(clips.honk!.blendMode).toBe(THREE.AdditiveAnimationBlendMode);
    // The normal clips own their joints; only the additive honk shares.
    const owners = new Map<string, string>();
    for (const clip of Object.values(clips)) {
      if (clip.blendMode === THREE.AdditiveAnimationBlendMode) continue;
      for (const track of clip.tracks) {
        expect(owners.get(track.name)).toBeUndefined();
        owners.set(track.name, clip.name);
      }
    }
  });

  it('starts and ends every clip where it can loop or hand back to rest', () => {
    for (const clip of Object.values(clips)) {
      for (const track of clip.tracks) {
        const first = track.values[0] as number;
        const last = track.values[track.values.length - 1] as number;
        expect(Math.abs(last - first), `${clip.name}${track.name}`).toBeLessThan(1e-6);
        if (clip.name !== 'look') {
          const joint = track.name.slice(1) as keyof Pose;
          // Gestures start at rest (the honk's offsets at zero).
          const rest = clip.name === 'honk' ? 0 : REST[joint];
          expect(Math.abs(first - rest), `${clip.name}${track.name}`).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('honks while the wings are up, and wags before and after', () => {
    const puppet = new GoosePuppet();
    const choreography = new GooseChoreography(puppet);
    let honk = 0;
    let wagged = 0;
    let wagOutside = 0;
    for (let frame = 0; frame < GOOSE_CHOREOGRAPHY_PERIOD * 60; frame++) {
      choreography.update(1 / 60);
      const t = choreography.time;
      if (puppet.wingFold < 0.2) honk = Math.max(honk, puppet.billOpen);
      const wagging =
        (t > 1.2 && t < 1.2 + GOOSE_WAGS / 3) || (t > 6.6 && t < 6.6 + GOOSE_WAGS / 3);
      if (wagging) wagged = Math.max(wagged, Math.abs(puppet.tailWag));
      else if (t > 0.1) wagOutside = Math.max(wagOutside, Math.abs(puppet.tailWag));
    }
    expect(honk).toBeGreaterThan(0.3);
    expect(wagged).toBeGreaterThan(0.5);
    expect(wagOutside).toBeLessThan(0.15);
  });

  it('moves smoothly: no joint jumps between frames, across the loop seam', () => {
    const puppet = new GoosePuppet();
    const choreography = new GooseChoreography(puppet);
    let previous = pose(puppet);
    let worst = 0;
    for (let frame = 0; frame < GOOSE_CHOREOGRAPHY_PERIOD * 60 * 2; frame++) {
      choreography.update(1 / 60);
      const next = pose(puppet);
      for (const joint of JOINTS) worst = Math.max(worst, Math.abs(next[joint] - previous[joint]));
      previous = next;
    }
    expect(worst).toBeLessThan(0.2);
  });

  it('seeks to the pose that playing reaches', () => {
    for (const time of [0.5, 2.0, 4.0, 5.2, 7.5]) {
      const { puppet } = played(time);
      const sought = new GoosePuppet();
      new GooseChoreography(sought).seek(time);
      for (const joint of JOINTS) {
        expect(Math.abs(sought[joint] - puppet[joint]), `${joint} at ${time}`).toBeLessThan(0.05);
      }
    }
  });

  it('rests when no gesture plays, and plays one when started', () => {
    const puppet = new GoosePuppet();
    const choreography = new GooseChoreography(puppet);
    choreography.seek(8.5);
    for (const joint of ['wingFold', 'wingRaise', 'billOpen', 'tailWag', 'tailLift'] as const) {
      expect(puppet[joint]).toBeCloseTo(REST[joint], 3);
    }
    choreography.start('flap');
    for (let frame = 0; frame < 120; frame++) choreography.update(1 / 60);
    expect(puppet.wingFold).toBeLessThan(0.1);
  });

  it('holds still while paused, and a held clip can be posed on its own', () => {
    const puppet = new GoosePuppet();
    const choreography = new GooseChoreography(puppet);
    choreography.mixer.timeScale = 0;
    const before = pose(puppet);
    for (let frame = 0; frame < 60; frame++) choreography.update(1 / 60);
    expect(pose(puppet)).toEqual(before);
    expect(choreography.time).toBe(0);
    // What the example's paused wag slider does: only the tail moves.
    const wag = choreography.actions.wag;
    wag.reset().play();
    wag.time = 1 / 12;
    choreography.update(1 / 60);
    const after = pose(puppet);
    expect(after.tailWag).toBeGreaterThan(0.5);
    for (const joint of JOINTS) if (joint !== 'tailWag') expect(after[joint]).toBe(before[joint]);
  });
});
