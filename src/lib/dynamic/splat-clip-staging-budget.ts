/**
 * Bytes of upcoming sections the GPU path stages per rendered frame by
 * default. A demo section is 12 to 24 MB, staged while the shown one plays
 * (~1.1 s). Four demo clips need ~120 MB/s: 4 MB per frame keeps them on
 * schedule (1.5 MB lets them stall at section ends), and halves the worst
 * frame against staging a section at once.
 */
const DEFAULT_BYTES_PER_FRAME = 4 * 1024 * 1024;

/** @internal What a budget asks of a member when the frame's budget is handed out. */
export interface SplatClipStager {
  /** Uploads up to `budget` bytes; returns the bytes used. */
  stageWithin(budget: number): number;
}

/**
 * One upload budget per rendered frame for the GPU path's section staging,
 * shared by several `SplatClipMesh`es so their section ends (which tend to
 * coincide) do not burst the upload path together.
 *
 * Each mesh's `update` queues it for staging; once a mesh updates again,
 * the previous frame's queue is served from one budget, starting with a
 * different mesh every frame so none starves. A mesh without an explicit
 * budget gets a private one with the default size.
 *
 * @example
 * ```ts
 * const staging = new SplatClipStagingBudget(); // 4 MB per frame
 * const meshes = clips.map((clip) => new SplatClipMesh(clip, { renderer, staging }));
 * ```
 *
 * @experimental The API may change in a minor release.
 */
export class SplatClipStagingBudget {
  /** Bytes handed out per rendered frame. */
  readonly bytesPerFrame: number;
  /** Members queued during the current frame, in update order. */
  private queued: SplatClipStager[] = [];
  private turn = 0;

  constructor(bytesPerFrame = DEFAULT_BYTES_PER_FRAME) {
    if (!(bytesPerFrame >= 0)) {
      throw new RangeError('SplatClipStagingBudget: bytesPerFrame must be zero or positive.');
    }
    this.bytesPerFrame = bytesPerFrame;
  }

  /**
   * Queues `member` for the current frame. A member already queued marks the
   * next frame: the queue is served first (round-robin start), then cleared.
   *
   * @internal
   */
  request(member: SplatClipStager): void {
    if (this.queued.includes(member)) this.flush();
    this.queued.push(member);
  }

  /**
   * Drops a member (a disposed mesh) from the queue.
   *
   * @internal
   */
  remove(member: SplatClipStager): void {
    this.queued = this.queued.filter((queued) => queued !== member);
  }

  /** Hands one frame's budget to the queued members, starting at a rotating one. */
  private flush(): void {
    const members = this.queued;
    this.queued = [];
    if (members.length === 0) return;
    let budget = this.bytesPerFrame;
    const first = this.turn % members.length;
    this.turn++;
    for (let step = 0; step < members.length && budget > 0; step++) {
      budget -= members[(first + step) % members.length]!.stageWithin(budget);
    }
  }
}
