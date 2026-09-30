import { Vector2 } from 'three/webgpu';

/** One press owns its samples and asynchronous classification, even for reused pointer IDs. */
export interface PaintGesture<Source, Tool> {
  readonly pointerId: number;
  readonly source: Source;
  readonly tool: Tool;
  readonly samples: Vector2[];
  released: boolean;
  classified: boolean;
}

/** Identity-based ownership for paint callbacks and pointer capture transitions. */
export class PaintGestures<Source, Tool> {
  current: PaintGesture<Source, Tool> | null = null;

  begin(
    pointerId: number,
    source: Source,
    tool: Tool,
    x: number,
    y: number,
  ): PaintGesture<Source, Tool> {
    return (this.current = {
      pointerId,
      source,
      tool,
      samples: [new Vector2(x, y)],
      released: false,
      classified: false,
    });
  }

  owns(gesture: PaintGesture<Source, Tool>): boolean {
    return this.current === gesture;
  }

  move(pointerId: number, x: number, y: number): void {
    const gesture = this.current;
    if (gesture?.pointerId === pointerId && !gesture.released)
      gesture.samples.push(new Vector2(x, y));
  }

  cancel(pointerId?: number): void {
    if (pointerId === undefined || this.current?.pointerId === pointerId) this.current = null;
  }
}
