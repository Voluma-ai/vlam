import { afterEach, describe, expect, it, vi } from 'vitest';
import { vec4 } from 'three/tsl';
import { SplatMesh } from '../splat-mesh';
import { ModifierSlots } from '../splat-modifier';
import type { SplatModifier } from '../splat-modifier';
import { sdfEffects, depthOfFieldPreset } from '../effects';

const WIDTH = 2048; // SplatMesh.DATA_TEXTURE_WIDTH

/** Reads the mesh's private graph revision - the rebuild counter the unified
 * renderer keys pipeline rebuilds on. */
function graphRevision(mesh: SplatMesh): number {
  return (mesh as unknown as { graphRevision: number }).graphRevision;
}

describe('ModifierSlots - rebuild vs uniform-update contract (E5)', () => {
  const meshes: SplatMesh[] = [];
  afterEach(() => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
    vi.restoreAllMocks();
  });

  function dynamicMesh(): SplatMesh {
    const mesh = new SplatMesh({ capacity: WIDTH });
    meshes.push(mesh);
    return mesh;
  }

  const tint: SplatModifier = (ctx) => ({ color: vec4(ctx.color.rgb.mul(0.5), ctx.color.a) });
  const fade: SplatModifier = (ctx) => ({ color: vec4(ctx.color.rgb, ctx.color.a.mul(0.5)) });

  it('rejects an empty or duplicated slot order and unknown slot names', () => {
    expect(() => new ModifierSlots([])).toThrow(/at least one slot/);
    expect(() => new ModifierSlots(['a', 'a'])).toThrow(/duplicate/);
    const slots = new ModifierSlots(['reveal', 'sdf']);
    expect(() => slots.set('lighting', tint)).toThrow(/unknown slot "lighting"/);
  });

  it('empty slots are omitted entirely - no passthrough, unhooked graph', () => {
    const slots = new ModifierSlots(['reveal', 'sdf', 'lighting', 'fog', 'opacity']);
    const mesh = dynamicMesh();
    const before = graphRevision(mesh);
    slots.apply(mesh);
    // All slots empty ⇒ zero modifiers ⇒ the mesh keeps the unhooked graph
    // (this also keeps the unified renderer's zero-modifier fast path).
    expect(mesh.modifiers).toHaveLength(0);
    expect(graphRevision(mesh)).toBe(before);
    // One occupied slot out of five compiles exactly one modifier.
    slots.set('sdf', tint);
    slots.apply(mesh);
    expect(mesh.modifiers).toEqual([tint]);
  });

  it('compacts in slot order regardless of set order', () => {
    const slots = new ModifierSlots(['reveal', 'sdf', 'opacity']);
    slots.set('opacity', fade);
    slots.set('reveal', tint);
    expect(slots.modifiers).toEqual([tint, fade]);
    expect(slots.get('sdf')).toBeNull();
  });

  it('filling a slot rebuilds once; re-applying unchanged occupancy never rebuilds', () => {
    const mesh = dynamicMesh();
    const build = vi.spyOn(
      mesh as unknown as { buildMaterial: (...a: unknown[]) => void },
      'buildMaterial',
    );
    const slots = new ModifierSlots(['reveal', 'sdf']);
    expect(slots.set('reveal', tint)).toBe(true);
    slots.apply(mesh);
    const revAfterSet = graphRevision(mesh);
    expect(build).toHaveBeenCalledTimes(1);

    // Same-value set is a declared no-op…
    expect(slots.set('reveal', tint)).toBe(false);
    // …and re-applying (as a host might every frame) is free: same array
    // reference, mesh identity diff short-circuits, no rebuild, no bump.
    const ref = slots.modifiers;
    slots.apply(mesh);
    slots.apply(mesh);
    expect(slots.modifiers).toBe(ref);
    expect(build).toHaveBeenCalledTimes(1);
    expect(graphRevision(mesh)).toBe(revAfterSet);
  });

  it('uniform-value changes go through with zero rebuilds', () => {
    const mesh = dynamicMesh();
    const slots = new ModifierSlots(['sdf', 'dof']);
    const fx = sdfEffects([{ kind: 'sphere', radius: 1, mode: 'tint' }]);
    const dof = depthOfFieldPreset();
    slots.set('sdf', fx.modifier);
    slots.set('dof', dof.modifier);
    slots.apply(mesh);
    const rev = graphRevision(mesh);
    const build = vi.spyOn(
      mesh as unknown as { buildMaterial: (...a: unknown[]) => void },
      'buildMaterial',
    );
    // Animate values every "frame": shapes, focus - data-only by contract.
    for (let frame = 0; frame < 3; frame++) {
      fx.setShapes([{ kind: 'sphere', radius: 1 + frame, mode: 'tint' }]);
      dof.focusDistance.value = 5 + frame;
      slots.apply(mesh);
    }
    expect(build).not.toHaveBeenCalled();
    expect(graphRevision(mesh)).toBe(rev);
  });

  it('replacing a slot with a different function rebuilds exactly once', () => {
    const mesh = dynamicMesh();
    const slots = new ModifierSlots(['reveal']);
    slots.set('reveal', tint);
    slots.apply(mesh);
    const rev = graphRevision(mesh);
    expect(slots.set('reveal', fade)).toBe(true);
    slots.apply(mesh);
    expect(graphRevision(mesh)).toBe(rev + 1);
    expect(mesh.modifiers).toEqual([fade]);
  });

  it('clearing a slot rebuilds once; clearing an empty slot is a no-op', () => {
    const mesh = dynamicMesh();
    const slots = new ModifierSlots(['reveal', 'sdf']);
    slots.set('reveal', tint);
    slots.apply(mesh);
    const rev = graphRevision(mesh);
    expect(slots.clear('reveal')).toBe(true);
    slots.apply(mesh);
    expect(graphRevision(mesh)).toBe(rev + 1);
    expect(mesh.modifiers).toHaveLength(0);
    expect(slots.clear('reveal')).toBe(false);
    expect(slots.clear('sdf')).toBe(false);
    slots.apply(mesh);
    expect(graphRevision(mesh)).toBe(rev + 1);
  });

  it('a slot whose modifier fails to build rolls the mesh back, slots stay editable', () => {
    const mesh = dynamicMesh();
    const slots = new ModifierSlots(['reveal', 'mask']);
    slots.set('reveal', tint);
    slots.apply(mesh);
    const rev = graphRevision(mesh);
    const readsMissingChannel: SplatModifier = (ctx) => ({
      color: vec4(ctx.color.rgb, ctx.color.a.mul(ctx.channel('mask'))),
    });
    slots.set('mask', readsMissingChannel);
    expect(() => slots.apply(mesh)).toThrow(/channel "mask"/);
    // Mesh rolled back to the previous compiled stack, revision untouched.
    expect(mesh.modifiers).toEqual([tint]);
    expect(graphRevision(mesh)).toBe(rev);
    // Fix the cause and re-apply - the same list must now compile.
    mesh.defineChannel('mask', { type: 'byte' });
    slots.apply(mesh);
    expect(mesh.modifiers).toEqual([tint, readsMissingChannel]);
    expect(graphRevision(mesh)).toBe(rev + 1);
  });
});
