/**
 * A 4D clip's soundtrack in the demo viewer: an `.asog` file's `audio`, played
 * as a `THREE.PositionalAudio` on the clip's mesh (so it comes from where the
 * clip stands) and kept at the mesh's `time`, restarted there whenever the two
 * drift more than 60 ms apart (each loop, a pause, a hitch).
 *
 * Browsers start audio only after a user gesture: the sound waits for the
 * first click, tap or key press on the page.
 */
import * as THREE from 'three/webgpu';
import type { SplatClip, SplatClipMesh } from '../lib/dynamic';

/** Drift between the sound and the clip that restarts the sound, in seconds. */
const MAX_DRIFT = 0.06;

/** One playing soundtrack; call {@link ClipSound.update} every frame. */
export interface ClipSound {
  update(): void;
  dispose(): void;
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
  options: { positional?: boolean } = {},
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

  const resume = (): void => void context.resume();
  for (const type of ['pointerdown', 'keydown'] as const) {
    addEventListener(type, resume, { once: true, capture: true });
  }

  let started = 0; // context time at which the sound was at second 0
  return {
    update(): void {
      if (context.state !== 'running') return;
      const time = mesh.time;
      if (time >= buffer.duration) return; // a shorter sound waits for the loop
      const heard = context.currentTime - started;
      if (sound.isPlaying && Math.abs(heard - time) < MAX_DRIFT) return;
      if (sound.isPlaying) sound.stop();
      sound.offset = time;
      sound.play();
      started = context.currentTime - time;
    },
    dispose(): void {
      if (sound.isPlaying) sound.stop();
      sound.removeFromParent();
      sound.disconnect();
      for (const type of ['pointerdown', 'keydown'] as const) {
        removeEventListener(type, resume, { capture: true });
      }
    },
  };
}
