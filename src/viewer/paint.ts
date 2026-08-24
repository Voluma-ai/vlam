import * as THREE from 'three/webgpu';
import { abs, float, mix, step, uniformArray, vec4 } from 'three/tsl';
import type { SplatData, SplatMesh, SplatModifier, SplatRange } from '../lib';

/**
 * Interactive paint demo (`?effects=paint`) for per-splat channels (M7.3).
 *
 * A byte channel `'mask'` stores a palette index per splat (0 = unpainted,
 * 1..N = a color slot). Painting writes the current brush index; the color
 * picker only changes which slot new strokes use, so already-painted areas
 * keep their color. The palette lives in a uniform array - swapping the brush
 * never rebuilds the material.
 */
export interface PaintTool {
  /** Paints a spherical brush (world radius) around a picked world point. */
  paintAt(worldPoint: THREE.Vector3, radius: number): void;
  /** Clears the whole mask back to zero. */
  clear(): void;
}

interface Chunk {
  readonly range: SplatRange;
  readonly data: SplatData;
  /** Palette index per splat in this chunk (0 = unpainted). */
  readonly mask: Uint8Array;
}

/** Max distinct brush colors in one session (channel stores 1..MAX). */
const MAX_PALETTE = 16;

/** Default saturated magenta; mixed in only partway so splat shading still shows. */
const DEFAULT_HIGHLIGHT = new THREE.Vector3(1.0, 0.12, 0.9);

/** How far a painted splat pulls RGB toward its palette color (0–1). */
const TINT_STRENGTH = 0.55;

const paletteSlots: THREE.Vector3[] = [];
for (let i = 0; i < MAX_PALETTE; i++) {
  paletteSlots.push(i === 0 ? DEFAULT_HIGHLIGHT.clone() : new THREE.Vector3(1, 1, 1));
}
const paletteUniform = uniformArray(paletteSlots, 'vec3');

/** Number of palette slots that have been assigned a brush color. */
let paletteCount = 1;
/** 1-based channel index written by new paint strokes. */
let brushIndex = 1;

function asNode<T extends string>(node: unknown): THREE.Node<T> {
  return node as THREE.Node<T>;
}

/** Current brush palette index (1..{@link MAX_PALETTE}) for {@link paintAt} writes. */
export function getPaintBrushIndex(): number {
  return brushIndex;
}

/** Sets the brush color from a CSS hex (`#rrggbb`). Already-painted splats are unchanged. */
export function setPaintHighlightColor(hex: string): void {
  const c = new THREE.Color(hex);
  const rgb = new THREE.Vector3(c.r, c.g, c.b);
  for (let i = 0; i < paletteCount; i++) {
    const slot = paletteSlots[i] as THREE.Vector3;
    if (slot.distanceToSquared(rgb) < 1e-8) {
      brushIndex = i + 1;
      return;
    }
  }
  if (paletteCount < MAX_PALETTE) {
    (paletteSlots[paletteCount] as THREE.Vector3).copy(rgb);
    paletteCount++;
    brushIndex = paletteCount;
    return;
  }
  // Cap hit: reuse the last slot for further new colors (old strokes keep theirs
  // only if they used an earlier index - last-slot strokes will retint together).
  (paletteSlots[MAX_PALETTE - 1] as THREE.Vector3).copy(rgb);
  brushIndex = MAX_PALETTE;
}

/** Current brush color as a CSS hex (`#rrggbb`). */
export function getPaintHighlightColorHex(): string {
  const v = paletteSlots[brushIndex - 1] as THREE.Vector3;
  return `#${new THREE.Color(v.x, v.y, v.z).getHexString()}`;
}

/**
 * A {@link SplatModifier} that tints splats by a byte palette-index channel:
 * 0 leaves the splat untouched; 1..N mixes toward that slot's color. Shared by
 * the static and streamed paint paths.
 */
export function createMaskHighlightModifier(channelName = 'mask'): SplatModifier {
  return (ctx) => {
    const idx = ctx.channel(channelName).mul(255);
    let rgb: THREE.Node<'vec3'> = asNode(ctx.color.rgb);
    // Fixed unroll: dynamic indexing through a varying-bound color path is
    // unreliable, so each palette slot is gated by an exact index match.
    for (let k = 0; k < MAX_PALETTE; k++) {
      const slotIndex = k + 1;
      const gate = float(1).sub(step(0.5, abs(idx.sub(slotIndex))));
      const tint = asNode<'vec3'>(paletteUniform.element(k));
      rgb = asNode(mix(rgb, tint, gate.mul(TINT_STRENGTH)));
    }
    return { color: vec4(rgb, ctx.color.a) };
  };
}

/**
 * Wires a paint tool onto a mesh whose content was appended as the given
 * chunks (each with its own {@link SplatRange} handle and source data). Sets
 * the highlight modifier as the mesh's sole modifier.
 */
export function createPaintTool(
  mesh: SplatMesh,
  chunks: { range: SplatRange; data: SplatData }[],
): PaintTool {
  mesh.defineChannel('mask', { type: 'byte' });

  const painted: Chunk[] = chunks.map(({ range, data }) => ({
    range,
    data,
    mask: new Uint8Array(data.count),
  }));

  mesh.modifiers = [createMaskHighlightModifier('mask')];

  const local = new THREE.Vector3();

  return {
    paintAt(worldPoint, radius): void {
      const r2 = radius * radius;
      const index = getPaintBrushIndex();
      local.copy(worldPoint);
      mesh.worldToLocal(local); // brush center in the same space as positions

      for (const chunk of painted) {
        const { positions } = chunk.data;
        let changed = false;
        for (let i = 0; i < chunk.data.count; i++) {
          if ((chunk.mask[i] as number) !== 0) continue; // keep first color
          const dx = (positions[i * 3 + 0] as number) - local.x;
          const dy = (positions[i * 3 + 1] as number) - local.y;
          const dz = (positions[i * 3 + 2] as number) - local.z;
          if (dx * dx + dy * dy + dz * dz <= r2) {
            chunk.mask[i] = index;
            changed = true;
          }
        }
        if (changed) mesh.writeChannel(chunk.range, 'mask', chunk.mask);
      }
    },
    clear(): void {
      for (const chunk of painted) {
        chunk.mask.fill(0);
        mesh.writeChannel(chunk.range, 'mask', chunk.mask);
      }
    },
  };
}
