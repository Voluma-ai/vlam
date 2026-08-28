/**
 * Frees the JS-heap mirror of storage buffers only the GPU ever reads.
 *
 * ## The gap
 *
 * Every `THREE.StorageBufferAttribute` is constructed around a JS typed array,
 * and three's WebGPU backend never releases it. `WebGPUAttributeUtils`'s
 * `createAttribute` copies the array into a `mappedAtCreation` GPU buffer,
 * unmaps it, stores the buffer - and never calls `bufferAttribute
 * .onUploadCallback()`, the hook that exists for exactly this and that the
 * legacy WebGL renderer does call (`WebGLAttributes.js`). So a buffer of N
 * slots costs N bytes on the GPU *and the same again on the JS heap,
 * permanently*, even when nothing ever reads the CPU copy back.
 *
 * For VLAM that is not a rounding error. The unified work buffer alone is
 * 72 B/slot, gathered entirely on the GPU and never read back - at a 10M-slot
 * scene that is ~720 MB of JS heap holding zeroes, next to the ~720 MB of GPU
 * memory doing the actual work. Add the sort scratch and it is most of a
 * gigabyte that no on-screen number accounts for.
 *
 * ## Why replacing `.array` is safe
 *
 * Four properties of three 0.185 hold simultaneously, and this module is only
 * correct while they all do:
 *
 * 1. `createAttribute` is guarded by `if (buffer === undefined)` - once the GPU
 *    buffer exists, every later call short-circuits without reading `.array`.
 * 2. `updateAttribute` *does* re-read `.array`, but `Attributes.update` only
 *    reaches it when `data.version < attribute.version` or the attribute uses
 *    `DynamicDrawUsage`. VLAM sets neither on the buffers released here - which
 *    is what {@link StorageMirrorReleaser}'s drift guard verifies at runtime.
 * 3. The vertex-layout paths read `.array.constructor` and
 *    `.array.BYTES_PER_ELEMENT`, never the contents - and only for *geometry*
 *    attributes, which these are not. Both survive a zero-length array of the
 *    same constructor.
 * 4. Device loss is terminal: `Renderer._onDeviceLost` sets a flag and every
 *    later render/compute returns early. There is no re-upload-from-`.array`
 *    path to break.
 *
 * A zero-length array rather than a detached buffer, deliberately: if a future
 * change ever does bump `version` on a released attribute, a zero-length array
 * degrades to a legal 0-byte `writeBuffer` (silent, and caught by the drift
 * guard) where a detached one would throw inside the render loop.
 *
 * Peak memory is unchanged - the array has to exist for the upload copy. Only
 * steady state improves, which is the number that was hurting.
 *
 * ## Relationship to `releaseRendererAttributes`
 *
 * They are complements, and compose in either order.
 * `releaseRendererAttributes` frees the **GPU** buffer at dispose; this frees
 * the **CPU** mirror during the first frame. If dispose somehow ran first, the
 * upload probe simply reports "not uploaded" and the mirror is never released -
 * fail-safe.
 *
 * Upstream fix: a one-line `bufferAttribute.onUploadCallback()` in
 * `WebGPUAttributeUtils.createAttribute` would make the documented
 * `BufferAttribute.onUpload()` contract work on WebGPU, and this module would
 * become a shim for older three.
 */
import type * as THREE from 'three/webgpu';

import { warn } from './logging';

/** The internal shape this module probes for; absent on WebGL2 and in test doubles. */
interface AttributeBackend {
  isWebGPUBackend?: boolean;
  has?(object: object): boolean;
  get?(object: object): { buffer?: unknown };
}

/**
 * Whether three has already created this attribute's GPU buffer.
 *
 * `has` before `get` is not optional: the backend's `DataMap.get` *creates* an
 * empty record on a miss, so probing with `get` alone would both pollute the
 * map and always report "uploaded".
 */
function hasUploaded(renderer: THREE.WebGPURenderer, attribute: THREE.BufferAttribute): boolean {
  const backend = (renderer as unknown as { backend?: AttributeBackend }).backend;
  if (!backend || backend.isWebGPUBackend !== true) return false;
  if (typeof backend.has !== 'function' || typeof backend.get !== 'function') return false;
  if (!backend.has(attribute)) return false;
  return backend.get(attribute).buffer !== undefined;
}

/** Swaps in a zero-length array of the same type, keeping `count` intact. */
function dropMirror(attribute: THREE.BufferAttribute): number {
  const array = attribute.array;
  const bytes = array.byteLength;
  if (bytes === 0) return 0;
  const Ctor = array.constructor as new (length: number) => typeof array;
  attribute.array = new Ctor(0);
  return bytes;
}

/**
 * Drops the JS mirrors of storage attributes three has already uploaded.
 *
 * Owners construct one over the attributes they own **outright** and call
 * {@link release} after each dispatch; it settles on the first frame and costs
 * one WeakMap probe per pending attribute until then. Attributes the owner only
 * borrows (a mesh's `splatIndex`/`sourceIndex` passed into a sorter) must never
 * be handed to it - the same ownership line `releaseRendererAttributes` draws.
 *
 * Only pass attributes that are written from the CPU *at most once*, at
 * construction. Anything the CPU rewrites per frame will silently stop
 * uploading; the drift guard turns that into a warning rather than a mystery.
 */
export class StorageMirrorReleaser {
  private readonly pending: THREE.BufferAttribute[];
  /** Released attributes and the `version` they carried when released. */
  private readonly released = new Map<THREE.BufferAttribute, number>();
  private releasedBytesValue = 0;
  private warnedDrift = false;

  constructor(attributes: readonly THREE.BufferAttribute[]) {
    this.pending = [...attributes];
  }

  /** Nothing left to release. */
  get settled(): boolean {
    return this.pending.length === 0;
  }

  /** Bytes still mirrored on the JS heap. */
  get pendingBytes(): number {
    let bytes = 0;
    for (const attribute of this.pending) bytes += attribute.array.byteLength;
    return bytes;
  }

  /** Bytes freed so far. Diagnostic. */
  get releasedBytes(): number {
    return this.releasedBytesValue;
  }

  /**
   * Releases every pending mirror three has uploaded, and checks the ones
   * already released for version drift. Idempotent and cheap once settled.
   *
   * @returns Bytes freed by this call.
   */
  release(renderer: THREE.WebGPURenderer): number {
    this.checkDrift();
    if (this.pending.length === 0) return 0;
    let freed = 0;
    // Backwards so a splice cannot skip the next entry.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const attribute = this.pending[i] as THREE.BufferAttribute;
      if (!hasUploaded(renderer, attribute)) continue;
      freed += dropMirror(attribute);
      this.released.set(attribute, attribute.version);
      this.pending.splice(i, 1);
    }
    this.releasedBytesValue += freed;
    return freed;
  }

  /**
   * A released attribute whose `version` moved means someone added a CPU write
   * to a buffer this class promised was GPU-only. Three would then upload the
   * zero-length array - a legal no-op - and the data would simply never reach
   * the GPU. Warn once, so that failure is visible rather than a silent wrong
   * render.
   */
  private checkDrift(): void {
    if (this.warnedDrift || this.released.size === 0) return;
    for (const [attribute, version] of this.released) {
      if (attribute.version === version) continue;
      this.warnedDrift = true;
      warn(
        `StorageMirrorReleaser: storage attribute "${attribute.name || 'unnamed'}" was written ` +
          `from the CPU after its mirror was released; that write will not reach the GPU. ` +
          `Remove it from the releaser's attribute list.`,
      );
      return;
    }
  }
}
