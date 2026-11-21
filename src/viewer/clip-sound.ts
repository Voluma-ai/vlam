/**
 * A 4D clip's soundtrack in the demo viewer: an `.asog` file's `audio`, played
 * as a `THREE.PositionalAudio` on the clip's mesh (so it comes from where the
 * clip stands) and kept at the mesh's `time` (format v1 section 6):
 *
 * - The sound plays at the clip's rate (`options.rate`, e.g. the mixer
 *   action's effective time scale), so 0.5× and 2× stay in step without
 *   restarts.
 * - Where the sound is heard is integrated frame by frame at the rate it
 *   played at; when it drifts more than 60 ms from `mesh.time` (each loop
 *   restart, a scrub, a hitch), the sound restarts at `mesh.time`.
 * - It is silent while the clip's time holds still (paused), plays in
 *   reverse, or runs slower than 0.25× or faster than 4×, and past the end
 *   of a sound shorter than the clip.
 *
 * Browsers start audio only after a user gesture: the sound waits for the
 * first click, tap or key press on the page.
 */
import * as THREE from 'three/webgpu';
import type { SplatClip, SplatClipMesh } from '../lib/dynamic';

/** Drift between the sound and the clip that restarts the sound, in seconds. */
const MAX_DRIFT = 0.06;
/** Slowest and fastest clip rates the sound plays at; outside them it is silent. */
const MIN_RATE = 0.25;
const MAX_RATE = 4;

/** One playing soundtrack; call {@link ClipSound.update} every frame. */
export interface ClipSound {
  update(): void;
  dispose(): void;
  /**
   * Seconds between where the sound is heard and `mesh.time` after the last
   * update (0 while silent), and the largest such gap since the last restart
   * of the sound, and the drift that caused the last restart (NaN for a
   * start from silence or after the sound ended). For checks; a restart
   * resets `maxDrift`.
   */
  readonly stats: {
    drift: number;
    maxDrift: number;
    restarts: number;
    restartDrift: number;
    playing: boolean;
  };
}

/** Options of {@link createClipSound}. */
export interface ClipSoundOptions {
  /** A `THREE.PositionalAudio` on the mesh (default) or a plain `THREE.Audio`. */
  positional?: boolean;
  /**
   * The clip's playback rate: seconds of `mesh.time` per second of real time
   * (negative in reverse). Default 1. With an `AnimationMixer`, pass
   * `() => action.getEffectiveTimeScale() * mixer.timeScale`.
   */
  rate?: () => number;
}

let sharedListener: THREE.AudioListener | null = null;

/**
 * The soundtrack of `clip` on `mesh`, heard through a listener on `camera`,
 * or null when the clip has none (only `.asog` files carry one).
 */
export async function createClipSound(
  clip: SplatClip,
  mesh: SplatClipMesh,
  camera: THREE.Camera,
  options: ClipSoundOptions = {},
): Promise<ClipSound | null> {
  const audio = (clip as { audio?: { bytes: Uint8Array } | null }).audio;
  if (!audio) return null;
  const listener = (sharedListener ??= new THREE.AudioListener());
  if (listener.parent !== camera) camera.add(listener);
  const context = listener.context;
  const buffer = await context.decodeAudioData(audio.bytes.slice().buffer);
  const positional = options.positional !== false;
  const sound = positional ? new THREE.PositionalAudio(listener) : new THREE.Audio(listener);
  if (sound instanceof THREE.PositionalAudio) sound.setRefDistance(3);
  sound.setBuffer(buffer);
  mesh.add(sound);

  // A touch activates the page on its release, not its `pointerdown`, so the
  // context is resumed on every gesture until one of them lets it run.
  const gestures = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;
  const stopListening = (): void => {
    for (const type of gestures) removeEventListener(type, resume, { capture: true });
  };
  const resume = (): void => {
    void context.resume().then(() => {
      if (context.state === 'running') stopListening();
    });
  };
  if (context.state !== 'running') {
    for (const type of gestures) addEventListener(type, resume, { capture: true });
  }

  const stats = { drift: 0, maxDrift: 0, restarts: 0, restartDrift: Number.NaN, playing: false };
  /** Where in the sound it is heard now, integrated at the rate it plays at. */
  let heard = 0;
  let lastNow = 0;
  let lastTime = Number.NaN;
  const silence = (): void => {
    if (sound.isPlaying) sound.stop();
    stats.drift = 0;
    stats.playing = false;
  };
  return {
    stats,
    update(): void {
      if (context.state !== 'running') return;
      const now = context.currentTime;
      const time = mesh.time;
      const held = time === lastTime;
      lastTime = time;
      const rate = options.rate?.() ?? 1;
      if (held || !(rate >= MIN_RATE && rate <= MAX_RATE) || time >= buffer.duration) {
        // Paused, reversed or at an extreme rate: silent. A shorter sound
        // waits for the loop.
        silence();
        return;
      }
      stats.restartDrift = Number.NaN;
      if (sound.isPlaying) {
        heard += (now - lastNow) * sound.playbackRate;
        lastNow = now;
        if (sound.playbackRate !== rate) sound.setPlaybackRate(rate);
        stats.drift = heard - time;
        if (Math.abs(stats.drift) < MAX_DRIFT) {
          stats.maxDrift = Math.max(stats.maxDrift, Math.abs(stats.drift));
          return;
        }
        stats.restartDrift = stats.drift;
        sound.stop();
      } else if (buffer.duration - time < MAX_DRIFT) {
        // The sound ran out a frame ahead of the clip: wait for the loop
        // rather than start it for its last few milliseconds.
        silence();
        return;
      }
      sound.setPlaybackRate(rate);
      sound.offset = time;
      sound.play();
      heard = time;
      lastNow = now;
      stats.drift = 0;
      stats.maxDrift = 0;
      stats.restarts++;
      stats.playing = true;
    },
    dispose(): void {
      silence();
      sound.removeFromParent();
      sound.disconnect();
      stopListening();
    },
  };
}
